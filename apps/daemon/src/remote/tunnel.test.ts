import { expect, test } from "bun:test";
import { decodeTunnelChunk, encodeTunnelChunk, MAX_TUNNEL_CHUNK, type TunnelChunk } from "@real-bot/remote";
import { TUNNEL_ACK_EVERY, TUNNEL_WINDOW, TunnelMux, type TunnelSocket } from "./tunnel";

class FakeSocket implements TunnelSocket {
  written: Uint8Array[] = [];
  writableLength = 0;
  paused = false;
  ended = false;
  destroyed = false;
  private listeners: Record<string, Array<(value?: unknown) => void>> = {};
  write(bytes: Uint8Array) { this.written.push(bytes); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  on(event: string, listener: (value: any) => void) { (this.listeners[event] ??= []).push(listener as (value?: unknown) => void); return this; }
  emit(event: string, value?: unknown) { for (const listener of this.listeners[event] ?? []) listener(value); }
}

function harness() {
  const sent: TunnelChunk[] = [];
  const mux = new TunnelMux((body) => sent.push(decodeTunnelChunk(body)));
  const socket = new FakeSocket();
  let closed = 0;
  const id = mux.open(socket, () => closed++);
  const data = () => sent.filter((c) => c.kind === "data");
  const bytesSent = () => data().reduce((n, c) => n + c.chunk.length, 0);
  const ack = (offset: number) => mux.receive(encodeTunnelChunk({ tunnelId: id, offset: BigInt(offset), kind: "ack", chunk: new Uint8Array() }));
  return { mux, socket, id, sent, data, bytesSent, ack, closed: () => closed };
}

test("never runs more than a window ahead of the phone's acknowledgements, and loses nothing", () => {
  const h = harness();
  const screen = new Uint8Array(400_000).map((_, i) => i % 251);
  h.socket.emit("data", screen);
  expect(h.bytesSent()).toBe(TUNNEL_WINDOW);
  expect(h.data().every((c) => c.chunk.length <= MAX_TUNNEL_CHUNK)).toBe(true);
  // 400 KB read, one window out: the rest waits, and past the backlog the socket stops reading.
  expect(h.socket.paused).toBe(true);
  let acked = 0;
  while (h.bytesSent() < screen.length) {
    acked = h.bytesSent();
    h.ack(acked);
    expect(h.bytesSent() - acked).toBeLessThanOrEqual(TUNNEL_WINDOW);
  }
  expect(h.socket.paused).toBe(false);
  const joined = new Uint8Array(screen.length);
  let offset = 0;
  for (const chunk of h.data()) {
    expect(chunk.offset).toBe(BigInt(offset));
    joined.set(chunk.chunk, offset);
    offset += chunk.chunk.length;
  }
  expect(joined).toEqual(screen);
});

test("the phone's bytes reach the socket in order, acknowledged every quarter window", () => {
  const h = harness();
  let offset = 0;
  for (let i = 0; i < 8; i++) {
    const piece = new Uint8Array(4096).fill(i);
    h.mux.receive(encodeTunnelChunk({ tunnelId: h.id, offset: BigInt(offset), kind: "data", chunk: piece }));
    offset += piece.length;
  }
  expect(h.socket.written.map((b) => b[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  const acks = h.sent.filter((c) => c.kind === "ack").map((c) => Number(c.offset));
  expect(acks).toEqual([TUNNEL_ACK_EVERY, TUNNEL_ACK_EVERY * 2]);
  // A gap or a replay is a broken stream.
  expect(() => h.mux.receive(encodeTunnelChunk({ tunnelId: h.id, offset: 1n, kind: "data", chunk: new Uint8Array([1]) }))).toThrow("tunnel_offset");
});

test("acknowledging bytes never sent, or going backwards, breaks the link", () => {
  const h = harness();
  h.socket.emit("data", new Uint8Array(1000));
  expect(() => h.ack(1001)).toThrow("tunnel_ack");
  h.ack(500);
  expect(() => h.ack(499)).toThrow("tunnel_ack");
});

test("the socket ending sends what is left, then EOF; the phone's EOF ends the socket", () => {
  const h = harness();
  h.socket.emit("data", new Uint8Array(TUNNEL_WINDOW + 10));
  h.socket.emit("end");
  expect(h.sent.some((c) => c.kind === "eof")).toBe(false);
  h.ack(TUNNEL_WINDOW);
  const eof = h.sent.at(-1)!;
  expect(eof).toMatchObject({ kind: "eof", offset: BigInt(TUNNEL_WINDOW + 10) });
  expect(h.closed()).toBe(1);
  expect(h.socket.destroyed).toBe(true);

  const other = harness();
  other.mux.receive(encodeTunnelChunk({ tunnelId: other.id, offset: 0n, kind: "eof", chunk: new Uint8Array() }));
  expect(other.socket.destroyed).toBe(true);
  expect(other.closed()).toBe(1);
});

test("an unknown tunnel breaks the link; a frame for one that just closed does not", () => {
  const h = harness();
  expect(() => h.mux.receive(encodeTunnelChunk({ tunnelId: 99, offset: 0n, kind: "ack", chunk: new Uint8Array() }))).toThrow("tunnel_unknown");
  h.mux.close(h.id);
  expect(() => h.ack(0)).not.toThrow();
  expect(h.mux.size).toBe(0);
});

test("a link going away drops every socket without sending anything more", () => {
  const h = harness();
  const before = h.sent.length;
  h.mux.closeAll();
  expect(h.sent.length).toBe(before);
  expect(h.socket.destroyed).toBe(true);
  expect(h.closed()).toBe(1);
});

test("a local end that stops reading does not let the phone pile bytes up on the Mac", () => {
  const h = harness();
  h.socket.writableLength = 2 * 1024 * 1024;
  h.mux.receive(encodeTunnelChunk({ tunnelId: h.id, offset: 0n, kind: "data", chunk: new Uint8Array(10) }));
  expect(h.socket.destroyed).toBe(true);
  expect(h.closed()).toBe(1);
  expect(h.sent.at(-1)?.kind).toBe("eof");
});
