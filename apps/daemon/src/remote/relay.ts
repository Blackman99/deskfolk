import { base64url, canonicalBytes, canonicalize, fromBase64url, randomBytes, signEnrollmentProof, text,
  type EnrollmentChallenge } from "@real-bot/remote";

export type RelayConfig = { origin: string; relayId: string; hostId: string };
type RecordValue = Record<string, unknown>;
function object(data: string | Uint8Array): RecordValue {
  const source = typeof data === "string" ? data : text(data);
  if (source.length > 65536) throw new Error("relay_limit");
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalize(value) !== source) throw new Error("relay_shape");
  return value;
}
function exact(value: RecordValue, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("relay_shape");
}
export type RelaySocketFactory = (url: string) => WebSocket;
const nativeSocket: RelaySocketFactory = url => new WebSocket(url);
/** How often a control socket asks the relay whether it still hears it, and how long the answer may take. */
export type RelayHeartbeat = { everyMs: number; timeoutMs: number };
const HEARTBEAT: RelayHeartbeat = { everyMs: 15_000, timeoutMs: 10_000 };

/** One host-wide FIFO reserves headroom for device traffic and relay control replies. */
export class RelayBudget {
  private next = 0;
  private pending = 0;
  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 65536 || this.pending >= 64) throw new Error("relay_budget");
    signal?.throwIfAborted();
    const now = performance.now(), start = Math.max(now, this.next);
    this.next = start + (bytes + 64) / 1500;
    this.pending++;
    try { await delay(Math.ceil(start - now), signal); signal?.throwIfAborted(); }
    finally { this.pending--; }
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) { signal?.throwIfAborted(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("relay_cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** One ordered enrollment, then binary-only control or opaque data on each socket. */
export class RelayConnection {
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private settled = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout>;
  private rejectReady!: (error: Error) => void;
  constructor(config: RelayConfig, secret: Uint8Array, mode: "control" | "link",
    private readonly receive: (data: Uint8Array) => void,
    private readonly disconnected: () => void,
    route?: { route_id: string; device_id: string }, factory: RelaySocketFactory = nativeSocket) {
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" || origin.origin !== config.origin) throw new Error("relay_origin");
    const url = `${config.origin.replace(/^https:/, "wss:")}/v1/relay/host`;
    const nonce = base64url(randomBytes(16));
    let phase: "challenge" | "ok" | "binary" = "challenge";
    this.socket = factory(url);
    this.socket.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.socket.onopen = () => this.socket.send(canonicalize({ type: "hello", id: config.hostId, nonce_c: nonce, mode, ...route }));
      this.socket.onmessage = event => {
        try {
          if (this.closed) return;
          if (phase === "binary") {
            if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65536) throw new Error("relay_opcode");
            this.receive(new Uint8Array(event.data)); return;
          }
          if (typeof event.data !== "string" || event.data.length > 2048) throw new Error("relay_opcode");
          const value = object(event.data);
          if (phase === "challenge") {
            exact(value, ["type", "role", "id", "nonce_c", "nonce_s", "ts", "relay_id"]);
            if (value.type !== "challenge" || value.role !== "host" || value.id !== config.hostId || value.nonce_c !== nonce ||
                value.relay_id !== config.relayId || !Number.isSafeInteger(value.ts) || Math.abs(Date.now() / 1000 - Number(value.ts)) >= 10) throw new Error("relay_challenge");
            fromBase64url(String(value.nonce_s), 16);
            this.socket.send(canonicalize({ type: "proof", signature: signEnrollmentProof(value as unknown as EnrollmentChallenge, secret) }));
            phase = "ok";
          } else {
            exact(value, mode === "control" ? ["type", "mode"] : ["type", "mode", "route_id", "device_id"]);
            if (value.type !== "ok" || value.mode !== mode || (route && (value.route_id !== route.route_id || value.device_id !== route.device_id))) throw new Error("relay_ok");
            phase = "binary"; this.settled = true; clearTimeout(this.timer); resolve();
          }
        } catch { this.close(); }
      };
      this.socket.onclose = () => this.close();
      this.socket.onerror = () => this.close();
    });
    this.timer = setTimeout(() => this.close(), 10_000);
    void this.ready.catch(() => undefined);
  }
  send(data: Uint8Array): void {
    if (this.closed || !this.settled || data.length > 65536 || this.socket.bufferedAmount + data.length > 65536) {
      this.close(); throw new Error("relay_backpressure");
    }
    try { this.socket.send(new Uint8Array(data)); }
    catch { this.close(); throw new Error("relay_disconnected"); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.settled) this.rejectReady(new Error("relay_disconnected"));
    const socket = this.socket as WebSocket & { terminate?: () => void };
    if (socket.terminate) socket.terminate(); else socket.close();
    this.disconnected();
  }
}

