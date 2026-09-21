import { decodePairingCode, fromBase64url, PAIRING_CODE_PREFIX, type PairingQr } from "@real-bot/remote";
import { isUlid } from "./ids.ts";
import { httpsOrigin } from "./origin.ts";

/** The page's own origin is the relay: a pasted code can never aim this device somewhere else. */
function readerOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

export type PairingParse =
  | { ok: true; qr: PairingQr }
  | { ok: false; reason: "url" | "invalid" | "expired" };

/**
 * Pairing material is out-of-band, never a navigable URL. Two shapes are accepted: the compact
 * `rb1…` code a host hands out today, and the original JSON, so an offer copied before the
 * shortening still pairs.
 */
export function parsePairingQr(raw: string, nowUnix = Math.floor(Date.now() / 1000), origin = readerOrigin()): PairingParse {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "invalid" };
  if (/^\s*https?:\/\//i.test(text) || /[?&#]/.test(text.split(/\s/)[0] ?? "")) {
    return { ok: false, reason: "url" };
  }
  if (text.startsWith(PAIRING_CODE_PREFIX)) {
    try {
      return fresh(decodePairingCode(text, httpsOrigin(origin)), nowUnix);
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid" };
  const qr = value as Partial<PairingQr>;
  if (qr.v !== 1) return { ok: false, reason: "invalid" };
  if (!isUlid(String(qr.pairingId ?? "")) || !isUlid(String(qr.hostId ?? ""))) return { ok: false, reason: "invalid" };
  if (typeof qr.relayId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(qr.relayId)) return { ok: false, reason: "invalid" };
  if (typeof qr.trustEpoch !== "number" || !Number.isInteger(qr.trustEpoch) || qr.trustEpoch < 0) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof qr.expiresUnix !== "number" || typeof qr.issuedAt !== "number") return { ok: false, reason: "invalid" };
  try {
    httpsOrigin(String(qr.relayOrigin ?? ""));
    fromBase64url(String(qr.hostDhPublic ?? ""), 32);
    fromBase64url(String(qr.hostSigningPublic ?? ""), 32);
    fromBase64url(String(qr.secret ?? ""), 32);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed: PairingQr = {
    v: 1,
    pairingId: qr.pairingId as string,
    hostId: qr.hostId as string,
    expiresUnix: qr.expiresUnix,
    relayOrigin: qr.relayOrigin as string,
    relayId: qr.relayId,
    hostDhPublic: qr.hostDhPublic as string,
    hostSigningPublic: qr.hostSigningPublic as string,
    trustEpoch: qr.trustEpoch,
    issuedAt: qr.issuedAt,
    secret: qr.secret as string,
  };
  return fresh(parsed, nowUnix);
}

/** One window rule for both shapes: inside its ten minutes, and not stretched past them. */
function fresh(qr: PairingQr, nowUnix: number): PairingParse {
  if (nowUnix >= qr.expiresUnix || qr.expiresUnix - qr.issuedAt > 600) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, qr };
}
