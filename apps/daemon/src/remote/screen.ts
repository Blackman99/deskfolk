import { connect } from "node:net";
import type { RemoteScreenStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import type { Store } from "../store";
import { rtcHelperPath, startDisplayHold, startRtcHelper, startStayAwake, type DisplayHold, type HoldDisplay, type IceServer, type LoweredDisplay, type RtcHelper, type RtcSpawn } from "./rtc-helper";
import { RfbSniffer } from "./rfb-sniff";
import type { TunnelMux, TunnelSocket } from "./tunnel";

/**
 * Where the screen's RFB server listens: macOS Screen Sharing (and Remote Management) on every
 * interface including loopback; on Windows, a VNC server the user installed (ADR 0059).
 */
export const SCREEN_SHARING_PORT = 5900;

/** Which computer a phone is looking at, for its words and its key row: a Mac, or a Windows PC. */
export type ScreenHost = "mac" | "windows";
export function screenHost(platform: string = process.platform): ScreenHost {
  return platform === "win32" ? "windows" : "mac";
}
/** The phone pings while its page is open; a session that stops hearing from it ends. */
const KEEPALIVE_TIMEOUT_MS = 45_000;
const PROBE_TTL_MS = 3000;
const MAX_ICE_SERVERS = 8;
const MAX_SDP = 16 * 1024;
/** A smooth session's display stays lowered this long after it ends, for the reconnect that usually follows. */
const RESTORE_GRACE_MS = 3000;

export type ScreenStatus = RemoteScreenStatus;
export type ScreenSessionView = RemoteScreenStatus["sessions"][number];
export type ScreenMode = ScreenSessionView["mode"];

/** The link a session rides on: which device, and the byte streams that link can carry. */
export interface ScreenLink {
  readonly routeId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly tunnels: TunnelMux;
}

type Session = ScreenSessionView & { id: string; link: ScreenLink; lastSeen: number; smooth: boolean; helper?: RtcHelper; tunnelId?: number; sniffer?: RfbSniffer };

export type ScreenServiceOptions = {
  store: Store;
  /** Tests point this at a fake RFB server. Production has no way to name another port. */
  port?: number;
  helperPath?: () => string | null;
  spawnHelper?: RtcSpawn;
  /** Opens the local socket a relayed session carries; `node:net` unless a test says. */
  connect?: (port: number) => TunnelSocket;
  now?: () => number;
  /**
   * Keeps the display on while anyone is connected: `caffeinate` on macOS, `real-bot-rtc
   * stay-awake` on Windows, unless a test says.
   */
  wakeDisplay?: () => { stop(): void };
  /**
   * Lowers the Mac's display while a session wants it smooth; `real-bot-rtc display-hold` unless a
   * test says. A test that names a real helper must name this too: that one changes this Mac's screen.
   */
  holdDisplay?: HoldDisplay;
  restoreGraceMs?: number;
};

/**
 * A display that is off is captured as black: at the lock screen macOS turns it off after half a
 * minute, whatever the energy settings say, and Screen Sharing then sends a phone a black frame
 * where Apple's own client would have woken it. `-u` declares the user active, which turns the
 * display on (the lock screen shows, ready for a password); `-d` and the long `-t` keep it on until
 * the last session lets go.
 */
function caffeinate(helperPath: () => string | null): { stop(): void } {
  if (process.platform === "win32") return stayAwake(helperPath());
  if (process.platform !== "darwin") return { stop() {} };
  try {
    const child = Bun.spawn(["/usr/bin/caffeinate", "-d", "-u", "-t", "86400"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return { stop() { try { child.kill(); } catch {} } };
  } catch {
    return { stop() {} };
  }
}

/**
 * Windows has no `caffeinate`: the helper holds `SetThreadExecutionState` for the display and the
 * system until its stdin closes, so a PC left idle does not sleep under a phone that is watching
 * it. Without a helper (a source checkout that never built it) nothing holds them.
 */
function stayAwake(path: string | null): { stop(): void } {
  if (!path) return { stop() {} };
  try {
    return startStayAwake(path);
  } catch {
    return { stop() {} };
  }
}

/**
 * The remote screen: a paired phone viewing and driving this computer through an RFB server it
 * already runs — macOS's own Screen Sharing, or on Windows a VNC server the user installed. The
 * daemon only ever connects to that one local port, either itself (the relayed path, bytes in
 * type 9 frames) or through `real-bot-rtc` (the direct path). Everything here is off until the
 * computer's own settings turn it on, and only the window can do that.
 */
export class ScreenService {
  private readonly sessions = new Map<string, Session>();
  private probed?: { at: number; sharing: boolean };
  private readonly sweeper: ReturnType<typeof setInterval>;
  private awake?: { stop(): void };
  private display?: { hold: DisplayHold; lowered?: LoweredDisplay };
  private restoreTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ScreenServiceOptions) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref?.();
  }

  private get port(): number { return this.options.port ?? SCREEN_SHARING_PORT; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private helperPath(): string | null { return (this.options.helperPath ?? rtcHelperPath)(); }

  settings(): { enabled: boolean; iceServers: IceServer[] } {
    const row = this.options.store.db.query<{ enabled: number; ice_servers: string }, []>(
      "SELECT enabled, ice_servers FROM remote_screen WHERE singleton = 1").get();
    if (!row) return { enabled: false, iceServers: [] };
    let iceServers: IceServer[] = [];
    try { iceServers = parseIceServers(JSON.parse(row.ice_servers)); } catch {}
    return { enabled: row.enabled === 1, iceServers };
  }

  status(): ScreenStatus {
    return {
      ...this.settings(),
      sharing: this.probed?.sharing ?? null,
      direct: this.helperPath() !== null,
      sessions: [...this.sessions.values()].map(({ deviceId, deviceName, mode, since, toPhone, fromPhone, sniffer }) => {
        const facts = sniffer?.facts;
        return {
          deviceId, deviceName, mode, since, toPhone, fromPhone,
          ...(facts?.width !== undefined && facts.height !== undefined
            ? { framebuffer: { width: facts.width, height: facts.height, ...(facts.firstMessage?.rect ? { firstEncoding: facts.firstMessage.rect.encoding } : {}) } }
            : {}),
        };
      }),
      ...(this.display?.lowered ? { lowered: this.display.lowered } : {}),
    };
  }

  /** The window's settings. Turning it off ends every session now. */
  async configure(body: unknown): Promise<ScreenStatus> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "invalid_args", "body must be an object");
    const input = body as { enabled?: unknown; iceServers?: unknown };
    const current = this.settings();
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(422, "invalid_args", "enabled must be a boolean");
    const enabled = input.enabled ?? current.enabled;
    const iceServers = input.iceServers === undefined ? current.iceServers : parseIceServers(input.iceServers);
    this.options.store.db.run(
      "INSERT INTO remote_screen (singleton, enabled, ice_servers) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled, ice_servers = excluded.ice_servers",
      [enabled ? 1 : 0, JSON.stringify(iceServers)]);
    if (!enabled) this.endAll();
    await this.probe(true);
    return this.status();
  }

  /**
   * Whether Screen Sharing (or the Windows VNC server) is there: something on the port that greets
   * like an RFB server. A Windows VNC server that refuses loopback connections drops the socket
   * before its greeting, and reads as not there.
   */
  async probe(fresh = false): Promise<boolean> {
    if (!fresh && this.probed && this.now() - this.probed.at < PROBE_TTL_MS) return this.probed.sharing;
    const sharing = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: this.port });
      let banner = "";
      const done = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
      const timer = setTimeout(() => done(false), 1500);
      socket.on("data", (bytes: Buffer) => {
        banner += bytes.toString("latin1");
        if (banner.length >= 12) done(/^RFB 003\.\d{3}\n/.test(banner));
      });
      socket.on("error", () => done(false));
      socket.on("close", () => done(false));
    });
    this.probed = { at: this.now(), sharing };
    return sharing;
  }

  /** One `/remote/screen/*` request from a paired device on its link. */
  async handle(link: ScreenLink, path: string, body: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    if (path === "/remote/screen/start") return this.start(link, body?.smooth === true);
    const session = this.sessionFor(link, body?.session_id);
    switch (path) {
      case "/remote/screen/offer": return this.offer(session, body?.sdp);
      case "/remote/screen/tunnel": return this.tunnel(session);
      case "/remote/screen/status":
        session.lastSeen = this.now();
        return { mode: session.mode };
      case "/remote/screen/stop":
        this.end(session);
        return { ended: true };
      default:
        throw new HttpError(404, "not_found", "unknown route");
    }
  }

  private async start(link: ScreenLink, smooth: boolean): Promise<Record<string, unknown>> {
    const settings = this.settings();
    if (!settings.enabled) throw new HttpError(409, "screen_disabled", "remote screen is turned off on the Mac");
    if (!await this.probe(true)) throw new HttpError(409, "screen_sharing_off", "Screen Sharing is not on");
    for (const session of [...this.sessions.values()]) if (session.deviceId === link.deviceId) this.end(session);
    const session: Session = { id: ulid(), link, deviceId: link.deviceId, deviceName: link.deviceName, mode: "connecting",
      since: this.now(), lastSeen: this.now(), toPhone: 0, fromPhone: 0, smooth };
    this.sessions.set(session.id, session);
    // Before the channel exists, so the display is on by the time the first frame is taken.
    this.awake ??= (this.options.wakeDisplay ?? (() => caffeinate(() => this.helperPath())))();
    // Also before: Screen Sharing announces the framebuffer once, when the phone connects.
    const lowered = await this.smoothDisplay(smooth);
    return { session_id: session.id, ice_servers: settings.iceServers, direct: this.helperPath() !== null, ...(lowered ? { smooth: lowered } : {}) };
  }

  /**
   * The display for a session starting: lowered when it wants it smooth (shared with any other
   * smooth session, kept across a reconnect), and back to the user's own resolution, before the
   * phone connects, when it does not and no other session does either.
   */
  private async smoothDisplay(wanted: boolean): Promise<Record<string, unknown> | undefined> {
    if (!wanted) {
      if (![...this.sessions.values()].some((session) => session.smooth)) await this.restoreDisplay();
      return undefined;
    }
    this.cancelRestore();
    if (!this.display) {
      // Only macOS: its app-scoped mode is what puts the screen back even if the helper dies. A
      // Windows VNC server sends the Tight JPEG noVNC asks for, which is small already.
      const path = process.platform === "darwin" ? this.helperPath() : null;
      const hold = this.options.holdDisplay?.() ?? (path ? startDisplayHold(path) : null);
      if (!hold) return { applied: false, reason: "unavailable" };
      const held = { hold };
      this.display = held;
      // A helper that ended on its own took its mode with it: macOS has put the display back.
      void hold.ended.then(() => { if (this.display === held) this.display = undefined; });
    }
    const held = this.display;
    const result = await held.hold.ready;
    if ("failed" in result) {
      if (this.display === held) this.display = undefined;
      void held.hold.release();
      return { applied: false, reason: result.failed };
    }
    held.lowered = result.lowered;
    const { width, height, fromWidth, fromHeight } = result.lowered;
    return { applied: true, width, height, from_width: fromWidth, from_height: fromHeight };
  }

  private cancelRestore(): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
  }

  private async restoreDisplay(): Promise<void> {
    this.cancelRestore();
    const held = this.display;
    this.display = undefined;
    await held?.hold.release();
  }

  private async offer(session: Session, sdp: unknown): Promise<Record<string, unknown>> {
    if (typeof sdp !== "string" || sdp.length > MAX_SDP || !onlyDataChannel(sdp)) throw new HttpError(422, "invalid_args", "offer must carry one data channel and nothing else");
    const path = this.helperPath();
    if (!path) throw new HttpError(409, "direct_unavailable", "this Mac cannot take a direct connection");
    if (session.helper || session.tunnelId !== undefined) throw new HttpError(409, "conflict", "session already connecting");
    session.lastSeen = this.now();
    const helper = startRtcHelper(path, { sdp, iceServers: this.settings().iceServers }, (event) => {
      if (session.helper !== helper) return;
      if (event.type === "state" && event.state === "open") session.mode = "direct";
      if (event.type === "stats") { session.toPhone = event.toPhone; session.fromPhone = event.fromPhone; }
      if (event.type === "exit" && this.sessions.get(session.id) === session) this.end(session);
    }, this.options.spawnHelper);
    session.helper = helper;
    try {
      return { sdp: await helper.answer };
    } catch (error) {
      if (session.helper === helper) { session.helper = undefined; helper.close(); }
      throw new HttpError(502, "direct_failed", error instanceof Error ? error.message : "direct connection failed");
    }
  }

  /** The fallback: the daemon opens the socket itself and the bytes ride the link. */
  private tunnel(session: Session): Record<string, unknown> {
    if (session.tunnelId !== undefined) throw new HttpError(409, "conflict", "session already relayed");
    if (session.helper) { const helper = session.helper; session.helper = undefined; helper.close(); }
    session.lastSeen = this.now();
    const sniffer = new RfbSniffer();
    session.sniffer = sniffer;
    const socket = observed((this.options.connect ?? defaultConnect)(this.port), session, sniffer);
    const tunnelId = session.link.tunnels.open(socket, () => {
      if (session.tunnelId === tunnelId && this.sessions.get(session.id) === session) this.end(session);
    });
    session.tunnelId = tunnelId;
    session.mode = "relay";
    return { tunnel_id: tunnelId };
  }

  private sessionFor(link: ScreenLink, id: unknown): Session {
    const session = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!session || session.link !== link) throw new HttpError(404, "screen_session_gone", "no such screen session");
    return session;
  }

  private end(session: Session): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    if (!this.sessions.size) {
      this.awake?.stop();
      this.awake = undefined;
    }
    if (this.display && !this.restoreTimer && ![...this.sessions.values()].some((other) => other.smooth)) {
      this.restoreTimer = setTimeout(() => void this.restoreDisplay(), this.options.restoreGraceMs ?? RESTORE_GRACE_MS);
      this.restoreTimer.unref?.();
    }
    const helper = session.helper;
    session.helper = undefined;
    helper?.close();
    const tunnelId = session.tunnelId;
    session.tunnelId = undefined;
    if (tunnelId !== undefined) session.link.tunnels.close(tunnelId);
  }

  /** A link went away (dropped, revoked, the relay restarted): whatever rode it ends. */
  linkClosed(routeId: string): void {
    for (const session of [...this.sessions.values()]) if (session.link.routeId === routeId) this.end(session);
  }

  /** The Mac's own "disconnect", a revocation, the setting turned off, the daemon stopping. */
  endAll(): void {
    for (const session of [...this.sessions.values()]) this.end(session);
    // Nobody is reconnecting after this: the display goes back now.
    void this.restoreDisplay();
  }

  close(): void {
    clearInterval(this.sweeper);
    this.endAll();
  }

  private sweep(): void {
    const cutoff = this.now() - KEEPALIVE_TIMEOUT_MS;
    for (const session of [...this.sessions.values()]) if (session.lastSeen < cutoff) this.end(session);
  }
}

