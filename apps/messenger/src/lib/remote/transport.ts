import {
  DeviceSession,
  MAX_FILE_CHUNK,
  PAIR_MAILBOX_CONTRACT,
  Reassembler,
  base64url,
  canonicalBytes,
  canonicalize,
  decodeFileChunk,
  encodeFileChunk,
  fromBase64url,
  randomBytes,
  sha256Hex,
  signEnrollmentProof,
  type EnrollmentChallenge,
  type IdentitySecrets,
  type RemoteReady,
  type RemoteRequest,
  type RemoteResponse,
} from "@real-bot/remote";
import type { SyncFrame as ProtocolSyncFrame } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { StoredEnrollment } from "./idb.ts";

export type TransportHooks = {
  fetch?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  httpOrigin?: string;
  now?: () => number;
};

type Waiter = {
  id: string;
  resolve: (value: RemoteResponse) => void;
  reject: (error: unknown) => void;
  file?: { streamId: number; size: number; chunks: Uint8Array[]; offset: number; headers?: RemoteResponse["headers"] };
  pages?: { transfer: string; count: number; chunks: Uint8Array[] };
  uploads?: Array<{ streamId: number; filename: string; size: number; sha256: string; bytes: Uint8Array }>;
};

function httpOrigin(enrollment: StoredEnrollment, hooks: TransportHooks): string {
  return hooks.httpOrigin ?? enrollment.relayOrigin;
}

function wsOrigin(http: string): string {
  return http.replace(/^http/, "ws");
}

function asBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("invalid frame");
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class RemoteTransport {
  private socket: WebSocket | null = null;
  private session: DeviceSession | null = null;
  private assembler = new Reassembler();
  private waiter: Waiter | null = null;
  private queue: Array<() => void> = [];
  private closed = false;
  private events: Array<(frame: ProtocolSyncFrame) => void> = [];
  readyFrame: RemoteReady | null = null;
  constructor(
    readonly enrollment: StoredEnrollment,
    private readonly identity: IdentitySecrets,
    private readonly hooks: TransportHooks = {},
  ) {}

  subscribe(listener: (frame: ProtocolSyncFrame) => void): () => void {
    this.events.push(listener);
    return () => {
      this.events = this.events.filter((item) => item !== listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.assembler.clear();
    this.session?.close();
    this.session = null;
    this.socket?.close();
    this.socket = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", waiter.id));
    this.queue.length = 0;
  }

  async connect(): Promise<RemoteReady> {
    const origin = httpOrigin(this.enrollment, this.hooks);
    const socket = this.hooks.socketFactory
      ? this.hooks.socketFactory(`${wsOrigin(origin)}/v1/relay/device`)
      : new WebSocket(`${wsOrigin(origin)}/v1/relay/device`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const incoming: Array<string | Uint8Array> = [];
    const waiters: Array<(value: string | Uint8Array) => void> = [];
    const next = () =>
      new Promise<string | Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("remote handshake timeout")), 10_000);
        const take = (value: string | Uint8Array) => {
          clearTimeout(timer);
          resolve(value);
        };
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("remote handshake failed"));
        }, { once: true });
        if (incoming.length) {
          take(incoming.shift()!);
          return;
        }
        waiters.push(take);
      });
    socket.addEventListener("message", (event) => {
      const value = typeof event.data === "string" ? event.data : asBytes(event.data);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else incoming.push(value);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("remote socket failed")), { once: true });
    });
    socket.send(canonicalize({ type: "hello", id: this.enrollment.deviceId, nonce_c: base64url(randomBytes(16)) }));
    const challenge = JSON.parse(String(await next())) as EnrollmentChallenge;
    socket.send(canonicalize({ type: "proof", signature: signEnrollmentProof(challenge, this.identity.enrollment) }));
    const ok = JSON.parse(String(await next())) as { mode?: string };
    if (ok.mode !== "link") throw new Error("relay did not attach a host link");
    const session = new DeviceSession({
      identity: this.identity,
      peer: { dh: fromBase64url(this.enrollment.hostDhPublic, 32), signing: fromBase64url(this.enrollment.hostSigningPublic, 32) },
      binding: {
        hostId: this.enrollment.hostId,
        deviceId: this.enrollment.deviceId,
        trustEpoch: this.enrollment.trustEpoch,
        protocolVersion: 1,
        relayOrigin: this.enrollment.relayOrigin,
      },
    });
    socket.send(new Uint8Array(session.start()));
    session.accept(asBytes(await next()));
    this.session = session;
    const readyBytes = session.receive(asBytes(await next())).body;
    const ready = parseJson(readyBytes) as RemoteReady;
    if (ready.type !== "ready" || ready.protocol !== "remote-v1") throw new Error("invalid remote ready");
    this.readyFrame = ready;
    socket.onmessage = (event) => this.onFrame(asBytes(event.data));
    socket.onclose = () => this.close();
    socket.onerror = () => this.close();
    while (incoming.length) this.onFrame(asBytes(incoming.shift()));
    return ready;
  }

  rpc(request: RemoteRequest, uploads?: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>): Promise<RemoteResponse> {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (this.closed || !this.session || !this.socket) {
          reject(new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", request.id));
          return;
        }
        this.waiter = { id: request.id, resolve, reject };
        try {
          this.socket.send(new Uint8Array(this.session.send(1, canonicalBytes(request))));
          if (uploads?.length) this.waiter.uploads = uploads.map((file) => ({ ...file, streamId: 0 }));
        } catch (error) {
          this.waiter = null;
          reject(error);
          this.close();
        }
      };
      if (this.waiter) this.queue.push(run);
      else run();
    });
  }

  cancelStream(streamId: number): void {
    if (this.closed || !this.session || !this.socket) return;
    const body = new Uint8Array(4);
    new DataView(body.buffer).setUint32(0, streamId);
    this.socket.send(new Uint8Array(this.session.send(6, body)));
  }

  private finish(response: RemoteResponse): void {
    const waiter = this.waiter;
    this.waiter = null;
    const next = this.queue.shift();
    if (next) next();
    if (!waiter || waiter.id !== response.id) {
      this.close();
      return;
    }
    waiter.resolve(response);
  }

  private onFrame(ciphertext: Uint8Array): void {
    if (this.closed || !this.session) return;
    try {
      const frame = this.session.receive(ciphertext);
      if (frame.type === 7) {
        this.close();
        return;
      }
      if (frame.type === 6) {
        const id = new DataView(frame.body.buffer, frame.body.byteOffset, 4).getUint32(0);
        const waiter = this.waiter;
        if (waiter?.file?.streamId === id) {
          waiter.reject(new ApiError(409, "cancelled", "download cancelled", waiter.id));
          this.waiter = null;
          const next = this.queue.shift();
          if (next) next();
        }
        return;
      }
      if (frame.type === 5) {
        this.onFile(decodeFileChunk(frame.body));
        return;
      }
      const logical = frame.type === 4 ? this.assembler.accept(frame.body, performance.now()) : { type: frame.type, body: frame.body };
      if (!logical) return;
      if (logical.type === 3) {
        this.emit(parseJson(logical.body));
        return;
      }
      if (logical.type !== 2 && logical.type !== 8) throw new Error("unexpected remote type");
      this.onResponse(parseJson(logical.body) as RemoteResponse);
    } catch {
      this.close();
    }
  }

  private emit(value: unknown): void {
    const frame = value as ProtocolSyncFrame;
    if (!frame || typeof frame !== "object") return;
    for (const listener of this.events) listener(frame);
  }

  private onFile(chunk: { streamId: number; offset: bigint; eof: boolean; chunk: Uint8Array }): void {
    const waiter = this.waiter;
    if (!waiter?.file || waiter.file.streamId !== chunk.streamId || chunk.offset !== BigInt(waiter.file.offset)) {
      this.close();
      return;
    }
    waiter.file.chunks.push(new Uint8Array(chunk.chunk));
    waiter.file.offset += chunk.chunk.length;
    if (chunk.eof) {
      const bytes = concat(waiter.file.chunks);
      const etag = waiter.file.headers?.etag?.replaceAll('"', "");
      if (etag && sha256Hex(bytes) !== etag) {
        waiter.reject(new ApiError(422, "invalid_args", "file hash mismatch", waiter.id));
        this.waiter = null;
        const next = this.queue.shift();
        if (next) next();
        return;
      }
      this.finish({
        v: 1,
        id: waiter.id,
        status: 200,
        body: new Blob([Uint8Array.from(bytes)]),
        headers: waiter.file.headers,
        file: { streamId: chunk.streamId, size: bytes.length },
      });
    }
  }

  private onResponse(response: RemoteResponse): void {
    const waiter = this.waiter;
    if (!waiter || waiter.id !== response.id) {
      this.close();
      return;
    }
    if (response.snapshotPage) {
      const page = response.snapshotPage;
      const state = waiter.pages ?? { transfer: page.transferId, count: page.count, chunks: [] };
      if (page.transferId !== state.transfer || page.count !== state.count || page.index !== state.chunks.length) {
        this.close();
        return;
      }
      state.chunks.push(fromBase64url(page.bytes));
      waiter.pages = state;
      if (state.chunks.length < state.count) return;
      waiter.pages = undefined;
      this.finish({ ...response, body: JSON.parse(new TextDecoder().decode(concat(state.chunks))), snapshotPage: undefined });
      return;
    }
    if (response.file) {
      waiter.file = { streamId: response.file.streamId, size: response.file.size, chunks: [], offset: 0, headers: response.headers };
      if (response.file.size === 0) {
        this.finish({ ...response, body: new Blob([]) });
      }
      return;
    }
    if (response.upload?.files?.length) {
      const pending = waiter.uploads;
      if (!pending || pending.length !== response.upload.files.length) {
        this.close();
        return;
      }
      for (let i = 0; i < pending.length; i++) {
        const declared = response.upload.files[i]!;
        const local = pending[i]!;
        if (local.filename !== declared.filename || local.size !== declared.size || local.sha256 !== declared.sha256) {
          this.close();
          return;
        }
        local.streamId = declared.streamId;
        if (local.size > 0) this.sendUpload(local);
      }
      return;
    }
    this.finish(response);
  }

  private sendUpload(file: { streamId: number; bytes: Uint8Array }): void {
    if (!this.session || !this.socket || this.closed) return;
    for (let offset = 0; offset < file.bytes.length || file.bytes.length === 0; offset += MAX_FILE_CHUNK) {
      const chunk = file.bytes.subarray(offset, offset + MAX_FILE_CHUNK);
      this.socket.send(new Uint8Array(this.session.send(5, encodeFileChunk({
        streamId: file.streamId, offset: BigInt(offset), eof: offset + chunk.length === file.bytes.length, chunk,
      }))));
      if (!file.bytes.length) break;
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function mailboxSubmit(
  qr: { pairingId: string; relayOrigin: string },
  ciphertext: Uint8Array,
  hooks: TransportHooks = {},
): Promise<void> {
  const origin = hooks.httpOrigin ?? qr.relayOrigin;
  const fetchFn = hooks.fetch ?? fetch;
  const response = await fetchFn(`${origin}${PAIR_MAILBOX_CONTRACT.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: canonicalize({ op: "submit", pairing_id: qr.pairingId, ciphertext: base64url(ciphertext) }),
  });
  if (response.status !== 202) throw new ApiError(response.status, "pairing_rejected", "pairing request was not accepted");
}

export async function mailboxPoll(
  qr: { pairingId: string; relayOrigin: string },
  hooks: TransportHooks = {},
): Promise<Uint8Array | null> {
  const origin = hooks.httpOrigin ?? qr.relayOrigin;
  const fetchFn = hooks.fetch ?? fetch;
  const response = await fetchFn(`${origin}${PAIR_MAILBOX_CONTRACT.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: canonicalize({ op: "poll", pairing_id: qr.pairingId }),
  });
  if (response.status === 202) return null;
  if (response.status !== 200) throw new ApiError(response.status, "pairing_rejected", "pairing was rejected or expired");
  const body = (await response.json()) as { ciphertext?: string };
  if (typeof body.ciphertext !== "string") throw new ApiError(400, "pairing_rejected", "pairing reply missing");
  return fromBase64url(body.ciphertext);
}
