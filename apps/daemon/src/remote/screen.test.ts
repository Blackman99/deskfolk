import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { createLocalApi } from "../local-api";
import { onlyDataChannel, parseIceServers, screenHost, ScreenService } from "./screen";
import { rtcHelperPath, startDisplayHold, startStayAwake, type DisplayHold, type RtcSpawn } from "./rtc-helper";
import { TunnelMux } from "./tunnel";
import { HttpError } from "../errors";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function rfbServer(greeting = "RFB 003.889\n") {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.write(greeting); }, data() {} } });
  cleanup.push(() => server.stop(true));
  return server;
}

function service(options: Partial<ConstructorParameters<typeof ScreenService>[0]> = {}) {
  const store = new Store({ endpointKey: memoryKeyStore(null) });
  const screen = new ScreenService({ store, helperPath: () => null, wakeDisplay: () => ({ stop() {} }), ...options });
  cleanup.push(() => { screen.close(); store.close(); });
  return { store, screen };
}

test("off until the Mac turns it on; the switch and servers persist", async () => {
  const { screen } = service({ port: rfbServer().port });
  expect(screen.settings()).toEqual({ enabled: false, iceServers: [] });
  const status = await screen.configure({ enabled: true, iceServers: [{ urls: "stun:relay.example:3478" }] });
  expect(status).toMatchObject({ enabled: true, sharing: true, direct: false, sessions: [], iceServers: [{ urls: ["stun:relay.example:3478"] }] });
  expect((await screen.configure({ enabled: false })).iceServers).toEqual([{ urls: ["stun:relay.example:3478"] }]);
  await expect(screen.configure({ enabled: "yes" })).rejects.toBeInstanceOf(HttpError);
  for (const body of [null, [], "on"]) await expect(screen.configure(body)).rejects.toMatchObject({ status: 422 });
});

test("Screen Sharing counts as on only when something greets like an RFB server", async () => {
  expect(await service({ port: rfbServer().port }).screen.probe(true)).toBe(true);
  expect(await service({ port: rfbServer("SSH-2.0-OpenSSH\r\n").port }).screen.probe(true)).toBe(false);
  const closed = rfbServer();
  const port = closed.port;
  closed.stop(true);
  expect(await service({ port }).screen.probe(true)).toBe(false);
});

test("a session nobody pings for 45 s ends", async () => {
  let now = 1_000_000;
  const { screen } = service({ port: rfbServer().port, now: () => now });
  await screen.configure({ enabled: true });
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  const { session_id } = await screen.handle(link, "/remote/screen/start", {});
  now += 30_000;
  expect(await screen.handle(link, "/remote/screen/status", { session_id })).toEqual({ mode: "connecting" });
  now += 44_000;
  (screen as unknown as { sweep(): void }).sweep();
  expect(screen.status().sessions.length).toBe(1);
  now += 2_000;
  (screen as unknown as { sweep(): void }).sweep();
  expect(screen.status().sessions).toEqual([]);
});

test("a session belongs to the link that opened it; a new start from the same phone replaces it", async () => {
  const { screen } = service({ port: rfbServer().port });
  await screen.configure({ enabled: true });
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  const other = { routeId: "r2", deviceId: "d2", deviceName: "Tablet", tunnels: new TunnelMux(() => {}) };
  const first = await screen.handle(link, "/remote/screen/start", {});
  await expect(screen.handle(other, "/remote/screen/status", { session_id: first.session_id })).rejects.toMatchObject({ code: "screen_session_gone" });
  const second = await screen.handle(link, "/remote/screen/start", {});
  expect(second.session_id).not.toBe(first.session_id);
  expect(screen.status().sessions.length).toBe(1);
  await screen.handle(other, "/remote/screen/start", {});
  screen.linkClosed("r1");
  expect(screen.status().sessions.map((s) => s.deviceName)).toEqual(["Tablet"]);
});

