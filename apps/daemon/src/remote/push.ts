import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as nodeSign,
} from "node:crypto";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import {
  WEB_PUSH_PAYLOAD,
  type ClientEvent,
  type NotificationItem,
  type PushPublicState,
  type PushRecoveryReason,
  type PushSubscribeRequestV2,
} from "@real-bot/protocol";
import { base64url, fromBase64url } from "@real-bot/remote";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import {
  BATCHING_WINDOW_MS,
  DELIVERY_ABSOLUTE_DEADLINE_MS,
  isQuietHoursActive,
  MAX_DELIVERY_ATTEMPTS,
  nextQuietHoursEndMs,
  PresenceManager,
  SEND_SLOT_INTERVAL_MS,
  TEST_RATE_LIMIT_MS,
} from "../notifications";
import { sha256 } from "../request-digest";
import type { Store } from "../store";
import type { RemoteNativeClient } from "../remote-native";
import type { RemoteTrust } from "./trust";

export {
  BATCHING_WINDOW_MS,
  DELIVERY_ABSOLUTE_DEADLINE_MS,
  MAX_DELIVERY_ATTEMPTS,
  SEND_SLOT_INTERVAL_MS,
  TEST_RATE_LIMIT_MS,
};

/** Adding a domain requires code and docs review. The relay never sends. */
export const PUSH_ALLOWED_HOSTS = [
  "*.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
] as const;
export const PUSH_PLAINTEXT = JSON.stringify(WEB_PUSH_PAYLOAD);

export const ENDPOINT_MAX = 2048;
export const REQUEST_TIMEOUT_MS = 10_000;
export const GLOBAL_CONCURRENCY_LIMIT = 4;
const MAX_PUSH_RESPONSE_BYTES = 64 * 1024;

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
  generation: number;
  vapid_fingerprint: string | null;
  last_diagnostics: string | null;
  created_at: number;
};

type PushSubscribeMaterials = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at?: number | null;
};

export function isAllowedPushHost(host: string): boolean {
  const hostname = host.trim().toLowerCase();
  if (
    !hostname ||
    hostname.startsWith(".") ||
    hostname.endsWith(".") ||
    hostname.includes("..") ||
    /[^a-z0-9.-]/.test(hostname)
  ) {
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
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  if (url.port && url.port !== "443") {
    throw new HttpError(422, "invalid_args", "push endpoint rejected: non-default port");
  }
  if (url.href !== value && url.href !== `${value}/`) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  const host = url.hostname;
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !isAllowedPushHost(host)) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  return url;
}

export function endpointHash(endpoint: string): string {
  return sha256(Buffer.from(endpoint));
}

export function validateP256Point(bytes: Uint8Array): void {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new HttpError(422, "invalid_args", "push key must be 65-byte uncompressed point");
  }
  try {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(bytes.subarray(1, 33)).toString("base64url"),
        y: Buffer.from(bytes.subarray(33, 65)).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    throw new HttpError(422, "invalid_args", "push key is not a valid P-256 point");
  }
}

export function keyBytes(value: string, length: number): Uint8Array {
  try {
    const bytes = fromBase64url(value, length);
    if (length === 65) {
      validateP256Point(bytes);
    }
    return bytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "push keys rejected");
  }
}

export function parseSubscribeV2(body: Record<string, unknown>): PushSubscribeRequestV2 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, "invalid_args", "invalid body");
  }
  if (!Object.hasOwn(body, "mode") || !Object.hasOwn(body, "if_device_revision")) {
    throw new HttpError(409, "client_upgrade_required", "push subscription requires push_settings_v2 format");
  }
  const allowedKeys = [
    "application_server_key_fingerprint",
    "auth",
    "endpoint",
    "expires_at",
    "if_device_revision",
    "mode",
    "p256dh",
  ];
  const keys = Object.keys(body).sort();
  for (const k of keys) {
    if (!allowedKeys.includes(k)) {
      throw new HttpError(422, "invalid_args", `unexpected property: ${k}`);
    }
  }
  if (body.mode !== "enable" && body.mode !== "refresh") {
    throw new HttpError(422, "invalid_args", "mode must be enable or refresh");
  }
  if (
    typeof body.if_device_revision !== "number" ||
    !Number.isSafeInteger(body.if_device_revision) ||
    body.if_device_revision < 0
  ) {
    throw new HttpError(422, "invalid_args", "if_device_revision must be a non-negative integer");
  }
  if (
    typeof body.application_server_key_fingerprint !== "string" ||
    body.application_server_key_fingerprint.length === 0
  ) {
    throw new HttpError(422, "invalid_args", "application_server_key_fingerprint is required");
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
    else if (typeof body.expires_at === "number" && Number.isSafeInteger(body.expires_at) && body.expires_at >= 0) {
      expires_at = body.expires_at;
    } else {
      throw new HttpError(422, "invalid_args", "invalid expires_at");
    }
  }
  return {
    mode: body.mode,
    if_device_revision: body.if_device_revision,
    application_server_key_fingerprint: body.application_server_key_fingerprint,
    endpoint: body.endpoint,
    p256dh: body.p256dh,
    auth: body.auth,
    expires_at,
  };
}

function ipv4Octets(addr: string): [number, number, number, number] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function isForbiddenIpv4(addr: string): boolean {
  const parts = ipv4Octets(addr);
  if (!parts) return true;
  const [b0, b1, b2] = parts;
  if (b0 === 0) return true;
  if (b0 === 10) return true;
  if (b0 === 127) return true;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  if (b0 === 169 && b1 === 254) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  if (b0 === 192 && b1 === 168) return true;
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  if (b0 >= 224) return true;
  return false;
}