export class RelayControl {
  readonly connection: RelayConnection;
  private nextCommand = 0;
  private readonly abort = new AbortController();
  private admissions = 0;
  private pending = new Map<string, { op: string; resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(config: RelayConfig, secret: Uint8Array, notification: (value: RecordValue) => void, disconnected: () => void, factory?: RelaySocketFactory,
    private readonly budget = new RelayBudget(), beat: RelayHeartbeat = HEARTBEAT) {
    this.connection = new RelayConnection(config, secret, "control", data => {
      try {
        const value = object(data);
        if (value.type === "result") {
          const id = String(value.request_id), pending = this.pending.get(id);
          if (!pending) throw new Error("relay_correlation");
          const keys = pending.op === "health" ? ["devices", "routes", "mailboxes", "sockets", "pairing_enabled"]
            : pending.op === "read_pair" ? (value.pending === true ? ["pending"] : ["ciphertext", "offset", "total"]) : [];
          exact(value, ["type", "request_id", ...keys]);
          this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(value);
        } else if (value.type === "route_pending") {
          exact(value, ["type", "route_id", "device_id"]);
          fromBase64url(String(value.route_id), 16);
          if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(value.device_id))) throw new Error("relay_device");
          notification(value);
        } else if (value.type === "route_closed") {
          exact(value, ["type", "route_id"]); fromBase64url(String(value.route_id), 16); notification(value);
        } else throw new Error("relay_notification");
      } catch { this.connection.close(); }
    }, () => {
      clearInterval(this.heartbeat);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("relay_disconnected")); }
      this.pending.clear(); this.abort.abort(); disconnected();
    }, undefined, factory);
    // A network that drops without a word leaves this socket looking open for good: the relay lets
    // go of it, its goodbye never arrives, and nothing here writes to a socket until a phone wants
    // a route, which the relay now refuses before asking. So the control keeps asking the relay
    // whether it still hears it, and an answer that does not come closes it for a reconnect.
    void this.connection.ready.then(() => {
      if (this.abort.signal.aborted) return;
      let asking = false;
      this.heartbeat = setInterval(() => {
        if (asking) return;
        asking = true;
        this.command("health", {}, beat.timeoutMs).catch(() => undefined).finally(() => { asking = false; });
      }, beat.everyMs);
    }, () => undefined);
  }
  async command(op: string, fields: RecordValue = {}, timeoutMs = 10_000): Promise<RecordValue> {
    if (this.admissions >= 16) throw new Error("relay_busy");
    this.admissions++;
    const id = base64url(randomBytes(16));
    const bytes = canonicalBytes({ ...fields, op, request_id: id });
    try {
      await this.connection.ready;
      const now = performance.now(), at = Math.max(now, this.nextCommand);
      this.nextCommand = at + 75;
      await delay(Math.ceil(at - now), this.abort.signal);
      await this.budget.take(bytes.length, this.abort.signal);
    } finally { this.admissions--; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.connection.close(), timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      try { this.connection.send(bytes); }
      catch {
        this.pending.delete(id); clearTimeout(timer); reject(new Error("relay_disconnected")); this.connection.close();
      }
    });
  }
  close(): void { this.connection.close(); }
}
