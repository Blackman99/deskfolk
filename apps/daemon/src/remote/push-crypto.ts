/** VAPID signing and Web Push payload encryption (RFC 8291 aes128gcm). */
import { base64url } from "@real-bot/remote";
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, sign as nodeSign } from "node:crypto";
import { HttpError } from "../errors";
import { sha256 } from "../request-digest";

const KEY_INFO = Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0])]);
const CEK_INFO = Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0])]);
const NONCE_INFO = Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0])]);
const RECORD_SIZE = 4096;
const VAPID_TTL = 12 * 3600;

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
