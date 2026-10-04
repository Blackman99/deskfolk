import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RemoteScreenIceServer } from "@real-bot/protocol";

/** What the Mac's settings name for ICE; the phone never supplies these. */
export type IceServer = RemoteScreenIceServer;

/**
 * `real-bot-rtc`, packaged next to the daemon; in a source checkout, whatever `cargo build` last
 * produced. The override exists for tests and for a daemon started from somewhere unusual. Null on
 * Windows and when nothing is built: the phone then goes straight to the relayed path.
 */
export function rtcHelperPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const override = env.REAL_BOT_RTC_HELPER;
  if (override) return override;
  if (platform !== "darwin") return null;
  const packaged = join(dirname(process.execPath), "real-bot-rtc");
  if (exists(packaged)) return packaged;
  const root = resolve(import.meta.dir, "../../../..");
  for (const configuration of ["release", "debug"]) {
    const built = join(root, "apps/rtc-helper/target", configuration, "real-bot-rtc");
    if (exists(built)) return built;
  }
  return null;
}

const TYPE_OFFER = 1;
const TYPE_CLOSE = 2;
const TYPE_ANSWER = 1;
const TYPE_STATE = 2;
const TYPE_ERROR = 3;
const TYPE_STATS = 4;
const TYPE_DISPLAY = 5;

function frame(type: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export type RtcHelperEvent = { type: "state"; state: string } | { type: "error"; code: string; message: string }
  | { type: "stats"; toPhone: number; fromPhone: number } | { type: "exit" };

export interface RtcHelper {
  /** The answer SDP, or a rejection with the helper's error code. */
  readonly answer: Promise<string>;
  close(): void;
}

export type RtcSpawn = (path: string, args?: string[]) => {
  stdin: { write(bytes: Uint8Array): unknown; flush?(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
  exited: Promise<unknown>;
};

const defaultSpawn: RtcSpawn = (path, args = []) => Bun.spawn([path, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });

/** Every frame the helper writes, until its stdout ends or garbles; then resolves. */
async function readFrames(stdout: ReadableStream<Uint8Array>, onFrame: (type: number, body: Record<string, unknown>) => void): Promise<void> {
  const reader = stdout.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer); next.set(value, buffer.length); buffer = next;
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1, false);
        if (length > 64 * 1024) throw new Error("helper_frame");
        if (buffer.length < 5 + length) break;
        const type = buffer[0]!, body = JSON.parse(new TextDecoder().decode(buffer.subarray(5, 5 + length))) as Record<string, unknown>;
        buffer = buffer.slice(5 + length);
        onFrame(type, body);
      }
    }
  } catch {
    // A garbled stream is as final as a closed one.
  }
}

/**
 * One helper process for one phone's offer. Its stdin stays open for as long as the session
 * lasts; closing it (or killing the process) ends the connection.
 */
export function startRtcHelper(path: string, offer: { sdp: string; iceServers: IceServer[] }, onEvent: (event: RtcHelperEvent) => void,
  spawn: RtcSpawn = defaultSpawn, answerTimeoutMs = 8000): RtcHelper {
  const child = spawn(path);
  let settled = false;
  let resolveAnswer!: (sdp: string) => void, rejectAnswer!: (error: Error) => void;
  const answer = new Promise<string>((ok, fail) => { resolveAnswer = ok; rejectAnswer = fail; });
  const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
  const timer = setTimeout(() => settle(() => rejectAnswer(new Error("answer_timeout"))), answerTimeoutMs);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { child.stdin.write(frame(TYPE_CLOSE, {})); child.stdin.end(); } catch {}
    // A helper that does not take its connection down promptly is not waited on.
    setTimeout(() => { try { child.kill(); } catch {} }, 2000);
  };
  child.stdin.write(frame(TYPE_OFFER, { sdp: offer.sdp, ice_servers: offer.iceServers }));
  child.stdin.flush?.();
  void (async () => {
    await readFrames(child.stdout, (type, body) => {
      if (type === TYPE_ANSWER && typeof body.sdp === "string") { const sdp = body.sdp; settle(() => resolveAnswer(sdp)); }
      else if (type === TYPE_STATE && typeof body.state === "string") onEvent({ type: "state", state: body.state });
      else if (type === TYPE_STATS && typeof body.to_phone === "number" && typeof body.from_phone === "number") {
        onEvent({ type: "stats", toPhone: body.to_phone, fromPhone: body.from_phone });
      }
      else if (type === TYPE_ERROR) {
        const code = typeof body.code === "string" ? body.code : "helper_error";
        settle(() => rejectAnswer(new Error(code)));
        onEvent({ type: "error", code, message: typeof body.message === "string" ? body.message : "" });
      }
    });
    settle(() => rejectAnswer(new Error("helper_exited")));
    close();
    onEvent({ type: "exit" });
  })();
  return { answer, close };
}

/** Pixel sizes: what Screen Sharing's framebuffer is while lowered, and what it was. */
export type LoweredDisplay = { width: number; height: number; fromWidth: number; fromHeight: number };

export interface DisplayHold {
  /** The display as lowered, or why it was not (`already_low`, `no_lower_mode`, …). */
  readonly ready: Promise<{ lowered: LoweredDisplay } | { failed: string }>;
  /** Puts the display back; settles once it is back, or once the helper is gone. */
  release(): Promise<void>;
  /** Settles when the helper ends for any reason: macOS has put the display back by then. */
  readonly ended: Promise<void>;
}

export type HoldDisplay = () => DisplayHold;

/**
 * The Mac's display at a lower resolution for as long as `real-bot-rtc display-hold` runs. macOS
 * reverts its app-scoped mode when the process ends, however it ends, so a daemon that dies
 * leaves no low-resolution screen behind; a release restores first and says so.
 */
export function startDisplayHold(path: string, spawn: RtcSpawn = defaultSpawn, timeoutMs = 4000): DisplayHold {
  const child = spawn(path, ["display-hold"]);
  let resolveReady!: (value: { lowered: LoweredDisplay } | { failed: string }) => void;
  const ready = new Promise<{ lowered: LoweredDisplay } | { failed: string }>((resolve) => { resolveReady = resolve; });
  let restored!: () => void;
  const back = new Promise<void>((resolve) => { restored = resolve; });
  const timer = setTimeout(() => resolveReady({ failed: "display_timeout" }), timeoutMs);
  const ended = (async () => {
    await readFrames(child.stdout, (type, body) => {
      if (type === TYPE_DISPLAY && [body.width, body.height, body.from_width, body.from_height].every((n) => typeof n === "number")) {
        resolveReady({ lowered: { width: body.width as number, height: body.height as number, fromWidth: body.from_width as number, fromHeight: body.from_height as number } });
      } else if (type === TYPE_ERROR) {
        resolveReady({ failed: typeof body.code === "string" ? body.code : "display_failed" });
      } else if (type === TYPE_STATE && body.state === "restored") {
        restored();
      }
    });
    clearTimeout(timer);
    resolveReady({ failed: "helper_exited" });
    restored();
  })();
  let released: Promise<void> | null = null;
  return {
    ready,
    ended,
    release() {
      released ??= (async () => {
        try { child.stdin.write(frame(TYPE_CLOSE, {})); child.stdin.end(); } catch {}
        const kill = setTimeout(() => { try { child.kill(); } catch {} }, 3000);
        await back;
        clearTimeout(kill);
      })();
      return released;
    },
  };
}