test("ICE servers are stun:/turn: addresses in a short list", () => {
  expect(parseIceServers([{ urls: ["turn:relay.example:3478?transport=udp"], username: "u", credential: "p" }]))
    .toEqual([{ urls: ["turn:relay.example:3478?transport=udp"], username: "u", credential: "p" }]);
  for (const bad of [null, {}, [{ urls: [] }], [{ urls: ["http://x"] }], [{ urls: ["stun:a b"] }], Array(9).fill({ urls: "stun:x" }), [{ urls: "stun:x", username: 1 }]]) {
    expect(() => parseIceServers(bad)).toThrow();
  }
});

test("an offer passes only with one data channel section", () => {
  const data = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
  expect(onlyDataChannel(data)).toBe(true);
  expect(onlyDataChannel(`${data}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`)).toBe(false);
  expect(onlyDataChannel("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n")).toBe(false);
  expect(onlyDataChannel("v=0\r\n")).toBe(false);
});

test("the helper is the packaged one, a source build, or none; an .exe on Windows, nothing elsewhere", () => {
  expect(rtcHelperPath({ REAL_BOT_RTC_HELPER: "/x/real-bot-rtc" }, "darwin", () => false)).toBe("/x/real-bot-rtc");
  expect(rtcHelperPath({}, "win32", (path) => path.endsWith("real-bot-rtc.exe"), join("/app", "native", "real-bot-daemon.exe")))
    .toBe(join("/app", "native", "real-bot-rtc.exe"));
  const slashed = (path: string) => path.replaceAll("\\", "/");
  expect(rtcHelperPath({}, "win32", (path) => slashed(path).endsWith("target/debug/real-bot-rtc.exe"), "/nowhere/bun.exe"))
    .toMatch(/apps[\\/]rtc-helper[\\/]target[\\/]debug[\\/]real-bot-rtc\.exe$/);
  expect(rtcHelperPath({}, "win32", (path) => !path.endsWith(".exe"))).toBeNull();
  expect(rtcHelperPath({}, "linux", () => true)).toBeNull();
  expect(rtcHelperPath({}, "darwin", () => false)).toBeNull();
  expect(rtcHelperPath({}, "darwin", (path) => path.endsWith("target/release/real-bot-rtc"))).toMatch(/apps\/rtc-helper\/target\/release\/real-bot-rtc$/);
});

test("the window reads and sets the switch over loopback; disconnect ends every session", async () => {
  const { store, screen } = service({ port: rfbServer().port });
  const api = createLocalApi({ store, token: "t", schedule: false, screen });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  cleanup.push(async () => { await api.engine.close(); await server.stop(true); });
  const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(await (await call("GET", "/v1/remote/screen")).json()).toMatchObject({ enabled: false, sharing: true, sessions: [] });
  expect(await (await call("PUT", "/v1/remote/screen", { enabled: true })).json()).toMatchObject({ enabled: true });
  expect((await call("PUT", "/v1/remote/screen", { iceServers: [{ urls: ["ftp://x"] }] })).status).toBe(422);
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  await screen.handle(link, "/remote/screen/start", {});
  expect((await (await call("GET", "/v1/remote/screen")).json()).sessions).toMatchObject([{ deviceName: "Phone", mode: "connecting" }]);
  expect((await (await call("POST", "/v1/remote/screen/disconnect")).json()).sessions).toEqual([]);
});

test("the display is woken when a phone starts a session and let go when the last one ends", async () => {
  const log: string[] = [];
  const { screen } = service({ port: rfbServer().port, wakeDisplay: () => { log.push("wake"); return { stop: () => log.push("sleep") }; } });
  await screen.configure({ enabled: true });
  const a = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  const b = { routeId: "r2", deviceId: "d2", deviceName: "Tablet", tunnels: new TunnelMux(() => {}) };
  const first = await screen.handle(a, "/remote/screen/start", {});
  await screen.handle(b, "/remote/screen/start", {});
  expect(log).toEqual(["wake"]);
  await screen.handle(a, "/remote/screen/stop", { session_id: first.session_id });
  expect(log).toEqual(["wake"]);
  screen.linkClosed("r2");
  expect(log).toEqual(["wake", "sleep"]);
  await screen.handle(a, "/remote/screen/start", {});
  expect(log).toEqual(["wake", "sleep", "wake"]);
});