/** The relayed session's socket, counted and read on the way through (see rfb-sniff.ts). */
function observed(socket: TunnelSocket, session: Session, sniffer: RfbSniffer): TunnelSocket {
  return {
    write(bytes: Uint8Array) {
      session.fromPhone += bytes.length;
      sniffer.fromClient(bytes);
      return socket.write(bytes);
    },
    get writableLength() { return socket.writableLength; },
    end: () => socket.end(),
    destroy: () => socket.destroy(),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    on(event: "data" | "end" | "close" | "error", listener: (value: never) => void) {
      if (event !== "data") return socket.on(event as "end", listener as unknown as () => void);
      const forward = listener as unknown as (bytes: Uint8Array) => void;
      return socket.on("data", (bytes: Uint8Array) => {
        session.toPhone += bytes.length;
        sniffer.fromServer(bytes);
        forward(bytes);
      });
    },
  } as TunnelSocket;
}

function defaultConnect(port: number): TunnelSocket {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  return socket as unknown as TunnelSocket;
}

/** One `m=` section and it is a data channel: the phone never asks for audio or video here. */
export function onlyDataChannel(sdp: string): boolean {
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith("m="));
  return media.length === 1 && media[0]!.startsWith("m=application ") && media[0]!.includes("webrtc-datachannel");
}

export function parseIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS) throw new HttpError(422, "invalid_args", "iceServers must be a short list");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new HttpError(422, "invalid_args", "invalid ICE server");
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = typeof urls === "string" ? [urls] : urls;
    if (!Array.isArray(list) || !list.length || list.length > 4 || !list.every((url) => typeof url === "string" && /^(stun|stuns|turn|turns):[^\s]{1,250}$/.test(url))) {
      throw new HttpError(422, "invalid_args", "ICE server URLs must be stun: or turn: addresses");
    }
    for (const field of [username, credential]) {
      if (field !== undefined && (typeof field !== "string" || field.length > 256)) throw new HttpError(422, "invalid_args", "invalid ICE server credentials");
    }
    return { urls: list as string[], ...(username ? { username: username as string } : {}), ...(credential ? { credential: credential as string } : {}) };
  });
}
