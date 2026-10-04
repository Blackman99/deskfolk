import { afterEach, expect, test } from "bun:test";
import { TUNNEL_ACK_EVERY, TUNNEL_WINDOW, type TunnelChunk } from "@real-bot/remote";
import { RemoteTransport } from "./transport.ts";
import { deviceKeys, enrollment, fakeHost } from "./test-host.ts";
import { TunnelChannel, type TunnelLink } from "./rfb-channel.ts";
import { connectScreen, type ScreenApi, type SmoothResult } from "./screen-connect.ts";
import { RemoteApi } from "./api.ts";
import type { TunnelSink } from "./transport.ts";

const opened: RemoteTransport[] = [];
afterEach(() => {
  for (const transport of opened.splice(0)) transport.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A link that records what a channel sends and lets the test play the Mac. */
function fakeLink() {
  const sent: TunnelChunk[] = [];
  const sinks = new Map<number, TunnelSink>();
  const closed: number[] = [];
  const link: TunnelLink = {
    openTunnel: (id, sink) => { sinks.set(id, sink); },
    closeTunnel: (id) => { closed.push(id); sinks.delete(id); },
    sendTunnel: (chunk) => { sent.push(chunk); },
  };
  return { link, sent, sinks, closed };
}

test("what arrives before noVNC attaches waits for it, and is acknowledged once handed over", async () => {
  const { link, sent, sinks } = fakeLink();
  const channel = new TunnelChannel(link, 3);
  expect(channel.readyState).toBe("open");
  const greeting = new TextEncoder().encode("RFB 003.889\n");
  sinks.get(3)!.chunk({ tunnelId: 3, offset: 0n, kind: "data", chunk: greeting });
  const bulk = new Uint8Array(TUNNEL_ACK_EVERY).fill(1);
  sinks.get(3)!.chunk({ tunnelId: 3, offset: BigInt(greeting.length), kind: "data", chunk: bulk });
  expect(sent).toEqual([]);
  const seen: number[] = [];
  channel.onmessage = (event) => seen.push(event.data.byteLength);
  await tick();
  expect(seen).toEqual([12, TUNNEL_ACK_EVERY]);
  expect(sent).toEqual([{ tunnelId: 3, offset: BigInt(12 + TUNNEL_ACK_EVERY), kind: "ack", chunk: new Uint8Array() }]);
});

test("noVNC finds every name it checks for on the channel itself", () => {
  const channel = new TunnelChannel(fakeLink().link, 1);
  const names = [...Object.keys(channel), ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel))];
  for (const name of ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"]) expect(names).toContain(name);
});

test("sends are copied, split, and held past the window until the Mac acknowledges", () => {
  const { link, sent, sinks } = fakeLink();
  const channel = new TunnelChannel(link, 5);
  const reused = new Uint8Array(TUNNEL_WINDOW + 1000).fill(9);
  channel.send(reused);
  reused.fill(0);
  const data = () => sent.filter((c) => c.kind === "data");
  expect(data().reduce((n, c) => n + c.chunk.length, 0)).toBe(TUNNEL_WINDOW);
  expect(data().every((c) => c.chunk.every((b) => b === 9))).toBe(true);
  sinks.get(5)!.chunk({ tunnelId: 5, offset: BigInt(TUNNEL_WINDOW), kind: "ack", chunk: new Uint8Array() });
  expect(data().reduce((n, c) => n + c.chunk.length, 0)).toBe(TUNNEL_WINDOW + 1000);
});

test("the Mac's EOF closes the channel; closing it sends EOF; a gap is an error", async () => {
  const first = fakeLink();
  const channel = new TunnelChannel(first.link, 7);
  const closes: unknown[] = [];
  channel.onclose = (event) => closes.push(event);
  first.sinks.get(7)!.chunk({ tunnelId: 7, offset: 0n, kind: "eof", chunk: new Uint8Array() });
  expect(channel.readyState).toBe("closed");
  // Like a socket's: the close event comes a task later.
  expect(closes).toEqual([]);
  await tick();
  expect(closes).toEqual([{ code: 1000, reason: "", wasClean: true }]);
  expect(first.closed).toEqual([7]);

  const second = fakeLink();
  const mine = new TunnelChannel(second.link, 8);
  mine.close();
  expect(second.sent).toEqual([{ tunnelId: 8, offset: 0n, kind: "eof", chunk: new Uint8Array() }]);
  mine.send(new Uint8Array([1]));
  expect(second.sent.length).toBe(1);

  const third = fakeLink();
  const broken = new TunnelChannel(third.link, 9);
  let errors = 0;
  broken.onerror = () => errors++;
  third.sinks.get(9)!.chunk({ tunnelId: 9, offset: 5n, kind: "data", chunk: new Uint8Array([1]) });
  expect(errors).toBe(1);
  expect(broken.readyState).toBe("closed");
});

test("the transport routes type 9 both ways, keeps early frames for their owner, and ends tunnels with the link", async () => {
  const relay = fakeHost();
  const transport = new RemoteTransport(enrollment, deviceKeys, { socketFactory: () => relay.socket as unknown as WebSocket, sleep: async () => {} });
  opened.push(transport);
  await transport.connect();
  relay.tunnel({ tunnelId: 2, offset: 0n, kind: "data", chunk: new Uint8Array([82, 70, 66]) });
  const channel = new TunnelChannel(transport, 2);
  const got: number[] = [];
  channel.onmessage = (event) => got.push(...new Uint8Array(event.data));
  await tick();
  expect(got).toEqual([82, 70, 66]);
  channel.send(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]));
  await tick();
  expect(relay.tunnelFrames.map(({ at: _at, ...chunk }) => chunk)).toEqual([
    { tunnelId: 2, offset: 0n, kind: "data", chunk: new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]) },
  ]);
  let closed = false;
  channel.onclose = () => { closed = true; };
  relay.socket.drop();
  expect(channel.readyState).toBe("closed");
  await tick();
  expect(closed).toBe(true);
});