/** A stand-in for `real-bot-rtc display-hold` that never touches this Mac's screen. */
function fakeDisplay(result: { lowered: { width: number; height: number; fromWidth: number; fromHeight: number } } | { failed: string }) {
  const log: string[] = [];
  const holdDisplay = (): DisplayHold => {
    log.push("lower");
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    return { ready: Promise.resolve(result), ended, release: async () => { log.push("restore"); end(); } };
  };
  return { log, holdDisplay };
}
const LOWERED = { lowered: { width: 2336, height: 1510, fromWidth: 4112, fromHeight: 2658 } };

test("a smooth session lowers the display before it answers, keeps it across a reconnect, and gives it back", async () => {
  const display = fakeDisplay(LOWERED);
  const { screen } = service({ port: rfbServer().port, holdDisplay: display.holdDisplay, restoreGraceMs: 20 });
  await screen.configure({ enabled: true });
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  const first = await screen.handle(link, "/remote/screen/start", { smooth: true });
  expect(first.smooth).toEqual({ applied: true, width: 2336, height: 1510, from_width: 4112, from_height: 2658 });
  expect(screen.status().lowered).toEqual(LOWERED.lowered);
  // The phone reconnects (a toggle elsewhere, a page coming back): the display stays as it is.
  await screen.handle(link, "/remote/screen/stop", { session_id: first.session_id });
  const second = await screen.handle(link, "/remote/screen/start", { smooth: true });
  await Bun.sleep(40);
  expect(display.log).toEqual(["lower"]);
  // Gone for good: back after the grace.
  await screen.handle(link, "/remote/screen/stop", { session_id: second.session_id });
  expect(display.log).toEqual(["lower"]);
  await Bun.sleep(40);
  expect(display.log).toEqual(["lower", "restore"]);
  expect(screen.status().lowered).toBeUndefined();
});

test("switching smooth off gives the display back before the new session answers", async () => {
  const display = fakeDisplay(LOWERED);
  const { screen } = service({ port: rfbServer().port, holdDisplay: display.holdDisplay, restoreGraceMs: 60_000 });
  await screen.configure({ enabled: true });
  const phone = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  const tablet = { routeId: "r2", deviceId: "d2", deviceName: "Tablet", tunnels: new TunnelMux(() => {}) };
  await screen.handle(phone, "/remote/screen/start", { smooth: true });
  // Another device still wants it smooth: a sharp session joins the lowered screen.
  const sharpTablet = await screen.handle(tablet, "/remote/screen/start", {});
  expect(sharpTablet.smooth).toBeUndefined();
  expect(display.log).toEqual(["lower"]);
  const sharp = await screen.handle(phone, "/remote/screen/start", {});
  expect(sharp.smooth).toBeUndefined();
  expect(display.log).toEqual(["lower", "restore"]);
});

test("turning the screen off, or the Mac's disconnect, gives the display back at once", async () => {
  const display = fakeDisplay(LOWERED);
  const { screen } = service({ port: rfbServer().port, holdDisplay: display.holdDisplay, restoreGraceMs: 60_000 });
  await screen.configure({ enabled: true });
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  await screen.handle(link, "/remote/screen/start", { smooth: true });
  screen.endAll();
  await Bun.sleep(0);
  expect(display.log).toEqual(["lower", "restore"]);
});

