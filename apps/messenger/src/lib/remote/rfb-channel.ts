import { MAX_TUNNEL_CHUNK, TUNNEL_ACK_EVERY, TUNNEL_WINDOW, type TunnelChunk } from "@real-bot/remote";
import type { TunnelSink } from "./transport.ts";

/**
 * What noVNC drives: the shape of a WebSocket or an RTCDataChannel (`core/websock.js` checks for
 * exactly these names). Both of ours are open from the start — they are only handed over once the
 * bytes can move — so noVNC begins the RFB handshake as soon as it attaches.
 */
export interface ScreenChannel {
  binaryType: string;
  readonly protocol: string;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  /** Bytes received so far: the page shows a transfer under way with it. */
  readonly bytesIn?: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  // noVNC sends a view into a send buffer it reuses as soon as this returns: copy it now.
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(view);
}

/**
 * Holds what arrives until noVNC has attached its handler. Loading noVNC is an `await` between
 * the channel opening and the attach, and the screen starts talking the moment the channel opens.
 */
abstract class HeldChannel implements ScreenChannel {
  binaryType = "arraybuffer";
  readonly protocol = "";
  onopen: ((event: Event) => void) | null = null;
  onclose: ScreenChannel["onclose"] = null;
  onerror: ((event: Event) => void) | null = null;
  declare onmessage: ScreenChannel["onmessage"];
  declare readonly readyState: ScreenChannel["readyState"];
  #onmessage: ScreenChannel["onmessage"] = null;
  #held: Uint8Array[] = [];
  bytesIn = 0;
  protected state: ScreenChannel["readyState"] = "open";

  constructor() {
    // Own, enumerable properties: noVNC looks for these names on the object or its own prototype,
    // never further up the chain.
    Object.defineProperty(this, "readyState", { enumerable: true, get: () => this.state });
    Object.defineProperty(this, "onmessage", {
      enumerable: true,
      get: () => this.#onmessage,
      set: (handler: ScreenChannel["onmessage"]) => {
        this.#onmessage = handler;
        if (handler && this.#held.length) queueMicrotask(() => this.release());
      },
    });
  }

  abstract send(data: ArrayBuffer | ArrayBufferView): void;
  abstract close(): void;

  protected deliver(bytes: Uint8Array): void {
    this.bytesIn += bytes.length;
    this.#held.push(bytes);
    if (this.#onmessage) this.release();
  }

  /** Bytes noVNC has now been handed; the relayed channel acknowledges them. */
  protected consumed(_bytes: number): void {}

  private release(): void {
    const handler = this.#onmessage;
    if (!handler) return;
    while (this.#held.length) {
      const bytes = this.#held.shift()!;
      handler({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
      this.consumed(bytes.length);
    }
  }

  /**
   * Closed now; told a task later, the way a socket's close event always arrives. noVNC closes the
   * channel from inside its own disconnect and arms a timeout just after: a close reported in the
   * same call would land before the timer exists, and it would fire three seconds later anyway.
   */
  protected ended(clean = true): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.#held.length = 0;
    setTimeout(() => this.onclose?.({ code: clean ? 1000 : 1006, reason: "", wasClean: clean }), 0);
  }
}

/** The link a relayed channel rides on; {@link RemoteTransport} is one. */
export interface TunnelLink {
  openTunnel(id: number, sink: TunnelSink): void;
  closeTunnel(id: number): void;
  sendTunnel(chunk: TunnelChunk): void;
}

/**
 * The remote screen over the relay: bytes to and from Screen Sharing in type 9 frames. Neither side
 * runs more than {@link TUNNEL_WINDOW} ahead of what the other acknowledged, so a fast screen
 * never piles up in the relay's buffer toward a slow phone.
 */
export class TunnelChannel extends HeldChannel {
  #sent = 0n;
  #peerAcked = 0n;
  #received = 0n;
  #consumed = 0n;
  #acked = 0n;
  #outbox: Uint8Array[] = [];

  constructor(private readonly link: TunnelLink, readonly tunnelId: number) {
    super();
    link.openTunnel(tunnelId, { chunk: (chunk) => this.onChunk(chunk), end: () => this.ended(false) });
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.state !== "open") return;
    const bytes = bytesOf(data);
    for (let offset = 0; offset < bytes.length; offset += MAX_TUNNEL_CHUNK) this.#outbox.push(bytes.subarray(offset, offset + MAX_TUNNEL_CHUNK));
    this.flush();
  }

  close(): void {
    if (this.state === "closed") return;
    this.link.sendTunnel({ tunnelId: this.tunnelId, offset: this.#sent, kind: "eof", chunk: new Uint8Array() });
    this.link.closeTunnel(this.tunnelId);
    this.ended();
  }

  protected override consumed(bytes: number): void {
    this.#consumed += BigInt(bytes);
    if (this.state === "open" && this.#consumed - this.#acked >= BigInt(TUNNEL_ACK_EVERY)) {
      this.#acked = this.#consumed;
      this.link.sendTunnel({ tunnelId: this.tunnelId, offset: this.#acked, kind: "ack", chunk: new Uint8Array() });
    }
  }

  private flush(): void {
    while (this.#outbox.length && this.#sent - this.#peerAcked < BigInt(TUNNEL_WINDOW)) {
      const room = TUNNEL_WINDOW - Number(this.#sent - this.#peerAcked);
      const head = this.#outbox[0]!;
      const piece = head.length <= room ? head : head.subarray(0, room);
      if (piece.length === head.length) this.#outbox.shift();
      else this.#outbox[0] = head.subarray(room);
      this.link.sendTunnel({ tunnelId: this.tunnelId, offset: this.#sent, kind: "data", chunk: piece });
      this.#sent += BigInt(piece.length);
    }
  }

  private onChunk(chunk: TunnelChunk): void {
    if (this.state !== "open") return;
    if (chunk.kind === "ack") {
      if (chunk.offset < this.#peerAcked || chunk.offset > this.#sent) return this.broken();
      this.#peerAcked = chunk.offset;
      this.flush();
      return;
    }
    if (chunk.offset !== this.#received) return this.broken();
    if (chunk.kind === "eof") {
      this.link.closeTunnel(this.tunnelId);
      this.ended();
      return;
    }
    this.#received += BigInt(chunk.chunk.length);
    this.deliver(chunk.chunk);
  }

  private broken(): void {
    this.link.sendTunnel({ tunnelId: this.tunnelId, offset: this.#sent, kind: "eof", chunk: new Uint8Array() });
    this.link.closeTunnel(this.tunnelId);
    this.onerror?.(new Event("error"));
    this.ended(false);
  }
}

/** The remote screen straight to the Mac: the data channel `real-bot-rtc` answered. */
export class PeerChannel extends HeldChannel {
  constructor(private readonly channel: RTCDataChannel, private readonly connection: RTCPeerConnection) {
    super();
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event: MessageEvent) => this.deliver(new Uint8Array(event.data as ArrayBuffer));
    channel.onclose = () => this.ended();
    channel.onerror = (event) => this.onerror?.(event);
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") this.ended(false);
    };
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.state !== "open" || this.channel.readyState !== "open") return;
    this.channel.send(bytesOf(data));
  }

  close(): void {
    if (this.state === "closed") return;
    try { this.channel.close(); } catch {}
    try { this.connection.close(); } catch {}
    this.ended();
  }
}
