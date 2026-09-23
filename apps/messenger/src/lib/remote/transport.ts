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
import type { SyncFrame as ProtocolSyncFrame,
  StreamFrame,
  ToolFrame,
} from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { FileProgressHandler } from "../file-progress.ts";
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
  onProgress?: FileProgressHandler;
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

/**
 * A phone that changes network, or sleeps with the screen off, can be left holding a socket the
 * browser still calls open: no close, no error, just a link that carries nothing. Silence is the
 * only evidence there is, so it counts only against an answer that is actually outstanding, and
 * only while nothing is moving in either direction. The host caps a model probe at twelve
 * seconds and streams a turn's events as they happen, so half a minute of nothing is the link.
 */
const STALL_MS = 30_000;
const STALL_CHECK_MS = 5000;

export class RemoteTransport {
  private socket: WebSocket | null = null;
  private session: DeviceSession | null = null;
  private assembler = new Reassembler();
  private waiter: Waiter | null = null;
  private queue: Array<() => void> = [];
  private closed = false;
  private events: Array<(frame: ProtocolSyncFrame | StreamFrame | ToolFrame) => void> = [];
  /**
   * Called once when the link ends on its own — the relay closing it, the Mac going away, a
   * radio that stopped carrying bytes. {@link close} is the owner letting go and reports nothing.
   */
  ondrop: (() => void) | null = null;
  private lastFrameAt = 0;
  /** When the outstanding answer was asked for. A link idle all morning is not a late answer. */
  private waitingSince = 0;
  private lastBuffered = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  readyFrame: RemoteReady | null = null;
  constructor(
    readonly enrollment: StoredEnrollment,
    private readonly identity: IdentitySecrets,
    private readonly hooks: TransportHooks = {},
  ) {}

  /** Type 3 also carries the ephemeral stream and tool frames, which have no cursor. */
  subscribe(listener: (frame: ProtocolSyncFrame | StreamFrame | ToolFrame) => void): () => void {
    this.events.push(listener);
    return () => {
      this.events = this.events.filter((item) => item !== listener);
    };
  }

  /** The owner is done with this link. Nothing dropped, so {@link ondrop} is not called. */
  close(): void {
    this.shutdown();
  }

  /** The link ended without being asked to. Whoever owns it hears about it once. */
  private fail(): void {
    if (this.closed) return;
    this.shutdown();
    const ondrop = this.ondrop;
    this.ondrop = null;
    ondrop?.();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
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

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /**
   * A handshake that dies halfway still holds this device's one route at the relay, and the relay
   * refuses a second route for the same device — so an attempt that gives up must let go of the
   * socket, or every retry after it is refused by the link the page already abandoned.
   */
  async connect(): Promise<RemoteReady> {
    try {
      return await this.handshake();
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }

  private async handshake(): Promise<RemoteReady> {
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
    const onHandshakeFrame = (event: MessageEvent) => {
      const value = typeof event.data === "string" ? event.data : asBytes(event.data);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else incoming.push(value);
    };
    socket.addEventListener("message", onHandshakeFrame);
    // A radio that is up but carrying nothing lets a connect sit for as long as the OS allows,
    // and the loop's next attempt is only scheduled once this one is over. Every other step of
    // the handshake is bounded; so is this one.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("remote socket timeout")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("remote socket failed"));
      }, { once: true });
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
    // The handshake's reader has to let go here. It queues whatever nobody is waiting for, and
    // after the handshake nobody ever is: every frame of a live session would be kept alive in
    // it, a 50 MiB download retained chunk by chunk on the phone that asked for the file.
    socket.removeEventListener("message", onHandshakeFrame);
    socket.onmessage = (event) => this.onFrame(asBytes(event.data));
    socket.onclose = () => this.fail();
    socket.onerror = () => this.fail();
    this.lastFrameAt = this.now();
    this.stallTimer = setInterval(() => this.checkStall(), STALL_CHECK_MS);
    while (incoming.length) this.onFrame(asBytes(incoming.shift()));
    return ready;
  }

  /**
   * Is this link still carrying anything? An answer is outstanding and nothing has come back for
   * {@link STALL_MS}; bytes still leaving the send buffer count as the link being alive, so a
   * slow upload is not mistaken for a dead radio.
   */
  private checkStall(): void {
    if (this.closed || !this.waiter) return;
    const buffered = this.socket?.bufferedAmount ?? 0;
    if (buffered !== this.lastBuffered) {
      this.lastBuffered = buffered;
      this.lastFrameAt = this.now();
      return;
    }
    if (this.now() - Math.max(this.lastFrameAt, this.waitingSince) < STALL_MS) return;
    this.fail();
  }