function fakeApi(options: { direct: boolean; offer?: (sdp: string) => Promise<{ sdp: string }>; smooth?: SmoothResult }) {
  const calls: string[] = [];
  const api: ScreenApi = {
    screenStart: async (start) => {
      calls.push(start?.smooth ? "start smooth" : "start");
      return { session_id: "S1", ice_servers: [{ urls: "stun:relay.example:3478" }], direct: options.direct, ...(start?.smooth && options.smooth !== undefined ? { smooth: options.smooth } : {}) };
    },
    screenOffer: async (_id, sdp) => { calls.push("offer"); return options.offer ? options.offer(sdp) : { sdp: "answer" }; },
    screenTunnel: async () => { calls.push("tunnel"); return { tunnel_id: 4 }; },
    openScreenTunnel: (id) => new TunnelChannel(fakeLink().link, id),
  };
  return { api, calls };
}

/** A peer connection whose channel opens (or never does) once the answer is set. */
function fakePeer(opens: boolean, candidates = true) {
  const created: Array<{ config: RTCConfiguration; closed: boolean }> = [];
  const factory = (config: RTCConfiguration) => {
    const record = { config, closed: false };
    created.push(record);
    const channel = { readyState: "connecting", binaryType: "blob", onopen: null as null | (() => void), onclose: null, onmessage: null, onerror: null, send() {}, close() {} };
    return {
      iceGatheringState: "complete",
      localDescription: { sdp: candidates ? "v=0\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\n" : "v=0\r\n" },
      connectionState: "new",
      createDataChannel: () => channel,
      createOffer: async () => ({ type: "offer", sdp: "offer-sdp" }),
      setLocalDescription: async () => {},
      setRemoteDescription: async () => { if (opens) queueMicrotask(() => { channel.readyState = "open"; channel.onopen?.(); }); },
      addEventListener() {},
      close: () => { record.closed = true; },
    } as unknown as RTCPeerConnection;
  };
  return { factory, created };
}