test("a display that cannot go lower says why, and nothing stays held", async () => {
  const display = fakeDisplay({ failed: "already_low" });
  const { screen } = service({ port: rfbServer().port, holdDisplay: display.holdDisplay });
  await screen.configure({ enabled: true });
  const link = { routeId: "r1", deviceId: "d1", deviceName: "Phone", tunnels: new TunnelMux(() => {}) };
  expect((await screen.handle(link, "/remote/screen/start", { smooth: true })).smooth).toEqual({ applied: false, reason: "already_low" });
  expect(display.log).toEqual(["lower", "restore"]);
  expect(screen.status().lowered).toBeUndefined();
  // Without a helper there is nothing to lower with.
  const bare = service({ port: rfbServer().port }).screen;
  await bare.configure({ enabled: true });
  expect((await bare.handle(link, "/remote/screen/start", { smooth: true })).smooth).toEqual({ applied: false, reason: "unavailable" });
});

/** `real-bot-rtc display-hold` as its frames: what it writes, and what it was told. */
function displayHelper(script: (write: (type: number, body: unknown) => void, closed: Promise<void>) => void) {
  const told: string[] = [];
  let args: string[] = [];
  let closeStdin!: () => void;
  const closed = new Promise<void>((resolve) => { closeStdin = resolve; });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const write = (type: number, body: unknown) => {
    const payload = new TextEncoder().encode(JSON.stringify(body));
    const out = new Uint8Array(5 + payload.length);
    out[0] = type; new DataView(out.buffer).setUint32(1, payload.length); out.set(payload, 5);
    controller.enqueue(out);
  };
  const spawn: RtcSpawn = (_path, given = []) => {
    args = given;
    script((type, body) => write(type, body), closed);
    // After whatever the script does once stdin closes: the process exits, its stdout ends.
    void closed.then(() => queueMicrotask(() => controller.close()));
    return {
      stdin: { write: (bytes: Uint8Array) => { told.push(`frame ${bytes[0]}`); }, end: () => { told.push("end"); closeStdin(); } },
      stdout, kill: () => told.push("kill"), exited: closed,
    };
  };
  return { spawn, told, args: () => args };
}

test("display-hold: lowered, told to stop, restored", async () => {
  const restored: string[] = [];
  const helper = displayHelper((write, closed) => {
    write(5, { width: 2336, height: 1510, from_width: 4112, from_height: 2658 });
    // The real helper restores, says so, then exits.
    void closed.then(() => { restored.push("restored"); write(2, { state: "restored" }); });
  });
  const hold = startDisplayHold("/x/real-bot-rtc", helper.spawn);
  expect(helper.args()).toEqual(["display-hold"]);
  expect(await hold.ready).toEqual(LOWERED);
  await hold.release();
  expect(helper.told).toEqual(["frame 2", "end"]);
  expect(restored).toEqual(["restored"]);
  await hold.ended;
  // Released once, however often asked.
  await hold.release();
  expect(helper.told).toEqual(["frame 2", "end"]);
});

test("a phone learns whether it is looking at a Mac or a Windows PC", () => {
  expect(screenHost("darwin")).toBe("mac");
  expect(screenHost("win32")).toBe("windows");
});

test("stay-awake: started with its subcommand, let go by closing its stdin", async () => {
  const helper = displayHelper(() => {});
  const awake = startStayAwake("/x/real-bot-rtc.exe", helper.spawn);
  expect(helper.args()).toEqual(["stay-awake"]);
  awake.stop();
  awake.stop();
  expect(helper.told).toEqual(["end"]);
});

test("display-hold: a refusal or silence is a failure, not a hang", async () => {
  const refused = startDisplayHold("/x", displayHelper((write) => write(3, { code: "no_lower_mode", message: "" })).spawn);
  expect(await refused.ready).toEqual({ failed: "no_lower_mode" });
  const silent = startDisplayHold("/x", displayHelper(() => {}).spawn, 20);
  expect(await silent.ready).toEqual({ failed: "display_timeout" });
});
