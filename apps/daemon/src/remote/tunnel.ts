import { decodeTunnelChunk, encodeTunnelChunk, MAX_TUNNEL_CHUNK, TUNNEL_ACK_EVERY, TUNNEL_WINDOW, type TunnelChunk } from "@real-bot/remote";

export { TUNNEL_ACK_EVERY, TUNNEL_WINDOW };
/** Read from the socket beyond the window before the socket itself is paused. */
const SOCKET_BACKLOG = 256 * 1024;
/**
 * What may wait to be written to the local socket. The phone's side is acknowledged as it is
 * written, so a local end that stops reading would otherwise let a device grow this without bound.
 */
const SOCKET_WRITE_LIMIT = 1024 * 1024;

/** The parts of a `node:net` socket a tunnel drives. */
export interface TunnelSocket {
  write(bytes: Uint8Array): unknown;
  /** Bytes accepted by `write` and not yet handed to the OS (`node:net`'s `writableLength`). */
  readonly writableLength?: number;
  end(): unknown;
  destroy(): unknown;
  pause(): unknown;
  resume(): unknown;
  on(event: "data", listener: (bytes: Uint8Array) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

type Tunnel = {
  socket: TunnelSocket;
  /** Bytes read from the socket, not yet sent. */
  backlog: Uint8Array[];
  backlogBytes: number;
  paused: boolean;
  sent: bigint;
  acked: bigint;
  received: bigint;
  ackedReceived: bigint;
  socketEnded: boolean;
  onClose?: () => void;
};

/**
 * The byte streams one remote link carries as type 9 frames. Each is bound to a local socket the
 * daemon opened itself; which sockets those are is the caller's business, never the phone's.
 */
export class TunnelMux {
  private readonly tunnels = new Map<number, Tunnel>();
  /** Closed ids, so a frame already on its way when a tunnel ended is not an error. */
  private readonly retired = new Set<number>();
  private nextId = 0;

  constructor(
    /** Queue one type 9 body on the link. */
    private readonly send: (body: Uint8Array) => void,
  ) {}

  get size(): number {
    return this.tunnels.size;
  }

  open(socket: TunnelSocket, onClose?: () => void): number {
    const id = ++this.nextId;
    const tunnel: Tunnel = { socket, backlog: [], backlogBytes: 0, paused: false, sent: 0n, acked: 0n, received: 0n,
      ackedReceived: 0n, socketEnded: false, onClose };
    this.tunnels.set(id, tunnel);
    socket.on("data", (bytes) => {
      if (this.tunnels.get(id) !== tunnel) return;
      tunnel.backlog.push(new Uint8Array(bytes));
      tunnel.backlogBytes += bytes.length;
      this.flush(id, tunnel);
    });
    socket.on("end", () => {
      tunnel.socketEnded = true;
      this.flush(id, tunnel);
    });
    socket.on("close", () => {
      tunnel.socketEnded = true;
      this.flush(id, tunnel);
    });
    socket.on("error", () => this.close(id));
    return id;
  }

  /** A type 9 frame from the phone. Throws on one that makes no sense, which drops the link. */
  receive(body: Uint8Array): void {
    const chunk = decodeTunnelChunk(body);
    const tunnel = this.tunnels.get(chunk.tunnelId);
    if (!tunnel) {
      if (this.retired.has(chunk.tunnelId)) return;
      throw new Error("tunnel_unknown");
    }
    if (chunk.kind === "ack") {
      if (chunk.offset < tunnel.acked || chunk.offset > tunnel.sent) throw new Error("tunnel_ack");
      tunnel.acked = chunk.offset;
      this.flush(chunk.tunnelId, tunnel);
      return;
    }
    if (chunk.offset !== tunnel.received) throw new Error("tunnel_offset");
    if (chunk.kind === "eof") {
      this.close(chunk.tunnelId, false);
      return;
    }
    tunnel.socket.write(chunk.chunk);
    if ((tunnel.socket.writableLength ?? 0) > SOCKET_WRITE_LIMIT) {
      this.close(chunk.tunnelId);
      return;
    }
    tunnel.received += BigInt(chunk.chunk.length);
    if (tunnel.received - tunnel.ackedReceived >= BigInt(TUNNEL_ACK_EVERY)) {
      tunnel.ackedReceived = tunnel.received;
      this.emit({ tunnelId: chunk.tunnelId, offset: tunnel.received, kind: "ack", chunk: new Uint8Array() });
    }
  }

  /** Ends one tunnel, telling the phone unless the link it would go on is already gone. */
  close(id: number, tell = true): void {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return;
    this.tunnels.delete(id);
    this.retired.add(id);
    if (this.retired.size > 32) this.retired.delete(this.retired.values().next().value!);
    if (tell) this.emit({ tunnelId: id, offset: tunnel.sent, kind: "eof", chunk: new Uint8Array() });
    tunnel.backlog.length = 0;
    tunnel.socket.destroy();
    tunnel.onClose?.();
  }

  /** The link is gone: nothing more is sent, every socket is dropped. */
  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id, false);
  }

  private flush(id: number, tunnel: Tunnel): void {
    if (this.tunnels.get(id) !== tunnel) return;
    while (tunnel.backlog.length && tunnel.sent - tunnel.acked < BigInt(TUNNEL_WINDOW)) {
      const room = Math.min(MAX_TUNNEL_CHUNK, TUNNEL_WINDOW - Number(tunnel.sent - tunnel.acked));
      const head = tunnel.backlog[0]!;
      const piece = head.length <= room ? head : head.subarray(0, room);
      if (piece.length === head.length) tunnel.backlog.shift();
      else tunnel.backlog[0] = head.subarray(room);
      tunnel.backlogBytes -= piece.length;
      this.emit({ tunnelId: id, offset: tunnel.sent, kind: "data", chunk: piece });
      tunnel.sent += BigInt(piece.length);
    }
    if (!tunnel.paused && tunnel.backlogBytes > SOCKET_BACKLOG) {
      tunnel.paused = true;
      tunnel.socket.pause();
    } else if (tunnel.paused && tunnel.backlogBytes <= SOCKET_BACKLOG / 2) {
      tunnel.paused = false;
      tunnel.socket.resume();
    }
    if (tunnel.socketEnded && !tunnel.backlog.length) this.close(id);
  }

  private emit(chunk: TunnelChunk): void {
    this.send(encodeTunnelChunk(chunk));
  }
}