test("goes straight to the Mac when the channel opens, with the Mac's ICE servers", async () => {
  const { api, calls } = fakeApi({ direct: true });
  const peer = fakePeer(true);
  const connection = await connectScreen(api, { peerConnection: peer.factory, openMs: 50 });
  expect(connection.mode).toBe("direct");
  expect(calls).toEqual(["start", "offer"]);
  expect(peer.created[0]!.config).toEqual({ iceServers: [{ urls: "stun:relay.example:3478" }] });
});

test("falls back to the relay when the direct channel never opens, or the Mac cannot take one", async () => {
  const silent = fakeApi({ direct: true });
  const peer = fakePeer(false);
  const relayed = await connectScreen(silent.api, { peerConnection: peer.factory, openMs: 30 });
  expect(relayed.mode).toBe("relay");
  expect(silent.calls).toEqual(["start", "offer", "tunnel"]);
  expect(peer.created[0]!.closed).toBe(true);

  const refused = fakeApi({ direct: true, offer: async () => { throw new Error("direct_failed"); } });
  expect((await connectScreen(refused.api, { peerConnection: fakePeer(true).factory, openMs: 30 })).mode).toBe("relay");

  // A browser with nothing to offer goes to the relay without asking the Mac first.
  const offline = fakeApi({ direct: true });
  const nothing = fakePeer(true, false);
  expect((await connectScreen(offline.api, { peerConnection: nothing.factory, openMs: 5000 })).mode).toBe("relay");
  expect(offline.calls).toEqual(["start", "tunnel"]);

  const noHelper = fakeApi({ direct: false });
  const unused = fakePeer(true);
  expect((await connectScreen(noHelper.api, { peerConnection: unused.factory })).mode).toBe("relay");
  expect(unused.created).toEqual([]);
  expect(noHelper.calls).toEqual(["start", "tunnel"]);
});

test("the page learns from the link's features whether the Mac offers its screen", async () => {
  for (const [screen, offered] of [["rfb-v1", true], [undefined, false]] as const) {
    const relay = fakeHost({ answer: (request) => request.path === "/remote/features"
      ? { v: 1, id: request.id, status: 200, body: { compress: null, ...(screen ? { screen } : {}) } } : null });
    const api = new RemoteApi(enrollment, { socketFactory: () => relay.socket as unknown as WebSocket });
    await api.connect(() => {});
    expect(api.screenOffered).toBe(offered);
    api.close();
  }
  // A Mac from before the remote screen answers 404 to the features ask.
  const old = fakeHost();
  const api = new RemoteApi(enrollment, { socketFactory: () => old.socket as unknown as WebSocket });
  await api.connect(() => {});
  expect(api.screenOffered).toBe(false);
  api.close();
});

test("screen calls carry the Mac's error codes", async () => {
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => ({ v: 1, id: request.id, status: 409, body: { error: { code: "screen_sharing_off", message: "Screen Sharing is not on" } } }),
  });
  await expect(api.screenStart()).rejects.toMatchObject({ status: 409, code: "screen_sharing_off" });
});

test("a smooth connection asks the Mac for it and carries its answer, or null from a Mac that gives none", async () => {
  const lowered = { applied: true as const, width: 2336, height: 1510, from_width: 4112, from_height: 2658 };
  const answering = fakeApi({ direct: false, smooth: lowered });
  const connection = await connectScreen(answering.api, { smooth: true });
  expect(answering.calls[0]).toBe("start smooth");
  expect(connection.smooth).toEqual(lowered);
  const old = fakeApi({ direct: false });
  expect((await connectScreen(old.api, { smooth: true })).smooth).toBeNull();
  // Not asked: nothing to report either way.
  const plain = fakeApi({ direct: false, smooth: lowered });
  const sharp = await connectScreen(plain.api);
  expect(plain.calls[0]).toBe("start");
  expect("smooth" in sharp).toBe(false);
});
