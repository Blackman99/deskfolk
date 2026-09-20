import { afterEach, expect, test } from "bun:test";
import {
  base64url,
  fromBase64url,
  generateIdentity,
  identityPublic,
  openPairing,
  sealPairingGrant,
  signGrant,
  type PairingQr,
} from "@real-bot/remote";
import { hostSigningFingerprint } from "./fingerprint.ts";
import { parsePairingQr } from "./qr.ts";
import { pairFromQr, previewPairing } from "./pairing.ts";
import { memoryEnrollment, useEnrollmentDriver } from "./idb.ts";
import { shouldCacheRequest } from "./sw-policy.ts";

const now = 1_700_000_000;
const host = generateIdentity();
const hostPub = identityPublic(host);

function qr(over: Partial<PairingQr> = {}): PairingQr {
  return {
    v: 1,
    pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    expiresUnix: now + 120,
    relayOrigin: "https://relay.example.test",
    relayId: "fixture",
    hostDhPublic: base64url(hostPub.dh),
    hostSigningPublic: base64url(hostPub.signing),
    trustEpoch: 1,
    issuedAt: now,
    secret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    ...over,
  };
}

afterEach(() => useEnrollmentDriver(null));

test("pairing JSON that looks like a URL is rejected and never stored", () => {
  expect(parsePairingQr("https://relay.example.test/?p=/etc/passwd", now)).toEqual({ ok: false, reason: "url" });
  expect(previewPairing("https://evil.test/?secret=1", now).phase).toBe("rejected");
});

test("expired pairing windows fail closed", () => {
  const payload = JSON.stringify(qr({ expiresUnix: now - 1 }));
  expect(parsePairingQr(payload, now).ok).toBe(false);
  expect(previewPairing(payload, now)).toMatchObject({ phase: "rejected", reason: "expired" });
});

test("preview shows the full host signing fingerprint", () => {
  const payload = qr();
  const preview = previewPairing(JSON.stringify(payload), now);
  expect(preview).toMatchObject({
    phase: "confirm",
    fingerprint: hostSigningFingerprint(payload.hostSigningPublic),
    relayOrigin: payload.relayOrigin,
  });
  if (preview.phase === "confirm") expect(preview.fingerprint).toHaveLength(64);
});

test("mailbox network failure does not persist enrollment", async () => {
  const store = memoryEnrollment();
  useEnrollmentDriver(store);
  const result = await pairFromQr(JSON.stringify(qr()), {
    now: () => now * 1000,
    sleep: async () => {},
    fetch: (async () => { throw new TypeError("failed to fetch"); }) as typeof fetch,
  });
  expect(result.phase).toBe("rejected");
  expect(await store.get()).toBeNull();
});

test("pairing poll that outlives the window expires without storing enrollment", async () => {
  const store = memoryEnrollment();
  useEnrollmentDriver(store);
  const payload = qr({ expiresUnix: now + 1 });
  let clock = now * 1000;
  const result = await pairFromQr(JSON.stringify(payload), {
    now: () => clock,
    sleep: async () => { clock = (now + 2) * 1000; },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { op: string };
      if (body.op === "submit") return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response(JSON.stringify({ pending: true }), { status: 202 });
    }) as typeof fetch,
  });
  expect(result).toMatchObject({ phase: "rejected", reason: "expired" });
  expect(await store.get()).toBeNull();
});

test("mailbox reject does not persist enrollment", async () => {
  const store = memoryEnrollment();
  useEnrollmentDriver(store);
  const payload = qr();
  const result = await pairFromQr(JSON.stringify(payload), {
    now: () => now * 1000,
    sleep: async () => {},
    fetch: (async () => new Response(JSON.stringify({ error: "rejected" }), { status: 400 })) as typeof fetch,
  });
  expect(result.phase).toBe("rejected");
  expect(await store.get()).toBeNull();
});

test("successful grant is stored as pairing identity only", async () => {
  const store = memoryEnrollment();
  useEnrollmentDriver(store);
  const payload = qr();
  const context = { pairingId: payload.pairingId, hostId: payload.hostId, expiresUnix: payload.expiresUnix };
  let reply: string | null = null;
  const result = await pairFromQr(JSON.stringify(payload), {
    now: () => now * 1000,
    sleep: async () => {},
    deviceName: "Fixture",
    uaHint: "test",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { op: string; ciphertext?: string };
      if (body.op === "submit") {
        const request = openPairing(fromBase64url(body.ciphertext!), fromBase64url(payload.secret, 32), context, now);
        const grant = {
          hostId: payload.hostId,
          deviceId: request.device_id,
          deviceDhPublic: fromBase64url(request.device_e_pk, 32),
          deviceSigningPublic: fromBase64url(request.device_s_pk, 32),
          enrollmentPublic: fromBase64url(request.enrollment_pk, 32),
          trustEpoch: payload.trustEpoch,
          protocolVersion: 1,
          relayOrigin: payload.relayOrigin,
          issuedAt: payload.issuedAt,
        };
        reply = base64url(sealPairingGrant({ grant, signature: signGrant(grant, host.signing) }, fromBase64url(payload.secret, 32), context, now));
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response(JSON.stringify({ ciphertext: reply }), { status: 200 });
    }) as typeof fetch,
  });
  expect(result.phase).toBe("enrolled");
  const saved = await store.get() as { deviceId: string; dh: string; transcript?: unknown };
  expect(saved.deviceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(saved.transcript).toBeUndefined();
});

test("service worker policy caches immutable assets only", () => {
  expect(shouldCacheRequest({ method: "GET", mode: "same-origin", url: "https://relay.test/_app/immutable/entry.js" })).toBe(true);
  expect(shouldCacheRequest({ method: "GET", mode: "navigate", url: "https://relay.test/" })).toBe(false);
  expect(shouldCacheRequest({ method: "GET", mode: "same-origin", url: "https://relay.test/index.html" })).toBe(false);
  expect(shouldCacheRequest({ method: "POST", mode: "same-origin", url: "https://relay.test/_app/immutable/entry.js" })).toBe(false);
});

test("enrollment driver rejects transcript-like records", () => {
  const store = memoryEnrollment();
  expect(() => store.set({
    v: 1, deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    relayOrigin: "https://relay.example.test", relayId: "x", trustEpoch: 1,
    hostDhPublic: base64url(hostPub.dh), hostSigningPublic: base64url(hostPub.signing),
    dh: base64url(hostPub.dh), signing: base64url(hostPub.signing), enrollment: base64url(hostPub.enrollment),
    name: "ok", transcript: "secret",
  } as never)).toThrow();
});
