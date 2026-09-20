import { createCipheriv, createECDH, createPrivateKey, hkdfSync, sign as nodeSign } from "node:crypto";
import { USER_MEMBER, WEB_PUSH_COPY, WEB_PUSH_PAYLOAD, type ClientEvent } from "@real-bot/protocol";
import { base64url, fromBase64url } from "@real-bot/remote";
import { HttpError } from "../errors";
import { sha256 } from "../request-digest";
import type { Store } from "../store";
import type { RemoteNativeClient } from "../remote-native";

/** Adding a domain requires code and docs review. The relay never sends. */
export const PUSH_ALLOWED_HOSTS = ["*.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"] as const;
export const PUSH_PLAINTEXT = JSON.stringify(WEB_PUSH_PAYLOAD);
export const PUSH_VISIBLE_COPY = WEB_PUSH_COPY;

const ENDPOINT_MAX = 2048;
const KEY_INFO = Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0])]);
const CEK_INFO = Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0])]);
const NONCE_INFO = Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0])]);
const RECORD_SIZE = 4096;
const VAPID_TTL = 12 * 3600;

export type PushSub = {
  device_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  expires_at: number | null;
  created_at: number;
};

export type PushSubscribeInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at?: number | null;
};

export function isAllowedPushHost(host: string): boolean {
  const hostname = host.trim().toLowerCase();
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..") || /[^a-z0-9.-]/.test(hostname)) {
    return false;
  }
  if (hostname === "fcm.googleapis.com" || hostname === "updates.push.services.mozilla.com") return true;
  if (!hostname.endsWith(".push.apple.com")) return false;
  const prefix = hostname.slice(0, -".push.apple.com".length);
  return prefix.length > 0 && !prefix.startsWith(".") && !prefix.endsWith(".") && !prefix.includes("..");
}

export function parsePushEndpoint(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > ENDPOINT_MAX) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(422, "invalid_args", "push endpoint rejected"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  if (url.href !== value && url.href !== `${value}/`) throw new HttpError(422, "invalid_args", "push endpoint rejected");
  const host = url.hostname;
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !isAllowedPushHost(host)) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  return url;
}

export function endpointHash(endpoint: string): string {
  return sha256(Buffer.from(endpoint));
}

function keyBytes(value: string, length: number): Uint8Array {
  try {
    const bytes = fromBase64url(value, length);
    if (length === 65 && bytes[0] !== 0x04) throw new Error("uncompressed");
    return bytes;
  } catch {
    throw new HttpError(422, "invalid_args", "push keys rejected");
  }
}

