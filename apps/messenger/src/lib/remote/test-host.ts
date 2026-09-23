import {
  HostSession,
  base64url,
  canonicalBytes,
  encodeFileChunk,
  generateIdentity,
  identityPublic,
  parseRemoteRequest,
  type RemoteRequest,
  type RemoteResponse,
} from "@real-bot/remote";
import { deflateSync } from "fflate";
import type { StoredEnrollment } from "./idb.ts";

/**
 * One relay and one Mac, in this process: the real device handshake, real Noise, and a socket
 * that can be ended the way a network ends one. Shared so the transport and the page's connect
 * loop are checked against the same host rather than two different pretend ones.
 */
export const hostKeys = generateIdentity();
export const deviceKeys = generateIdentity();
const hostPublic = identityPublic(hostKeys);
const hostId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const deviceId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const relayOrigin = "https://relay.example.test";
export const enrollment: StoredEnrollment = {
  v: 1,
  deviceId,
  hostId,
  relayOrigin,
  relayId: "fixture",
  trustEpoch: 1,
  hostDhPublic: base64url(hostPublic.dh),
  hostSigningPublic: base64url(hostPublic.signing),
  dh: base64url(deviceKeys.dh),
  signing: base64url(deviceKeys.signing),
  enrollment: base64url(deviceKeys.enrollment),
  name: "Fixture",
};
const binding = { hostId, deviceId, trustEpoch: 1, protocolVersion: 1, relayOrigin };
const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

/**
 * A socket that reports what the page did to it. The distinction the transport now rests on is
 * here: `drop` is the relay, the Mac or the radio ending the link, `close` is the page letting
 * go — and a browser fires the same close event for both, which is why `closedByPage` exists.
 */
export class FakeSocket {
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  closedByPage = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<{ fn: (event: Event) => void; once: boolean }>>();
  constructor(private readonly outbound: (data: string | Uint8Array, socket: FakeSocket) => void) {
    queueMicrotask(() => this.fire(new Event("open")));
  }
  addEventListener(type: string, fn: (event: never) => void, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn: fn as (event: Event) => void, once: options?.once === true });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: never) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((row) => row.fn !== fn));
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
  send(data: string | Uint8Array): void {
    this.outbound(data, this);
  }
  close(): void {
    this.closedByPage = true;
    queueMicrotask(() => this.drop());
  }
  /** What the network does without asking. */
  drop(): void {
    this.onclose?.();
    this.fire(new Event("close"));
  }
  deliver(data: string | Uint8Array): void {
    const event = new MessageEvent("message", { data });
    this.onmessage?.(event);
    this.fire(event);
  }
  private fire(event: Event): void {
    for (const row of [...(this.listeners.get(event.type) ?? [])]) {
      if (row.once) this.removeEventListener(event.type, row.fn as (event: never) => void);
      row.fn(event);
    }
  }
}

/** The relay's text handshake and a real host session behind it. */
export function fakeHost(options: {
  mode?: string;
  answer?: (request: RemoteRequest) => RemoteResponse | null;
  /** The event cursor the ready frame reports; a Mac that restarted has another instance. */
  ready?: { event_instance_id?: string; watermark_seq?: number };
} = {}) {
  const host = new HostSession({
    binding,
    identity: hostKeys,
    peer: identityPublic(deviceKeys),
    isTrusted: () => true,
    claimReplay: () => true,
    recentRttMs: 50,
  });
  let split = false;
  /** What the page asked for, in the order the host heard it; and which streams it stopped. */
  const requests: RemoteRequest[] = [];
  const cancels: number[] = [];
  const socket = new FakeSocket((data, sock) => {
    if (typeof data === "string") {
      const message = JSON.parse(data) as { type: string; nonce_c?: string };
      if (message.type === "hello") {
        sock.deliver(JSON.stringify({
          role: "device", id: deviceId, nonce_c: message.nonce_c,
          nonce_s: base64url(new Uint8Array(16).fill(7)),
          ts: Math.floor(Date.now() / 1000), relay_id: "fixture",
        }));
      } else if (message.type === "proof") {
        sock.deliver(JSON.stringify({ type: "ok", mode: options.mode ?? "link", route_id: "route", device_id: deviceId }));
      }
      return;
    }
    if (!split) {
      split = true;
      sock.deliver(host.accept(data));
      sock.deliver(host.send(3, canonicalBytes({
        type: "ready", protocol: "remote-v1", event_instance_id: options.ready?.event_instance_id ?? "a".repeat(32),
        watermark_seq: options.ready?.watermark_seq ?? 0, deviceId, trustEpoch: 1,
      })));
      return;
    }
    const frame = host.receive(data);
    if (frame.type === 6) {
      cancels.push(new DataView(frame.body.buffer, frame.body.byteOffset, 4).getUint32(0));
      return;
    }
    const request = parseRemoteRequest(frame.body);
    // Every link opens by asking what the Mac can compress. Unless a test answers it, this Mac is
    // an older one that does not know the route, and the ask stays out of `requests`.
    if (request.path === "/remote/features") {
      const answered = options.answer?.(request);
      sock.deliver(host.send(2, canonicalBytes(answered ?? {
        v: 1, id: request.id, status: 404, body: { error: { code: "not_found", message: "unknown remote route" } },
      })));
      return;
    }
    requests.push(request);
    const response = options.answer?.(request);
    if (response) sock.deliver(host.send(2, canonicalBytes(response)));
  });
  const streamFrame = (streamId: number) => {
    const body = new Uint8Array(4);
    new DataView(body.buffer).setUint32(0, streamId);
    return body;
  };
  return {
    socket,
    host,
    requests,
    cancels,
    event: (payload: unknown) => socket.deliver(host.send(3, canonicalBytes(payload))),
    /** An answer the test sends when it chooses, rather than the moment the request lands. */
    respond: (response: RemoteResponse) => socket.deliver(host.send(2, canonicalBytes(response))),
    /** The same, deflated behind the 0x00 marker, as a Mac sends it once a device asked. */
    respondPacked: (response: RemoteResponse) => {
      const packed = deflateSync(canonicalBytes(response));
      const body = new Uint8Array(packed.length + 1);
      body.set(packed, 1);
      socket.deliver(host.send(2, body));
    },
    chunk: (streamId: number, offset: number, bytes: Uint8Array, eof: boolean) =>
      socket.deliver(host.send(5, encodeFileChunk({ streamId, offset: BigInt(offset), eof, chunk: bytes }))),
    /** The host confirming a stream is over: the answer to a cancel, or its own giving up. */
    streamEnded: (streamId: number) => socket.deliver(host.send(6, streamFrame(streamId))),
  };
}


/**
 * What `new WebSocket(url)` builds while a test runs: a fresh relay and Mac each time, so a page
 * that reconnects is answered by a second link rather than the one it lost.
 */
export function serveRemote(
  options: {
    mode?: string;
    answer?: (request: RemoteRequest) => RemoteResponse | null;
    /** The ready cursor of the nth link, counting from 0. */
    ready?: (link: number) => { event_instance_id?: string; watermark_seq?: number };
  } = {},
): { sockets: FakeSocket[]; hosts: ReturnType<typeof fakeHost>[]; restore: () => void } {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  globalThis.WebSocket = class {
    constructor(_url: string) {
      const relay = fakeHost({ mode: options.mode, answer: options.answer, ready: options.ready?.(sockets.length) });
      sockets.push(relay.socket);
      hosts.push(relay);
      return relay.socket as never;
    }
  } as never;
  return { sockets, hosts, restore: () => { globalThis.WebSocket = original; } };
}