function expandIpv6Groups(addr: string): string[] | null {
  const lower = addr.trim().toLowerCase();
  if (!lower || lower.includes("%")) return null;
  const lastColon = lower.lastIndexOf(":");
  const dotted = lastColon >= 0 ? lower.slice(lastColon + 1) : "";
  let head = lower;
  let ipv4Tail: [number, number, number, number] | null = null;
  if (ipv4Octets(dotted)) {
    ipv4Tail = ipv4Octets(dotted);
    head = lower.slice(0, lastColon);
  }
  const sides = head.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] && sides[0].length > 0 ? sides[0].split(":") : [];
  const right = sides.length === 2 && sides[1] && sides[1].length > 0 ? sides[1].split(":") : [];
  const groups = [...left, ...right];
  if (groups.some((group) => group.length === 0 || group.length > 4 || /[^0-9a-f]/.test(group))) return null;
  const expected = ipv4Tail ? 6 : 8;
  if (sides.length === 1) {
    if (groups.length !== expected) return null;
  } else if (groups.length > expected) {
    return null;
  } else {
    const missing = expected - groups.length;
    groups.splice(left.length, 0, ...Array.from({ length: missing }, () => "0"));
  }
  const expanded = groups.map((group) => group.padStart(4, "0"));
  if (ipv4Tail) {
    expanded.push(((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16).padStart(4, "0"));
    expanded.push(((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16).padStart(4, "0"));
  }
  return expanded.length === 8 ? expanded : null;
}

function ipv6Bytes(addr: string): Uint8Array | null {
  const groups = expandIpv6Groups(addr);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv4FromTail(bytes: Uint8Array): string {
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function prefixEquals(bytes: Uint8Array, prefix: number[], bitLength: number): boolean {
  const fullBytes = Math.floor(bitLength / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== (prefix[i] ?? 0)) return false;
  }
  const remaining = bitLength % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function isForbiddenIpv6(addr: string): boolean {
  const bytes = ipv6Bytes(addr);
  if (!bytes) return true;
  const mapped = prefixEquals(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
  const compatible = prefixEquals(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96) &&
    !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && (bytes[15] === 0 || bytes[15] === 1));
  const nat64 = prefixEquals(bytes, [0x00, 0x64, 0xff, 0x9b], 96);
  if (mapped || compatible || nat64) return isForbiddenIpv4(ipv4FromTail(bytes));
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  return false;
}

export function isPrivateOrForbiddenIp(ip: string): boolean {
  const addr = ip.trim();
  const family = net.isIP(addr);
  if (family === 4) return isForbiddenIpv4(addr);
  if (family === 6) return isForbiddenIpv6(addr);
  return true;
}

type LookupOptions = { all?: boolean };

function assertPublicAddresses(addresses: readonly dns.LookupAddress[]): dns.LookupAddress {
  if (addresses.length === 0) throw new Error("anti_ssrf_dns_empty");
  for (const item of addresses) {
    if (isPrivateOrForbiddenIp(item.address)) throw new Error(`anti_ssrf_forbidden_ip: ${item.address}`);
  }
  return addresses[0]!;
}

/** Resolve every address, reject any forbidden one, and pin the first public address. */
function lookupPinned(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    try {
      const first = assertPublicAddresses(addresses ?? []);
      if (options.all) callback(null, [first]);
      else callback(null, first.address, first.family);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, "", 4);
    }
  });
}

/** CONNECT to the pinned IP. TLS SNI and the Host header stay the endpoint hostname. */
class PinnedHttpsProxyAgent<Uri extends string> extends HttpsProxyAgent<Uri> {
  constructor(proxy: Uri, opts?: HttpsProxyAgentOptions<Uri>) {
    super(proxy, opts);
  }

  override connect(req: import("node:http").ClientRequest, opts: Parameters<HttpsProxyAgent<Uri>["connect"]>[1]) {
    const named = "servername" in opts ? opts.servername : undefined;
    const hostname = named ?? (net.isIP(opts.host ?? "") ? undefined : opts.host);
    if (!hostname || net.isIP(hostname) || !isAllowedPushHost(hostname)) {
      return Promise.reject(new Error("anti_ssrf_forbidden_host"));
    }
    return new Promise<Awaited<ReturnType<HttpsProxyAgent<Uri>["connect"]>>>((resolve, reject) => {
      lookupPinned(hostname, {}, (err, address) => {
        if (err || typeof address !== "string") return reject(err ?? new Error("anti_ssrf_dns_empty"));
        if (!opts.secureEndpoint) return reject(new Error("anti_ssrf_forbidden_host"));
        resolve(super.connect(req, { ...opts, host: address, servername: hostname }));
      });
    });
  }
}

export function createSafePushFetch(): PushFetch {
  const direct = new https.Agent({ keepAlive: false, lookup: lookupPinned });
  const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const urlStr = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
      const url = parsePushEndpoint(urlStr);
      const proxy = getProxyForUrl(url.href);
      let agent: https.Agent = direct;
      if (proxy) {
        let pinned = proxyAgents.get(proxy);
        if (!pinned) {
          pinned = new PinnedHttpsProxyAgent(proxy, { keepAlive: false });
          proxyAgents.set(proxy, pinned);
        }
        agent = pinned;
      }

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = https.request(url, {
        method: init?.method ?? "POST",
        headers: init?.headers as Record<string, string>,
        agent,
        servername: url.hostname,
        signal: init?.signal as AbortSignal | undefined,
      }, (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          res.resume();
          return fail(new HttpError(422, "redirect_forbidden", "redirects are not permitted"));
        }
        let received = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          const buf = Buffer.from(chunk);
          received += buf.length;
          if (received > MAX_PUSH_RESPONSE_BYTES) {
            res.destroy(new Error("response_too_large"));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
        });
        res.on("error", fail);
      });

      req.on("error", fail);
      const signal = init?.signal;
      const onAbort = () => {
        fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        req.destroy();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        req.once("close", () => signal.removeEventListener("abort", onAbort));
      }
      req.on("proxyConnect", (connect: { statusCode?: number }) => {
        if (connect.statusCode !== 200) {
          req.destroy(new Error(`proxy_connect_failed: ${connect.statusCode ?? 0}`));
        }
      });

      if (init?.body) {
        if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
          req.write(Buffer.from(init.body));
        } else if (typeof init.body === "string") {
          req.write(init.body);
        }
      }
      req.end();
    });
  };
}