export function parseSubscribe(body: Record<string, unknown>): PushSubscribeInput {
  const keys = Object.keys(body).sort();
  if (keys.join() !== "auth,endpoint,p256dh" && keys.join() !== "auth,endpoint,expires_at,p256dh") {
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
  if (typeof body.endpoint !== "string" || typeof body.p256dh !== "string" || typeof body.auth !== "string") {
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
  parsePushEndpoint(body.endpoint);
  keyBytes(body.p256dh, 65);
  keyBytes(body.auth, 16);
  let expires_at: number | null | undefined;
  if (Object.hasOwn(body, "expires_at")) {
    if (body.expires_at === null) expires_at = null;
    else if (typeof body.expires_at === "number" && Number.isSafeInteger(body.expires_at) && body.expires_at >= 0) expires_at = body.expires_at;
    else throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
  return { endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth, expires_at };
}

export function upsertPushSub(store: Store, deviceId: string, input: PushSubscribeInput, now: number): void {
  parsePushEndpoint(input.endpoint);
  keyBytes(input.p256dh, 65);
  keyBytes(input.auth, 16);
  const expires = input.expires_at === undefined ? null : input.expires_at;
  store.db.run(
    `INSERT INTO remote_push_subs(device_id, endpoint, endpoint_hash, p256dh, auth, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       endpoint = excluded.endpoint, endpoint_hash = excluded.endpoint_hash,
       p256dh = excluded.p256dh, auth = excluded.auth, expires_at = excluded.expires_at`,
    [deviceId, input.endpoint, endpointHash(input.endpoint), input.p256dh, input.auth, expires, now],
  );
}

export function deletePushSubs(store: Store, deviceId: string | null): void {
  store.db.run("DELETE FROM remote_push_subs WHERE ? IS NULL OR device_id = ?", [deviceId, deviceId]);
}

export function pushSub(store: Store, deviceId: string): PushSub | null {
  return store.db.query<PushSub, [string]>("SELECT * FROM remote_push_subs WHERE device_id = ?").get(deviceId);
}

export function livePushSubs(store: Store, now: number): PushSub[] {
  return store.db.query<PushSub, [number]>(
    "SELECT * FROM remote_push_subs WHERE expires_at IS NULL OR expires_at > ?",
  ).all(now);
}

function sessionIsBotBot(store: Store, sessionId: string): boolean {
  const session = store.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return true;
  if (session.kind !== "direct") return false;
  const members = store.db.query<{ member: string }, [string]>(
    "SELECT member FROM session_participants WHERE session_id = ? AND left_at IS NULL",
  ).all(sessionId).map((row) => row.member);
  return !members.includes(USER_MEMBER);
}

function sessionIdForApproval(store: Store, turnId: string): string | null {
  return store.db.query<{ session_id: string }, [string]>("SELECT session_id FROM turns WHERE id = ?").get(turnId)?.session_id ?? null;
}

export function shouldNotify(store: Store, event: ClientEvent): boolean {
  if (event.event === "approval.upsert") {
    if (event.status !== "pending") return false;
    const sessionId = sessionIdForApproval(store, event.turn_id);
    return !!sessionId && !sessionIsBotBot(store, sessionId);
  }
  if (event.event === "turn.upsert") {
    return event.status === "interrupted" && !sessionIsBotBot(store, event.session_id);
  }
  if (event.event !== "message.created" && event.event !== "message.upsert") return false;
  if (sessionIsBotBot(store, event.session_id)) return false;
  if (event.kind === "ask" || event.kind === "approval" || event.kind === "bot") return true;
  return event.kind === "system" && (event.body.startsWith("这一轮没写完：") || event.body.startsWith("This turn did not finish:"));
}

export function vapidPrivate32(raw: Uint8Array): Buffer {
  if (raw.length !== 32) throw new HttpError(503, "failed", "vapid unavailable");
  return Buffer.from(raw);
}

export function vapidPublic(privateKey: Uint8Array): Uint8Array {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(vapidPrivate32(privateKey));
  return new Uint8Array(ecdh.getPublicKey(null, "uncompressed"));
}

function jwtPart(value: object): string {
  return base64url(Buffer.from(JSON.stringify(value)));
}

export function vapidJwt(privateKey: Uint8Array, audience: string, now: number): string {
  const pub = vapidPublic(privateKey);
  const header = jwtPart({ typ: "JWT", alg: "ES256" });
  const payload = jwtPart({ aud: audience, exp: Math.floor(now / 1000) + VAPID_TTL, sub: "mailto:real-bot@localhost" });
  const input = `${header}.${payload}`;
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapidPrivate32(privateKey).toString("base64url"),
      x: Buffer.from(pub.subarray(1, 33)).toString("base64url"),
      y: Buffer.from(pub.subarray(33)).toString("base64url"),
    },
    format: "jwk",
  });
  const signature = nodeSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${base64url(signature)}`;
}

export function encryptPush(
  plaintext: Uint8Array,
  p256dh: Uint8Array,
  auth: Uint8Array,
  salt = crypto.getRandomValues(new Uint8Array(16)),
  as = createECDH("prime256v1"),
): Uint8Array {
  as.generateKeys();
  const asPublic = new Uint8Array(as.getPublicKey(null, "uncompressed"));
  const secret = new Uint8Array(as.computeSecret(Buffer.from(p256dh)));
  const keyInfo = Buffer.concat([KEY_INFO, Buffer.from(p256dh), Buffer.from(asPublic)]);
  const ikm = new Uint8Array(hkdfSync("sha256", secret, auth, keyInfo, 32));
  secret.fill(0);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));
  ikm.fill(0);
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  cek.fill(0);
  nonce.fill(0);
  padded.fill(0);
  const header = Buffer.alloc(21 + asPublic.length);
  header.set(salt, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  header.set(asPublic, 21);
  return new Uint8Array(Buffer.concat([header, body]));
}

export function pushHeaders(endpoint: URL, vapidPrivate: Uint8Array, now: number): Record<string, string> {
  const jwt = vapidJwt(vapidPrivate, endpoint.origin, now);
  return {
    Authorization: `vapid t=${jwt}, k=${base64url(vapidPublic(vapidPrivate))}`,
    TTL: "60",
    Urgency: "normal",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
  };
}

export function assertNoContentLeak(value: string, forbidden: string[]): void {
  const lower = value.toLowerCase();
  for (const item of forbidden) {
    if (item && lower.includes(item.toLowerCase())) throw new Error("push payload leak");
  }
}

export type PushFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PushService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: {
    store: Store;
    native: Pick<RemoteNativeClient, "read">;
    fetch?: PushFetch;
    now?: () => number;
  }) {}
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  now(): number { return this.options.now?.() ?? Date.now(); }
  async applicationServerKey(): Promise<string> {
    const vapid = await this.options.native.read("vapid");
    try {
      vapidPrivate32(vapid);
      return base64url(vapidPublic(vapid));
    } finally { vapid.fill(0); }
  }
  async publicState(deviceId: string): Promise<{ applicationServerKey: string; subscribed: boolean }> {
    return { applicationServerKey: await this.applicationServerKey(), subscribed: !!pushSub(this.options.store, deviceId) };
  }
  subscribe(deviceId: string, body: Record<string, unknown>): void {
    upsertPushSub(this.options.store, deviceId, parseSubscribe(body), this.now());
  }
  unsubscribe(deviceId: string): void {
    deletePushSubs(this.options.store, deviceId);
  }
  notify(event: ClientEvent): void {
    if (!shouldNotify(this.options.store, event)) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, 250);
  }
  async flush(): Promise<void> {
    this.close();
    let vapid: Uint8Array | undefined;
    try {
      const subs = livePushSubs(this.options.store, this.now());
      if (!subs.length) return;
      vapid = await this.options.native.read("vapid");
      vapidPrivate32(vapid);
      for (const sub of subs) await this.deliver(sub, vapid);
    } catch {
      // Best-effort only. Inbox remains the source of truth; a closed store is not a send.
    } finally { vapid?.fill(0); }
  }
  private async deliver(sub: PushSub, vapid: Uint8Array): Promise<void> {
    let url: URL;
    try { url = parsePushEndpoint(sub.endpoint); } catch {
      deletePushSubs(this.options.store, sub.device_id);
      return;
    }
    const p256dh = keyBytes(sub.p256dh, 65);
    const auth = keyBytes(sub.auth, 16);
    const body = encryptPush(Buffer.from(PUSH_PLAINTEXT), p256dh, auth);
    const headers = pushHeaders(url, vapid, this.now());
    const wire = Buffer.from(body).toString("latin1");
    assertNoContentLeak(`${url.href}\n${JSON.stringify(headers)}\n${wire}\n${PUSH_PLAINTEXT}`, []);
    const fetchFn = this.options.fetch ?? fetch;
    const response = await fetchFn(url, { method: "POST", redirect: "error", headers, body: Buffer.from(body) });
    if (response.status === 404 || response.status === 410) deletePushSubs(this.options.store, sub.device_id);
  }
}