  rpc(
    request: RemoteRequest,
    uploads?: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>,
    onProgress?: FileProgressHandler,
  ): Promise<RemoteResponse> {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (this.closed || !this.session || !this.socket) {
          reject(new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", request.id));
          return;
        }
        this.waiter = { id: request.id, resolve, reject, onProgress };
        this.waitingSince = this.now();
        try {
          this.socket.send(new Uint8Array(this.session.send(1, canonicalBytes(request))));
          if (uploads?.length) this.waiter.uploads = uploads.map((file) => ({ ...file, streamId: 0 }));
        } catch (error) {
          this.waiter = null;
          reject(error);
          this.fail();
        }
      };
      if (this.waiter) this.queue.push(run);
      else run();
    });
  }

  private finish(response: RemoteResponse): void {
    const waiter = this.waiter;
    this.waiter = null;
    const next = this.queue.shift();
    if (next) next();
    if (!waiter || waiter.id !== response.id) {
      this.fail();
      return;
    }
    waiter.resolve(response);
  }

  private onFrame(ciphertext: Uint8Array): void {
    if (this.closed || !this.session) return;
    this.lastFrameAt = this.now();
    try {
      const frame = this.session.receive(ciphertext);
      if (frame.type === 7) {
        this.fail();
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
      this.fail();
    }
  }

  private emit(value: unknown): void {
    const frame = value as ProtocolSyncFrame | StreamFrame | ToolFrame;
    if (!frame || typeof frame !== "object") return;
    for (const listener of this.events) listener(frame);
  }

  private onFile(chunk: { streamId: number; offset: bigint; eof: boolean; chunk: Uint8Array }): void {
    const waiter = this.waiter;
    if (!waiter?.file || waiter.file.streamId !== chunk.streamId || chunk.offset !== BigInt(waiter.file.offset)) {
      this.fail();
      return;
    }
    waiter.file.chunks.push(new Uint8Array(chunk.chunk));
    waiter.file.offset += chunk.chunk.length;
    waiter.onProgress?.({
      loaded: waiter.file.offset,
      total: waiter.file.size > 0 ? waiter.file.size : null,
    });
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
      this.fail();
      return;
    }
    if (response.snapshotPage) {
      const page = response.snapshotPage;
      const state = waiter.pages ?? { transfer: page.transferId, count: page.count, chunks: [] };
      if (page.transferId !== state.transfer || page.count !== state.count || page.index !== state.chunks.length) {
        this.fail();
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
      // A file that fitted in the response is already here. Anything else names a stream whose
      // chunks arrive afterwards, and an empty file has neither.
      if (response.file.bytes !== undefined) {
        let bytes: Uint8Array;
        try { bytes = fromBase64url(response.file.bytes); }
        catch {
          this.fail();
          return;
        }
        if (bytes.length !== response.file.size) {
          this.fail();
          return;
        }
        const etag = response.headers?.etag?.replaceAll('"', "");
        if (etag && sha256Hex(bytes) !== etag) {
          waiter.reject(new ApiError(422, "invalid_args", "file hash mismatch", waiter.id));
          this.waiter = null;
          const next = this.queue.shift();
          if (next) next();
          return;
        }
        waiter.onProgress?.({ loaded: bytes.length, total: bytes.length });
        this.finish({ ...response, body: new Blob([Uint8Array.from(bytes)]) });
        return;
      }
      waiter.file = { streamId: response.file.streamId, size: response.file.size, chunks: [], offset: 0, headers: response.headers };
      waiter.onProgress?.({
        loaded: 0,
        total: response.file.size > 0 ? response.file.size : null,
      });
      if (response.file.size === 0) {
        this.finish({ ...response, body: new Blob([]) });
      }
      return;
    }
    if (response.upload?.files?.length) {
      const pending = waiter.uploads;
      if (!pending || pending.length !== response.upload.files.length) {
        this.fail();
        return;
      }
      for (let i = 0; i < pending.length; i++) {
        const declared = response.upload.files[i]!;
        const local = pending[i]!;
        if (local.filename !== declared.filename || local.size !== declared.size || local.sha256 !== declared.sha256) {
          this.fail();
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