export function upsertPushSub(
  store: Store,
  deviceId: string,
  input: PushSubscribeMaterials,
  now: number,
  generation: number = 1,
  vapidFingerprint: string | null = null,
): void {
  const expires = input.expires_at === undefined ? null : input.expires_at;
  store.db.run(
    `INSERT INTO remote_push_subs(device_id, endpoint, endpoint_hash, p256dh, auth, expires_at, generation, vapid_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       endpoint = excluded.endpoint, endpoint_hash = excluded.endpoint_hash,
       p256dh = excluded.p256dh, auth = excluded.auth, expires_at = excluded.expires_at,
       generation = excluded.generation, vapid_fingerprint = excluded.vapid_fingerprint`,
    [
      deviceId,
      input.endpoint,
      endpointHash(input.endpoint),
      input.p256dh,
      input.auth,
      expires,
      generation,
      vapidFingerprint,
      now,
    ],
  );
}

export function deletePushSubs(store: Store, deviceId: string | null): void {
  store.transaction(() => {
    store.db.run("DELETE FROM remote_push_subs WHERE ? IS NULL OR device_id = ?", [deviceId, deviceId]);
    if (deviceId === null) {
      store.db.run(
        `UPDATE notification_devices
         SET enabled = 0, push_generation = push_generation + 1, revision = revision + 1
         WHERE receiver_id != 'desktop'`,
      );
      store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
      );
    } else {
      store.db.run(
        `UPDATE notification_devices
         SET enabled = 0, push_generation = push_generation + 1, revision = revision + 1
         WHERE receiver_id = ?`,
        [deviceId],
      );
      store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId],
      );
    }
  });
}

export function pushSub(store: Store, deviceId: string): PushSub | null {
  return store.db.query<PushSub, [string]>("SELECT * FROM remote_push_subs WHERE device_id = ?").get(deviceId);
}

