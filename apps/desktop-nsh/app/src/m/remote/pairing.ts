import {
  base64url,
  fromBase64url,
  generateIdentity,
  identityPublic,
  openPairingGrant,
  sealPairing,
  type PairingQr,
} from "@real-bot/remote";
import { ApiError } from "../api.ts";
import { hostSigningFingerprint } from "./fingerprint.ts";
import { ulid } from "./ids.ts";
import { saveEnrollment, type StoredEnrollment } from "./idb.ts";
import { parsePairingQr } from "./qr.ts";
import { mailboxPoll, mailboxSubmit, type TransportHooks } from "./transport.ts";

export type PairingProgress =
  | { phase: "scan" }
  | { phase: "confirm"; fingerprint: string; hostId: string; relayOrigin: string; expiresUnix: number }
  | { phase: "waiting" }
  | { phase: "enrolled"; enrollment: StoredEnrollment }
  | { phase: "rejected"; reason: "expired" | "rejected" | "url" | "invalid" | "timeout" };

export type PairingHooks = TransportHooks & {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deviceName?: string;
  uaHint?: string;
  onWaiting?: () => void;
};

const POLL_MS = 10_000;

export function pairingDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "device" : navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS Safari";
  if (/Android/i.test(ua)) return "Android Chrome";
  if (/Macintosh/i.test(ua)) return "Safari";
  return "Browser";
}

export async function pairFromQr(raw: string, hooks: PairingHooks = {}): Promise<PairingProgress> {
  const now = () => Math.floor((hooks.now?.() ?? Date.now()) / 1000);
  const parsed = parsePairingQr(raw, now());
  if (!parsed.ok) return { phase: "rejected", reason: parsed.reason };
  const qr = parsed.qr;
  const keys = generateIdentity();
  const pub = identityPublic(keys);
  const deviceId = ulid();
  const name = hooks.deviceName ?? pairingDeviceName();
  const ua = hooks.uaHint ?? (typeof navigator === "undefined" ? "test" : navigator.userAgent.slice(0, 512));
  const context = { pairingId: qr.pairingId, hostId: qr.hostId, expiresUnix: qr.expiresUnix };
  const envelope = sealPairing(
    {
      device_id: deviceId,
      name,
      ua_hint: ua,
      device_e_pk: base64url(pub.dh),
      device_s_pk: base64url(pub.signing),
      enrollment_pk: base64url(pub.enrollment),
    },
    fromBase64url(qr.secret, 32),
    context,
    now(),
  );
  try {
    await mailboxSubmit(qr, envelope, hooks);
  } catch {
    return { phase: "rejected", reason: "rejected" };
  }
  hooks.onWaiting?.();
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (now() >= qr.expiresUnix) return { phase: "rejected", reason: "expired" };
    let reply: Uint8Array | null;
    try {
      reply = await mailboxPoll(qr, hooks);
    } catch (error) {
      if (error instanceof ApiError) return { phase: "rejected", reason: error.status === 400 ? "expired" : "rejected" };
      return { phase: "rejected", reason: "rejected" };
    }
    if (reply) {
      const grant = openPairingGrant(
        reply,
        fromBase64url(qr.secret, 32),
        context,
        now(),
        fromBase64url(qr.hostSigningPublic, 32),
        {
          hostId: qr.hostId,
          deviceId,
          deviceDhPublic: pub.dh,
          deviceSigningPublic: pub.signing,
          enrollmentPublic: pub.enrollment,
          trustEpoch: qr.trustEpoch,
          protocolVersion: 1,
          relayOrigin: qr.relayOrigin,
          issuedAt: qr.issuedAt,
        },
      ).grant;
      const enrollment: StoredEnrollment = {
        v: 1,
        deviceId,
        hostId: grant.hostId,
        relayOrigin: grant.relayOrigin,
        relayId: qr.relayId,
        trustEpoch: grant.trustEpoch,
        hostDhPublic: qr.hostDhPublic,
        hostSigningPublic: qr.hostSigningPublic,
        dh: base64url(keys.dh),
        signing: base64url(keys.signing),
        enrollment: base64url(keys.enrollment),
        name,
      };
      await saveEnrollment(enrollment);
      return { phase: "enrolled", enrollment };
    }
    await sleep(POLL_MS);
    if (now() >= qr.expiresUnix) return { phase: "rejected", reason: "expired" };
  }
}

export function previewPairing(raw: string, nowUnix = Math.floor(Date.now() / 1000)): PairingProgress {
  const parsed = parsePairingQr(raw, nowUnix);
  if (!parsed.ok) return { phase: "rejected", reason: parsed.reason };
  return {
    phase: "confirm",
    fingerprint: hostSigningFingerprint(parsed.qr.hostSigningPublic),
    hostId: parsed.qr.hostId,
    relayOrigin: parsed.qr.relayOrigin,
    expiresUnix: parsed.qr.expiresUnix,
  };
}

export type { PairingQr };