export function livePushSubs(store: Store, now: number): PushSub[] {
  return store.db
    .query<PushSub, [number]>(
      "SELECT * FROM remote_push_subs WHERE expires_at IS NULL OR expires_at > ?",
    )
    .all(now);
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

export function vapidFingerprint(privateKey: Uint8Array): string {
  return sha256(Buffer.from(vapidPublic(privateKey)));
}

function jwtPart(value: object): string {
  return base64url(Buffer.from(JSON.stringify(value)));
}

export function vapidJwt(privateKey: Uint8Array, audience: string, contactUri: string, now: number): string {
  const pub = vapidPublic(privateKey);
  const header = jwtPart({ typ: "JWT", alg: "ES256" });
  const payload = jwtPart({
    aud: audience,
    exp: Math.floor(now / 1000) + VAPID_TTL,
    sub: contactUri,
  });
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

export function pushHeaders(
  endpoint: URL,
  vapidPrivate: Uint8Array,
  contactUri: string = "mailto:real-bot@localhost",
  now: number = Date.now(),
): Record<string, string> {
  const jwt = vapidJwt(vapidPrivate, endpoint.origin, contactUri, now);
  return {
    Authorization: `vapid t=${jwt}, k=${base64url(vapidPublic(vapidPrivate))}`,
    TTL: "60",
    Urgency: "normal",
    Topic: "pending",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
  };
}

export type PushFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PushServiceOptions = {
  store: Store;
  native: Pick<RemoteNativeClient, "read">;
  fetch?: PushFetch;
  now?: () => number;
  trust?: RemoteTrust;
  remoteStatus?: () => { state: string; diagnostic: string | null; devices: number };
  pausedUpgrade?: boolean;
  presence?: PresenceManager;
};

type PushDeliveryRow = {
  delivery_id: string;
  batch_key: string;
  state: string;
  attempt: number;
  absolute_expires_at: number;
  next_attempt_at: number | null;
  push_generation: number;
  trust_generation: number;
};

export class PushService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDueAt = new Map<string, number>();
  private readonly inFlightByDevice = new Map<string, AbortController>();
  private readonly lastTestAtByReceiver = new Map<string, number>();
  private activeGlobalRequests = 0;
  private closed = false;
  private cachedVapidFp: string | null = null;
  readonly pausedUpgrade: boolean;
  private readonly GATE_RETRY_MS = 5_000;
  private readonly CONCURRENCY_RETRY_MS = 250;

  constructor(private readonly options: PushServiceOptions) {
    this.pausedUpgrade = options.pausedUpgrade ?? false;
    void this.vapidFingerprint().catch(() => undefined);
    if (options.trust) {
      options.trust.onInvalidate(() => {
        for (const ctrl of this.inFlightByDevice.values()) {
          ctrl.abort("trust_invalidated");
        }
        this.inFlightByDevice.clear();
      });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryDueAt.clear();
    for (const ctrl of this.inFlightByDevice.values()) {
      ctrl.abort("closed");
    }
    this.inFlightByDevice.clear();
  }

  abortDevice(deviceId: string): void {
    const ctrl = this.inFlightByDevice.get(deviceId);
    if (ctrl) {
      ctrl.abort("device_aborted");
      this.inFlightByDevice.delete(deviceId);
    }
    const timer = this.retryTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(deviceId);
    }
    this.retryDueAt.delete(deviceId);
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  recoverScheduled(): void {
    if (this.pausedUpgrade || this.closed) return;
    const now = this.now();
    this.reclaimStrandedClaimed(now);
    const rows = this.options.store.db
      .query<{ receiver_id: string; next_attempt_at: number | null; next_send_at: number | null }, [number]>(`
        SELECT d.receiver_id, d.next_attempt_at, nd.next_send_at
        FROM notification_deliveries d
        JOIN notification_devices nd ON nd.receiver_id = d.receiver_id
        WHERE d.channel = 'remote_push' AND d.state IN ('pending', 'retry_wait', 'unknown')
          AND d.absolute_expires_at > ?
      `)
      .all(now);
    const devices = new Set(rows.map((row) => row.receiver_id));
    for (const row of rows) {
      const due = Math.max(row.next_attempt_at ?? now, row.next_send_at ?? now);
      this.scheduleDevice(row.receiver_id, due);
    }
    for (const sub of livePushSubs(this.options.store, now)) {
      if (devices.has(sub.device_id)) continue;
      const policy = this.options.store.getNotificationPolicy();
      if (isQuietHoursActive(policy, new Date(now))) {
        const quietEnd = nextQuietHoursEndMs(policy, new Date(now));
        if (quietEnd) this.scheduleDevice(sub.device_id, quietEnd);
      }
    }
    for (const [deviceId, at] of this.retryDueAt) {
      if (at <= now) this.scheduleDevice(deviceId, now);
    }
  }

  async applicationServerKey(): Promise<string> {
    const vapid = await this.options.native.read("vapid");
    try {
      vapidPrivate32(vapid);
      this.cachedVapidFp = vapidFingerprint(vapid);
      return base64url(vapidPublic(vapid));
    } finally {
      vapid.fill(0);
    }
  }

  async vapidFingerprint(): Promise<string> {
    const vapid = await this.options.native.read("vapid");
    try {
      vapidPrivate32(vapid);
      const fp = vapidFingerprint(vapid);
      this.cachedVapidFp = fp;
      return fp;
    } finally {
      vapid.fill(0);
    }
  }

  async publicState(deviceId: string): Promise<PushPublicState> {
    const appServerKey = await this.applicationServerKey();
    const currentFingerprint = await this.vapidFingerprint();
    const sub = pushSub(this.options.store, deviceId);
    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    const contactConfig = this.options.store.getNotificationPushConfig();
    const now = this.now();

    let recovery: PushRecoveryReason = "none";
    if (sub) {
      if (sub.expires_at !== null && sub.expires_at <= now) {
        recovery = "expired";
      } else if (sub.vapid_fingerprint && sub.vapid_fingerprint !== currentFingerprint) {
        recovery = "key_mismatch";
      } else {
        recovery = "none";
      }
    } else {
      if (devRow?.enabled) {
        if (devRow.last_invalid_reason === "gone") recovery = "gone";
        else if (devRow.last_invalid_reason === "expired") recovery = "expired";
        else if (devRow.last_invalid_reason === "key_mismatch") recovery = "key_mismatch";
        else recovery = "registration_missing";
      } else {
        recovery = "none";
      }
    }

    return {
      applicationServerKey: appServerKey,
      subscribed: Boolean(sub),
      enabled: Boolean(devRow?.enabled),
      device_revision: devRow?.revision ?? 0,
      push_generation: devRow?.push_generation ?? 1,
      vapid_key_fingerprint: currentFingerprint,
      recovery,
      current_endpoint_hash: sub ? sub.endpoint_hash : null,
      last_gone_endpoint_hash: devRow?.last_invalid_endpoint_hash ?? null,
      last_error_code: devRow?.last_invalid_reason ?? (sub?.last_diagnostics ?? null),
      contact_configured: contactConfig.contact_configured,
      push_transport: this.pausedUpgrade ? "paused_upgrade" : "policy_v2",
    };
  }

  subscribe(deviceId: string, body: Record<string, unknown>): void {
    if (this.pausedUpgrade) {
      throw new HttpError(409, "capability_unavailable", "push subscription is paused during upgrade");
    }
    if (!this.isRemoteGateOpen()) {
      throw new HttpError(503, "gateway_unavailable", "remote push is not currently available");
    }
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "mode") || !Object.hasOwn(body, "if_device_revision")) {
      throw new HttpError(409, "client_upgrade_required", "push subscription requires push_settings_v2 format");
    }

    const input = parseSubscribeV2(body);
    const now = this.now();
    if (this.cachedVapidFp && input.application_server_key_fingerprint !== this.cachedVapidFp) {
      throw new HttpError(409, "key_mismatch", "application server key fingerprint mismatch");
    }

    this.abortDevice(deviceId);
    this.options.store.transaction(() => {
      const devRow = this.options.store.getNotificationDeviceRow(deviceId);
      const currentRevision = devRow ? devRow.revision : 0;
      const currentGeneration = devRow ? devRow.push_generation : 0;
      const currentEnabled = Boolean(devRow?.enabled);
      const lastGoneHash = devRow?.last_invalid_endpoint_hash ?? null;
      const lastGoneReason = devRow?.last_invalid_reason ?? null;

      if (currentRevision !== input.if_device_revision) {
        throw new HttpError(
          409,
          "revision_conflict",
          `device revision conflict: expected ${input.if_device_revision}, actual ${currentRevision}`,
        );
      }

      const newEndpointHash = endpointHash(input.endpoint);
      const existingConflict = this.options.store.db
        .query<{ device_id: string }, [string, string]>(
          "SELECT device_id FROM remote_push_subs WHERE endpoint_hash = ? AND device_id != ?",
        )
        .get(newEndpointHash, deviceId);
      if (existingConflict) {
        throw new HttpError(409, "endpoint_conflict", "endpoint already registered by another device");
      }
      if (lastGoneHash === newEndpointHash && lastGoneReason === "gone") {
        throw new HttpError(409, "endpoint_gone", "endpoint was previously reported gone");
      }

      const existingSub = pushSub(this.options.store, deviceId);
      if (input.mode === "refresh") {
        if (!currentEnabled) throw new HttpError(409, "not_enabled", "refresh requires device to be enabled");
        if (!existingSub) throw new HttpError(409, "no_subscription", "refresh requires an existing subscription");
        if (lastGoneReason === "gone" || lastGoneReason === "expired" || lastGoneReason === "key_mismatch") {
          throw new HttpError(409, "recovery_required", "device requires explicit enable recovery");
        }
      }

      if (
        currentEnabled &&
        existingSub &&
        existingSub.endpoint === input.endpoint &&
        existingSub.p256dh === input.p256dh &&
        existingSub.auth === input.auth &&
        existingSub.expires_at === (input.expires_at ?? null) &&
        existingSub.vapid_fingerprint === input.application_server_key_fingerprint
      ) {
        return;
      }

      const nextRevision = currentRevision + 1;
      const nextGeneration = currentGeneration + 1;
      this.options.store.db.run(
        `INSERT INTO notification_devices (
          receiver_id, revision, enabled, sound, preview, badge, push_generation,
          last_invalid_endpoint_hash, last_invalid_reason
        ) VALUES (?, ?, 1, 'system', 'generic', 1, ?, NULL, NULL)
        ON CONFLICT(receiver_id) DO UPDATE SET
          revision = excluded.revision,
          enabled = 1,
          push_generation = excluded.push_generation,
          last_invalid_endpoint_hash = NULL,
          last_invalid_reason = NULL`,
        [deviceId, nextRevision, nextGeneration],
      );
      upsertPushSub(this.options.store, deviceId, input, now, nextGeneration, input.application_server_key_fingerprint);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND push_generation < ? AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId, nextGeneration],
      );
    });
  }

  unsubscribe(deviceId: string, body?: Record<string, unknown>): void {
    this.options.store.transaction(() => {
      const devRow = this.options.store.getNotificationDeviceRow(deviceId);
      const currentRevision = devRow ? devRow.revision : 0;
      const currentGeneration = devRow ? devRow.push_generation : 0;
      if (body && typeof body.if_device_revision === "number") {
        if (currentRevision !== body.if_device_revision) {
          throw new HttpError(
            409,
            "revision_conflict",
            `device revision conflict: expected ${body.if_device_revision}, actual ${currentRevision}`,
          );
        }
      }

      const nextRevision = currentRevision + 1;
      const nextGeneration = currentGeneration + 1;
      this.options.store.db.run(
        `INSERT INTO notification_devices (
          receiver_id, revision, enabled, sound, preview, badge, push_generation
        ) VALUES (?, ?, 0, 'system', 'generic', 1, ?)
        ON CONFLICT(receiver_id) DO UPDATE SET
          revision = excluded.revision,
          enabled = 0,
          push_generation = excluded.push_generation`,
        [deviceId, nextRevision, nextGeneration],
      );
      this.options.store.db.run("DELETE FROM remote_push_subs WHERE device_id = ?", [deviceId]);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId],
      );
    });
    this.abortDevice(deviceId);
  }

  async test(deviceId: string): Promise<{ ok: boolean; status: string; error_code?: string | null }> {
    const now = this.now();
    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    if (!devRow || !devRow.enabled) {
      throw new HttpError(409, "push_disabled", "push notifications must be enabled to send a test");
    }
    const sub = pushSub(this.options.store, deviceId);
    if (!sub) throw new HttpError(409, "no_subscription", "no active push subscription for device");
    if (!this.isRemoteGateOpen()) {
      throw new HttpError(503, "gateway_unavailable", "remote push is not currently available");
    }
    if (!this.options.store.getNotificationPushConfig().contact_uri && !this.options.fetch) {
      throw new HttpError(409, "push_contact_required", "operator contact URI is required before sending push");
    }

    const lastTest = this.lastTestAtByReceiver.get(deviceId) ?? 0;
    if (now - lastTest < TEST_RATE_LIMIT_MS) {
      throw new HttpError(429, "rate_limited", "test push rate limited to once per 60 seconds");
    }
    this.lastTestAtByReceiver.set(deviceId, now);

    const deliveryId = ulid();
    this.options.store.db.run(
      `INSERT INTO notification_deliveries (
        delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
        state, attempt, next_attempt_at, absolute_expires_at, claim_token,
        claim_expires_at, push_generation, trust_generation, created_at
      ) VALUES (?, ?, 'remote_push', ?, 0, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        deliveryId,
        deviceId,
        `test:${deliveryId}`,
        ulid(),
        now,
        now + DELIVERY_ABSOLUTE_DEADLINE_MS,
        devRow.push_generation,
        this.currentTrustGeneration(),
        now,
      ],
    );

    if (devRow.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      this.scheduleDevice(deviceId, devRow.next_send_at ?? now);
      return { ok: true, status: "waiting_send_slot" };
    }

    await this.deliverPending(deviceId);
    const row = this.options.store.db
      .query<{ state: string; error_code: string | null }, [string]>("SELECT state, error_code FROM notification_deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    if (row?.state === "accepted") return { ok: true, status: "accepted" };
    if (row?.state === "retry_wait" || row?.state === "claimed" || row?.state === "pending") {
      return { ok: true, status: "queued", error_code: row.error_code };
    }
    throw new HttpError(503, "failed", row?.state ?? "push test was not accepted");
  }

  notify(event: ClientEvent): void {
    if (this.pausedUpgrade || this.closed) return;
    if (event.event !== "notification.upsert") return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, BATCHING_WINDOW_MS);
  }

  async flush(): Promise<void> {
    if (this.pausedUpgrade || this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = this.now();
    const dueFromTimers = [...this.retryDueAt.entries()].filter(([, at]) => at <= now).map(([id]) => id);
    const deviceIds = [
      ...new Set([
        ...livePushSubs(this.options.store, now).map((sub) => sub.device_id),
        ...this.options.store.db
          .query<{ receiver_id: string }, []>(
            "SELECT DISTINCT receiver_id FROM notification_deliveries WHERE channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')",
          )
          .all()
          .map((row) => row.receiver_id),
        ...dueFromTimers,
      ]),
    ];
    if (!deviceIds.length) return;
    const queue = [...deviceIds];
    const workers = Array.from({ length: Math.min(GLOBAL_CONCURRENCY_LIMIT, queue.length) }, async () => {
      while (queue.length) {
        const deviceId = queue.shift();
        if (!deviceId) return;
        await this.deliverPending(deviceId, true);
      }
    });
    await Promise.all(workers);
  }

  private isRemoteGateOpen(): boolean {
    if (!this.options.remoteStatus) return true;
    const status = this.options.remoteStatus().state;
    return !["off", "activation_gated", "native_unavailable", "trust_mismatch"].includes(status);
  }

  private isDeviceTrusted(deviceId: string): boolean {
    if (!this.options.trust) return true;
    try {
      const dev = this.options.trust.device(deviceId);
      const host = this.options.trust.host();
      if (!dev || dev.revoked) return false;
      return dev.generation === host?.generation;
    } catch {
      return false;
    }
  }

  private currentTrustGeneration(): number {
    return this.options.trust?.host()?.generation ?? 1;
  }

  private scheduleDevice(deviceId: string, at: number): void {
    if (this.closed || this.pausedUpgrade) return;
    const now = this.now();
    const due = Math.max(at, now);
    const existingDue = this.retryDueAt.get(deviceId);
    if (existingDue !== undefined && existingDue <= due && existingDue > now && this.retryTimers.has(deviceId)) return;
    this.retryDueAt.set(deviceId, due);
    const existing = this.retryTimers.get(deviceId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1, due - now);
    this.retryTimers.set(
      deviceId,
      setTimeout(() => {
        this.retryTimers.delete(deviceId);
        this.retryDueAt.delete(deviceId);
        void this.deliverPending(deviceId).catch(() => undefined);
      }, delay),
    );
  }

  private reclaimStrandedClaimed(now: number): void {
    const stranded = this.options.store.db
      .query<PushDeliveryRow & { receiver_id: string }, [number]>(`
        SELECT delivery_id, receiver_id, batch_key, state, attempt, absolute_expires_at, next_attempt_at, push_generation, trust_generation
        FROM notification_deliveries
        WHERE channel = 'remote_push' AND state = 'claimed'
      `)
      .all(now);
    for (const row of stranded) {
      if (this.inFlightByDevice.has(row.receiver_id)) continue;
      if (now >= row.absolute_expires_at || row.attempt + 1 >= MAX_DELIVERY_ATTEMPTS) {
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = ?, error_code = 'unknown' WHERE delivery_id = ? AND state = 'claimed'",
          [now >= row.absolute_expires_at ? "expired" : "unknown", row.delivery_id],
        );
        continue;
      }
      const nextSend = this.options.store.getNotificationDeviceRow(row.receiver_id)?.next_send_at ?? now;
      const nextAttemptAt = Math.max(now, nextSend);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'unknown', error_code = 'unknown', next_attempt_at = ?
         WHERE delivery_id = ? AND state = 'claimed'`,
        [nextAttemptAt, row.delivery_id],
      );
    }
  }

  private activeBatch(deviceId: string): { delivery_id: string; state: string } | null {
    return (
      this.options.store.db
        .query<{ delivery_id: string; state: string }, [string]>(`
          SELECT delivery_id, state FROM notification_deliveries
          WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'claimed', 'unknown')
          ORDER BY created_at ASC LIMIT 1
        `)
        .get(deviceId) ?? null
    );
  }

  private deferUntilSendable(deviceId: string, extraAt?: number | null): void {
    const now = this.now();
    const policy = this.options.store.getNotificationPolicy();
    const quietEnd = isQuietHoursActive(policy, new Date(now)) ? nextQuietHoursEndMs(policy, new Date(now)) : null;
    const nextSend = this.options.store.getNotificationDeviceRow(deviceId)?.next_send_at ?? now;
    const due = Math.max(extraAt ?? now, quietEnd ?? now, nextSend, now);
    this.options.store.db.run(
      `UPDATE notification_deliveries SET next_attempt_at = ?
       WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')
         AND (next_attempt_at IS NULL OR next_attempt_at < ?)`,
      [due, deviceId, due],
    );
    this.scheduleDevice(deviceId, due);
  }

  private batchStillEligible(delivery: PushDeliveryRow, deviceId: string, now: number): boolean {
    if (delivery.batch_key.startsWith("test:")) return true;
    const policy = this.options.store.getNotificationPolicy();
    const items = this.options.store.db
      .query<{ id: string; kind: string; session_id: string | null; read_at: string | null; action_state: string }, [string]>(`
        SELECT n.id, n.kind, n.session_id, n.read_at, n.action_state
        FROM notification_delivery_items di
        JOIN notifications n ON n.id = di.notification_id
        WHERE di.delivery_id = ?
      `)
      .all(delivery.delivery_id);
    for (const item of items) {
      if (!policy.categories[item.kind as keyof typeof policy.categories]) continue;
      if ((item.kind === "reply" || item.kind === "routine_result") && item.session_id) {
        if (this.options.store.getSessionNotificationPreference(item.session_id).muted) continue;
      }
      const unreadOrOpen = item.read_at === null || item.action_state === "open";
      if (!unreadOrOpen) continue;
      if (this.options.presence?.isReceiverActiveForeground(deviceId, item.session_id, now)) continue;
      return true;
    }
    return false;
  }

  private requireContactUri(): string | null {
    const configured = this.options.store.getNotificationPushConfig().contact_uri;
    if (configured) return configured;
    if (this.options.fetch) return "mailto:real-bot@localhost";
    return null;
  }

  private selectCandidates(now: number, skipBatchWindow: boolean, deviceId: string): NotificationItem[] {
    const policy = this.options.store.getNotificationPolicy();
    const unread = this.options.store.listNotifications({ filter: "unread", limit: 100 });
    const candidates: NotificationItem[] = [];
    for (const item of unread.items) {
      if (!policy.categories[item.kind]) continue;
      if ((item.kind === "reply" || item.kind === "routine_result") && item.session_id) {
        const pref = this.options.store.getSessionNotificationPreference(item.session_id);
        if (pref.muted) continue;
      }
      if (this.options.presence?.isReceiverActiveForeground(deviceId, item.session_id, now)) continue;
      if (!skipBatchWindow) {
        const createdMs = new Date(item.created_at).getTime();
        if (now - createdMs < BATCHING_WINDOW_MS) continue;
      }
      candidates.push(item);
    }
    return candidates;
  }

  private loadDueDelivery(deviceId: string, now: number): PushDeliveryRow | null {
    return (
      this.options.store.db
        .query<PushDeliveryRow, [string, number, number]>(`
          SELECT delivery_id, batch_key, state, attempt, absolute_expires_at, next_attempt_at, push_generation, trust_generation
          FROM notification_deliveries
          WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND absolute_expires_at > ?
          ORDER BY CASE WHEN batch_key LIKE 'test:%' THEN 1 ELSE 0 END ASC, created_at ASC
          LIMIT 1
        `)
        .get(deviceId, now, now) ?? null
    );
  }

  private markFailed(deliveryId: string, errorCode: string): void {
    this.options.store.db.run(
      "UPDATE notification_deliveries SET state = 'failed', error_code = ? WHERE delivery_id = ? AND state = 'claimed'",
      [errorCode, deliveryId],
    );
  }

  private scheduleRetry(
    delivery: PushDeliveryRow,
    nextAttemptCount: number,
    nextAttemptAt: number,
    errorCode: string,
  ): void {
    if (nextAttemptAt > delivery.absolute_expires_at || nextAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
      this.options.store.db.run(
        `UPDATE notification_deliveries SET state = ?, attempt = ?, error_code = ?
         WHERE delivery_id = ? AND state = 'claimed'`,
        [
          nextAttemptAt > delivery.absolute_expires_at ? "expired" : "failed",
          nextAttemptCount,
          nextAttemptAt > delivery.absolute_expires_at ? "expired" : errorCode,
          delivery.delivery_id,
        ],
      );
      return;
    }
    this.options.store.db.run(
      `UPDATE notification_deliveries
       SET state = 'retry_wait', attempt = ?, next_attempt_at = ?, error_code = ?
       WHERE delivery_id = ? AND state = 'claimed'`,
      [nextAttemptCount, nextAttemptAt, errorCode, delivery.delivery_id],
    );
  }

  private writeDiagnostics(deviceId: string, generation: number, code: string): void {
    this.options.store.db.run(
      "UPDATE notification_devices SET last_diagnostics = ? WHERE receiver_id = ? AND push_generation = ?",
      [code, deviceId, generation],
    );
    this.options.store.db.run(
      "UPDATE remote_push_subs SET last_diagnostics = ? WHERE device_id = ? AND generation = ?",
      [code, deviceId, generation],
    );
  }

  private async deliverPending(deviceId: string, skipBatchWindow = false): Promise<void> {
    if (this.closed || this.pausedUpgrade) return;
    this.reclaimStrandedClaimed(this.now());
    if (!this.isRemoteGateOpen() || !this.isDeviceTrusted(deviceId)) {
      this.scheduleDevice(deviceId, this.now() + this.GATE_RETRY_MS);
      return;
    }

    const contactUri = this.requireContactUri();
    if (!contactUri) {
      this.options.store.db.run(
        "UPDATE notification_devices SET last_diagnostics = 'push_contact_required' WHERE receiver_id = ?",
        [deviceId],
      );
      this.deferUntilSendable(deviceId, this.now() + this.GATE_RETRY_MS);
      return;
    }

    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    if (!devRow || !devRow.enabled) return;
    const sub = pushSub(this.options.store, deviceId);
    if (!sub || sub.generation !== devRow.push_generation) return;
    if (this.inFlightByDevice.has(deviceId)) return;
    if (this.activeGlobalRequests >= GLOBAL_CONCURRENCY_LIMIT) {
      this.deferUntilSendable(deviceId, this.now() + this.CONCURRENCY_RETRY_MS);
      return;
    }

    const now = this.now();
    if (devRow.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      this.scheduleDevice(deviceId, devRow.next_send_at ?? now);
      return;
    }

    const policy = this.options.store.getNotificationPolicy();
    const isQuiet = isQuietHoursActive(policy, new Date(now));
    let delivery = this.loadDueDelivery(deviceId, now);
    const isTest = Boolean(delivery?.batch_key.startsWith("test:"));
    if (!isTest && isQuiet) {
      this.deferUntilSendable(deviceId, nextQuietHoursEndMs(policy, new Date(now)));
      return;
    }

    if (!delivery) {
      if (this.activeBatch(deviceId)) {
        this.deferUntilSendable(deviceId);
        return;
      }
      const candidates = this.selectCandidates(now, skipBatchWindow, deviceId);
      if (candidates.length === 0) {
        if (this.options.presence?.isReceiverActiveForeground(deviceId, null, now)) {
          this.deferUntilSendable(deviceId, now + 1_000);
        }
        return;
      }
      const deliveryId = ulid();
      const absExpiresAt = now + DELIVERY_ABSOLUTE_DEADLINE_MS;
      const highest = candidates[0]!;
      const batchKey = `batch:${deliveryId}`;
      const trustGeneration = this.currentTrustGeneration();
      this.options.store.transaction(() => {
        this.options.store.db.run(
          `INSERT INTO notification_deliveries (
            delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
            state, attempt, next_attempt_at, absolute_expires_at, claim_token,
            claim_expires_at, push_generation, trust_generation, created_at
          ) VALUES (?, ?, 'remote_push', ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?, ?)`,
          [deliveryId, deviceId, batchKey, highest.ordinal, ulid(), now, absExpiresAt, devRow.push_generation, trustGeneration, now],
        );
        for (const item of candidates) {
          this.options.store.db.run(
            "INSERT OR IGNORE INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)",
            [deliveryId, item.id],
          );
        }
      });
      delivery = {
        delivery_id: deliveryId,
        batch_key: batchKey,
        state: "pending",
        attempt: 0,
        absolute_expires_at: absExpiresAt,
        next_attempt_at: now,
        push_generation: devRow.push_generation,
        trust_generation: trustGeneration,
      };
    }

    if (now > delivery.absolute_expires_at) {
      this.options.store.db.run(
        "UPDATE notification_deliveries SET state = 'expired' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
        [delivery.delivery_id],
      );
      return;
    }

    if (!this.batchStillEligible(delivery, deviceId, now)) {
      this.options.store.db.run(
        "UPDATE notification_deliveries SET state = 'suppressed' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
        [delivery.delivery_id],
      );
      return;
    }

    const slot = this.options.store.db.run(
      `UPDATE notification_devices SET last_attempt_at = ?, next_send_at = ?
       WHERE receiver_id = ? AND (last_attempt_at IS NULL OR ? >= next_send_at)`,
      [now, now + SEND_SLOT_INTERVAL_MS, deviceId, now],
    );
    if (slot.changes === 0) {
      this.scheduleDevice(deviceId, this.options.store.getNotificationDeviceRow(deviceId)?.next_send_at ?? now);
      return;
    }
    const claimed = this.options.store.db.run(
      "UPDATE notification_deliveries SET state = 'claimed' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
      [delivery.delivery_id],
    );
    if (claimed.changes === 0) return;

    let vapid: Uint8Array | undefined;
    try {
      vapid = await this.options.native.read("vapid");
      vapidPrivate32(vapid);
    } catch {
      this.markFailed(delivery.delivery_id, "vapid_unavailable");
      return;
    }

    const abortCtrl = new AbortController();
    this.inFlightByDevice.set(deviceId, abortCtrl);
    this.activeGlobalRequests++;
    const timeoutId = setTimeout(() => abortCtrl.abort("timeout"), REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    let fetchError: Error | undefined;
    try {
      let url: URL;
      try {
        url = parsePushEndpoint(sub.endpoint);
      } catch {
        deletePushSubs(this.options.store, deviceId);
        return;
      }
      const p256dh = keyBytes(sub.p256dh, 65);
      const auth = keyBytes(sub.auth, 16);
      const body = encryptPush(Buffer.from(PUSH_PLAINTEXT), p256dh, auth);
      const headers = pushHeaders(url, vapid, contactUri, now);
      const fetchFn = this.options.fetch ?? createSafePushFetch();
      response = await fetchFn(url, {
        method: "POST",
        redirect: "error",
        headers,
        body: Buffer.from(body),
        signal: abortCtrl.signal,
      });
    } catch (err) {
      fetchError = err as Error;
    } finally {
      clearTimeout(timeoutId);
      vapid.fill(0);
      this.activeGlobalRequests--;
      this.inFlightByDevice.delete(deviceId);
      if (this.activeGlobalRequests < GLOBAL_CONCURRENCY_LIMIT) {
        const waiting = [...this.retryDueAt.entries()].sort((a, b) => a[1] - b[1])[0];
        if (waiting) this.scheduleDevice(waiting[0], this.now() + 1);
      }
    }

    const postNow = this.now();
    const postDev = this.options.store.getNotificationDeviceRow(deviceId);
    const postSub = pushSub(this.options.store, deviceId);
    const stillTrusted = this.isDeviceTrusted(deviceId);
    const genMatches =
      postDev?.push_generation === delivery.push_generation &&
      postSub?.generation === delivery.push_generation;
    const trustMatches = delivery.trust_generation === this.currentTrustGeneration();
    const abortReason = abortCtrl.signal.reason;
    const revokeAbort =
      abortReason === "device_aborted" || abortReason === "trust_invalidated" || abortReason === "closed";
    const timedOut =
      abortReason === "timeout" ||
      (fetchError?.name === "AbortError" && !revokeAbort);
    const aborted = revokeAbort || (abortCtrl.signal.aborted && !timedOut);

    if (!stillTrusted || aborted || !trustMatches) {
      this.markFailed(delivery.delivery_id, aborted || !stillTrusted ? "aborted" : "stale_trust");
      this.writeDiagnostics(deviceId, delivery.push_generation, aborted || !stillTrusted ? "aborted" : "stale_trust");
      return;
    }
    if (!genMatches) {
      this.markFailed(delivery.delivery_id, "replaced");
      return;
    }

    if (response && response.status >= 200 && response.status < 300) {
      this.options.store.transaction(() => {
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = 'accepted', attempt = attempt + 1 WHERE delivery_id = ? AND state = 'claimed'",
          [delivery.delivery_id],
        );
        this.writeDiagnostics(deviceId, delivery.push_generation, "accepted");
     });
      return;
    }

    if (response && (response.status === 404 || response.status === 410)) {
      this.options.store.transaction(() => {
        this.options.store.db.run(
          "DELETE FROM remote_push_subs WHERE device_id = ? AND generation = ?",
          [deviceId, delivery.push_generation],
        );
        this.options.store.db.run(
          `UPDATE notification_devices
           SET push_generation = push_generation + 1, revision = revision + 1,
               last_invalid_endpoint_hash = ?, last_invalid_reason = 'gone', last_diagnostics = 'gone'
           WHERE receiver_id = ? AND push_generation = ?`,
          [endpointHash(sub.endpoint), deviceId, delivery.push_generation],
        );
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = 'failed', error_code = 'gone' WHERE delivery_id = ? AND state = 'claimed'",
          [delivery.delivery_id],
        );
      });
      return;
    }

    if (fetchError instanceof HttpError && fetchError.code === "redirect_forbidden") {
      this.markFailed(delivery.delivery_id, "redirect_forbidden");
      this.writeDiagnostics(deviceId, delivery.push_generation, "redirect_forbidden");
      return;
    }

    if (response && response.status === 429) {
      const retryHeader = response.headers.get("Retry-After");
      let retryAfterMs = 5_000;
      if (retryHeader) {
        const seconds = Number(retryHeader);
        if (!Number.isNaN(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
        else {
          const parsedDate = Date.parse(retryHeader);
          if (!Number.isNaN(parsedDate) && parsedDate > postNow) retryAfterMs = parsedDate - postNow;
        }
      }
      const nextAttemptAt = Math.max(postNow + retryAfterMs, postDev?.next_send_at ?? 0);
      this.scheduleRetry(delivery, delivery.attempt + 1, nextAttemptAt, "http_429");
      this.scheduleDevice(deviceId, nextAttemptAt);
      return;
    }

    if (timedOut || fetchError || (response && response.status >= 500)) {
      const nextAttemptCount = delivery.attempt + 1;
      const backoff = nextAttemptCount === 1 ? 5_000 : 20_000;
      const jitter = Math.floor(Math.random() * 1_000);
      const nextAttemptAt = Math.max(postNow + backoff + jitter, postDev?.next_send_at ?? 0);
      const errorCode = timedOut ? "timeout" : response ? `http_${response.status}` : "network_error";
      this.scheduleRetry(delivery, nextAttemptCount, nextAttemptAt, errorCode);
      if (nextAttemptCount < MAX_DELIVERY_ATTEMPTS && nextAttemptAt <= delivery.absolute_expires_at) {
        this.scheduleDevice(deviceId, nextAttemptAt);
      }
      return;
    }

    const errCode = response ? `http_${response.status}` : "error";
    this.markFailed(delivery.delivery_id, errCode);
    this.writeDiagnostics(deviceId, delivery.push_generation, errCode);
  }
}
