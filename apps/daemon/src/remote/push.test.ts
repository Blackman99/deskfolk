import { afterEach, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, createPublicKey, verify as nodeVerify } from "node:crypto";
import { USER_MEMBER, WEB_PUSH_COPY, WEB_PUSH_PAYLOAD, type ClientEvent } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { base64url, fromBase64url } from "@real-bot/remote";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { ulid } from "../ids";
import { PresenceManager } from "../notifications";
import {
  PUSH_ALLOWED_HOSTS, PUSH_PLAINTEXT, PushService, createSafePushFetch,
  deletePushSubs, encryptPush, endpointHash, isAllowedPushHost, livePushSubs, parsePushEndpoint,
  parseSubscribeV2, pushSub, upsertPushSub, validateP256Point, vapidPublic,
  vapidFingerprint, vapidJwt, isPrivateOrForbiddenIp, SEND_SLOT_INTERVAL_MS,
} from "./push";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function vapidBytes(): Uint8Array {
  for (;;) {
    const raw = Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }).d!, "base64url");
    if (raw.length === 32) return new Uint8Array(raw);
  }
}

function uaKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: base64url(new Uint8Array(ecdh.getPublicKey(null, "uncompressed"))), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) };
}

function store() {
  const s = new Store({ endpointKey: memoryKeyStore() });
  cleanup.push(() => s.close());
  return s;
}

function youBot(s: Store) {
  const bot = s.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  return { bot: bot.bot, session: bot.direct_session };
}

function committed(s: Store, work: () => void): ClientEvent[] {
  const events: ClientEvent[] = [];
  const off = s.onCommit((event) => { events.push(event); });
  try { work(); return events; }
  finally { off(); }
}

function assertNoContentLeak(value: string, forbidden: string[]): void {
  const lower = value.toLowerCase();
  for (const item of forbidden) {
    if (item && lower.includes(item.toLowerCase())) throw new Error("push payload leak");
  }
}

function notificationEvent(events: ClientEvent[]): ClientEvent {
  const event = events.find((row) => row.event === "notification.upsert");
  if (!event) throw new Error("missing notification.upsert");
  return event;
}

async function enablePush(
  service: PushService,
  device: string,
  keys: ReturnType<typeof uaKeys>,
  endpoint = apple,
  revision = 0,
): Promise<void> {
  const fp = await service.vapidFingerprint();
  service.subscribe(device, {
    mode: "enable",
    if_device_revision: revision,
    application_server_key_fingerprint: fp,
    endpoint,
    ...keys,
  });
}

function botBot(s: Store) {
  const a = s.createBot({ name: "Alpha", duties: "a", boundaries: "none" });
  const b = s.createBot({ name: "Beta", duties: "b", boundaries: "none" });
  const session = s.createBotDirect(a.bot.id, b.bot.id, null);
  return { a: a.bot, b: b.bot, session };
}

const apple = "https://web.push.apple.com/v1/push/fixture";
const fcm = "https://fcm.googleapis.com/fcm/send/fixture";
const mozilla = "https://updates.push.services.mozilla.com/wpush/v2/fixture";

describe("push endpoint allowlist", () => {
  test("accepts only https Apple, FCM and Mozilla hosts", () => {
    expect(PUSH_ALLOWED_HOSTS).toEqual(["*.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"]);
    expect(parsePushEndpoint(apple).hostname).toBe("web.push.apple.com");
    expect(parsePushEndpoint(fcm).hostname).toBe("fcm.googleapis.com");
    expect(parsePushEndpoint(mozilla).hostname).toBe("updates.push.services.mozilla.com");
    expect(isAllowedPushHost("web.push.apple.com")).toBe(true);
    expect(isAllowedPushHost("push.apple.com")).toBe(false);
    expect(isAllowedPushHost("evil.push.apple.com.attacker.test")).toBe(false);
    expect(isAllowedPushHost("push.apple.com.evil.test")).toBe(false);
    expect(isAllowedPushHost("notpush.apple.com")).toBe(false);
    expect(isAllowedPushHost("fcm.googleapis.com.evil.test")).toBe(false);
    expect(isAllowedPushHost("googleapis.com")).toBe(false);
  });

  test("rejects http, credentials, ports, IPs, redirects-as-urls and unknown hosts", () => {
    const bad = [
      "http://web.push.apple.com/v1",
      "https://user:pass@web.push.apple.com/v1",
      "https://web.push.apple.com:8443/v1",
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://169.254.169.254/latest",
      "https://evil.example/redirect",
      "https://push.apple.com/v1",
      "https://web.push.apple.com.evil.test/v1",
      "https://fcm.googleapis.com.evil.test/fcm",
      "ftp://web.push.apple.com/v1",
    ];
    for (const url of bad) expect(() => parsePushEndpoint(url)).toThrow();
  });
});

describe("push event filter", () => {
  test("canonical notification.upsert covers Bot↔Bot approvals and suppresses Bot↔Bot chatter", () => {
    const s = store();
    const you = youBot(s);
    const them = botBot(s);
    const trigger = s.insertMessage({ sessionId: you.session.id, kind: "user", author: USER_MEMBER, body: "hi" });
    const turn = s.createTurn({ sessionId: you.session.id, botId: you.bot.id, triggerMessageId: trigger.id });
    const youApprovalEvents = committed(s, () => {
      s.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-write", summary: "secret-file.txt by Writer", target: "/tmp/secret-file.txt" });
    });
    expect(youApprovalEvents.some((event) => event.event === "notification.upsert")).toBe(true);

    const chatterEvents = committed(s, () => {
      s.insertMessage({ sessionId: them.session.id, kind: "bot", author: them.a.id, body: "Bot chatter secret-file.txt" });
    });
    expect(chatterEvents.some((event) => event.event === "notification.upsert")).toBe(false);

    const themTrigger = s.insertMessage({ sessionId: them.session.id, kind: "bot", author: them.a.id, body: "need write" });
    const themTurn = s.createTurn({ sessionId: them.session.id, botId: them.a.id, triggerMessageId: themTrigger.id });
    const themApprovalEvents = committed(s, () => {
      s.insertApproval({ turnId: themTurn.id, messageId: null, kind_key: "outside-write", summary: "secret", target: "/tmp/x" });
    });
    expect(themApprovalEvents.some((event) => event.event === "notification.upsert" && event.kind === "approval")).toBe(true);
  });

  test("journal INSERT notifies once; a later reaction upsert does not", () => {
    const s = store();
    const you = youBot(s);
    const them = botBot(s);
    let reply!: ReturnType<Store["insertMessage"]>;
    const inserted = committed(s, () => {
      reply = s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "Done with secret-file.txt" });
    });
    expect(notificationEvent(inserted).event).toBe("notification.upsert");
    const reacted = committed(s, () => { s.putReaction(reply.id, "👍"); });
    expect(reacted.some((event) => event.event === "notification.upsert")).toBe(false);

    const chatterEvents = committed(s, () => {
      s.insertMessage({ sessionId: them.session.id, kind: "bot", author: them.a.id, body: "Bot chatter" });
    });
    expect(chatterEvents.some((event) => event.event === "notification.upsert")).toBe(false);
  });
});

describe("push subscribe store", () => {
  test("stores endpoint URL not only the hash, and revoke/expiry drop the row without inbox", () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    upsertPushSub(s, device, { endpoint: apple, ...keys }, 1_000);
    const row = pushSub(s, device)!;
    expect(row.endpoint).toBe(apple);
    expect(row.endpoint_hash).toHaveLength(64);
    expect(row.endpoint).not.toBe(row.endpoint_hash);
    expect(row.p256dh).toBe(keys.p256dh);
    expect(row.auth).toBe(keys.auth);
    expect(livePushSubs(s, 1_000)).toHaveLength(1);
    upsertPushSub(s, device, { endpoint: fcm, ...keys, expires_at: 2_000 }, 1_000);
    expect(pushSub(s, device)!.endpoint).toBe(fcm);
    expect(livePushSubs(s, 2_000)).toHaveLength(0);
    expect(pushSub(s, device)).not.toBeNull();
    deletePushSubs(s, device);
    expect(pushSub(s, device)).toBeNull();
    expect(s.listApprovals()).toEqual([]);
  });
});

describe("isolated fake push service", () => {
  test("sends only {t:pending} over HTTPS, refuses 3xx, and never includes titles/filenames/Bot names", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    const native = { read: async () => new Uint8Array(vapid) };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const service = new PushService({
      store: s,
      native,
      pausedUpgrade: false,
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (init?.redirect !== "error") throw new Error("redirects must be refused");
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    await enablePush(service, device, keys);
    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "Wrote secret-file.txt for Writer" });
    });
    service.notify(notificationEvent(inserted));
    await service.flush();
    service.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(apple);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    const body = Buffer.from(calls[0]!.init.body as Uint8Array);
    const haystack = `${calls[0]!.url}\n${JSON.stringify(headers)}\n${body.toString("latin1")}\n${PUSH_PLAINTEXT}`;
    assertNoContentLeak(haystack, ["secret-file.txt", "Writer", you.bot.name, "Wrote"]);
    expect(PUSH_PLAINTEXT).toBe(JSON.stringify({ t: "pending" }));
    expect(PUSH_PLAINTEXT).toBe( JSON.stringify(WEB_PUSH_PAYLOAD));
    expect(WEB_PUSH_COPY.zh).toBe("Deskfolk 有待处理事项");
    expect(WEB_PUSH_COPY.en).toBe("Deskfolk has pending items");
    expect(JSON.parse(PUSH_PLAINTEXT)).toEqual({ t: "pending" });
    expect(Object.keys(JSON.parse(PUSH_PLAINTEXT))).toEqual(["t"]);
  });

  test("inserting a bot message may flush once; putReaction does not flush again", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(null, { status: 201 });
      },
    });
    await enablePush(service, ulid(), keys);
    let reply!: ReturnType<Store["insertMessage"]>;
    const inserted = committed(s, () => {
      reply = s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "Wrote secret-file.txt" });
    });
    service.notify(notificationEvent(inserted));
    await service.flush();
    expect(calls).toHaveLength(1);
    const reacted = committed(s, () => { s.putReaction(reply.id, "👍"); });
    for (const event of reacted) service.notify(event);
    await Bun.sleep(300);
    service.close();
    expect(calls).toHaveLength(1);
  });

  test("gone endpoints delete the subscription; inbox rows remain", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    const device = ulid();
    const approval = s.insertApproval({
      turnId: s.createTurn({ sessionId: you.session.id, botId: you.bot.id, triggerMessageId: s.insertMessage({ sessionId: you.session.id, kind: "user", author: USER_MEMBER, body: "go" }).id }).id,
      messageId: null, kind_key: "outside-write", summary: "card", target: "/tmp/x",
    });
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 410 }),
    });
    await enablePush(service, device, keys, mozilla);
    await service.flush();
    service.close();
    expect(pushSub(s, device)).toBeNull();
    expect(s.getApproval(approval.id).status).toBe("pending");
  });

  test("paused upgrade suppresses outbound sends and reports paused_upgrade", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let calls = 0;
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: true,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "message" });
    });
    service.notify(notificationEvent(inserted));
    await service.flush();
    service.close();
    expect( calls).toBe(0);
    const state = await service.publicState(device);
    expect(state.push_transport).toBe("paused_upgrade");
    expect(() => service.subscribe(device, { endpoint: apple, ...keys })).toThrow();
  });

  test("parseSubscribeV2 rejects extra fields and truncated keys", () => {
    const keys = uaKeys();
    expect(() => parseSubscribeV2({ mode: "enable", if_device_revision: 0, application_server_key_fingerprint: "x", endpoint: apple, ...keys, title: "no" })).toThrow();
    expect(() => parseSubscribeV2({ mode: "enable", if_device_revision: 0, application_server_key_fingerprint: "x", endpoint: apple, p256dh: keys.p256dh, auth: "AA" })).toThrow();
    expect(() => parseSubscribeV2({ mode: "enable", if_device_revision: 0, application_server_key_fingerprint: "x", endpoint: "https://evil.example/push", ...keys })).toThrow();
  });

  test("encryptPush produces an aes128gcm record with a 65-byte sender key", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const p256dh = new Uint8Array(ua.getPublicKey(null, "uncompressed"));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const as = createECDH("prime256v1");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const out = encryptPush(Buffer.from(PUSH_PLAINTEXT), p256dh, auth, salt, as);
    expect(out[20]).toBe(65);
    expect(out.length).toBeGreaterThan(21 + 65 + 16);
  });

  test("applicationServerKey is the uncompressed P-256 public of native vapid", async () => {
    const vapid = vapidBytes();
    const s = store();
    const service = new PushService({ store: s, native: { read: async () => new Uint8Array(vapid) } });
    expect(await service.applicationServerKey()).toBe(base64url(vapidPublic(vapid)));
  });
});

function decryptPush(record: Uint8Array, receiverEcdh: ReturnType<typeof createECDH>, auth: Uint8Array): string {
  const buf = Buffer.from(record);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertextAndTag = buf.subarray(21 + idlen);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

  const secret = receiverEcdh.computeSecret(asPublic);
  const receiverPublic = receiverEcdh.getPublicKey(null, "uncompressed");
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(receiverPublic), Buffer.from(asPublic)]);
  const ikm = hkdfSync("sha256", secret, Buffer.from(auth), keyInfo, 32);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const lastIndex = decrypted.lastIndexOf(2);
  return decrypted.subarray(0, lastIndex).toString("utf8");
}

describe("cryptographic interoperability & VAPID verification", () => {
  test("independent receiver decrypts encryptPush output conforming to RFC 8291 / RFC 8188", () => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const p256dh = new Uint8Array(receiver.getPublicKey(null, "uncompressed"));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = JSON.stringify({ t: "pending" });

    const ciphertext = encryptPush(Buffer.from(plaintext), p256dh, auth);
    const decrypted = decryptPush(ciphertext, receiver, auth);
    expect(decrypted).toBe(plaintext);
  });

  test("VAPID JWT structure, aud, exp, and ES256 signature verification", () => {
    const vapid = vapidBytes();
    const pub = vapidPublic(vapid);
    const audience = "https://updates.push.services.mozilla.com";
    const contactUri = "mailto:test@example.com";
    const now = 1_700_000_000_000;

    const jwt = vapidJwt(vapid, audience, contactUri, now);
    const [h, p, s] = jwt.split(".");
    expect(h).toBeTruthy();
    expect(p).toBeTruthy();
    expect(s).toBeTruthy();

    const header = JSON.parse(Buffer.from(h!, "base64url").toString("utf8"));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8"));
    expect(payload.aud).toBe(audience);
    expect(payload.sub).toBe(contactUri);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 12 * 3600);

    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(pub.subarray(1, 33)).toString("base64url"),
        y: Buffer.from(pub.subarray(33, 65)).toString("base64url"),
      },
      format: "jwk",
    });

    const isValid = nodeVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, fromBase64url(s!, 64));
    expect(isValid).toBe(true);
  });
});

describe("push_settings_v2 and generation CAS", () => {
  test("enable mode assigns generation 1, opt-in enabled=true, and device revision 1", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });

    const state = await service.publicState(device);
    expect(state.enabled).toBe(true);
    expect(state.subscribed).toBe(true);
    expect(state.device_revision).toBe(1);
    expect(state.push_generation).toBe(1);
    expect(state.recovery).toBe("none");
    expect(state.push_transport).toBe("policy_v2");
    expect(state.vapid_key_fingerprint).toBe(fp);
    expect(state).not.toHaveProperty("application_server_key_fingerprint");
  });

  test("legacy subscribe body returns 409 client_upgrade_required", () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });

    expect(() => {
      service.subscribe(device, {
        endpoint: apple,
        ...keys,
      });
    }).toThrow();
  });

  test("refresh mode succeeds only when enabled with valid subscription and recovery none", async () => {
    const s = store();
    const device = ulid();
    const keys1 = uaKeys();
    const keys2 = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    const fp = await service.vapidFingerprint();

    // Refresh on un-enabled device fails
    expect(() => {
      service.subscribe(device, {
        mode: "refresh",
        if_device_revision: 0,
        application_server_key_fingerprint: fp,
        endpoint: apple,
        ...keys1,
      });
    }).toThrow();

    // Enable first
    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys1,
    });

    // Refresh with new keys succeeds
    service.subscribe(device, {
      mode: "refresh",
      if_device_revision: 1,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys2,
    });

    const state = await service.publicState(device);
    expect(state.enabled).toBe(true);
    expect(state.device_revision).toBe(2);
    expect(state.push_generation).toBe(2);
    expect(pushSub(s, device)!.p256dh).toBe(keys2.p256dh);
  });

  test("mismatched device revision returns 409 revision_conflict", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });

    expect(() => {
      service.subscribe(device, {
        mode: "enable",
        if_device_revision: 0, // stale revision!
        application_server_key_fingerprint: fp,
        endpoint: apple,
        ...keys,
      });
    }).toThrow();
  });

  test("mismatched application_server_key_fingerprint returns 409 key_mismatch", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    await service.vapidFingerprint();

    expect(() => {
      service.subscribe(device, {
        mode: "enable",
        if_device_revision: 0,
        application_server_key_fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        endpoint: apple,
        ...keys,
      });
    }).toThrow();
  });

  test("safe unsubscribe works with empty body and with if_device_revision CAS", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });

    // CAS conflict on unsubscribe
    expect(() => service.unsubscribe(device, { if_device_revision: 99 })).toThrow();

    // Matching CAS unsubscribe
    service.unsubscribe(device, { if_device_revision: 1 });
    let state = await service.publicState(device);
    expect(state.enabled).toBe(false);
    expect(state.subscribed).toBe(false);
    expect(state.device_revision).toBe(2);
    expect(state.push_generation).toBe(2);

    // Empty body legacy unsubscribe compatibility
    service.unsubscribe(device, {});
    state = await service.publicState(device);
    expect(state.enabled).toBe(false);
    expect(state.device_revision).toBe(3);
    expect(state.push_generation).toBe(3);
  });
});

describe("ABA generation protection and 404/410 gone CAS", () => {
  test("404/410 on current generation deletes subscription and records gone in recovery", async () => {
    const s = store();
    const you = youBot(s);
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 410 }),
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: mozilla,
      ...keys,
    });

    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "test" });
    });
    service.notify(notificationEvent(inserted));
    await service.flush();

    expect(pushSub(s, device)).toBeNull();
    const state = await service.publicState(device);
    expect(state.enabled).toBe(true);
    expect(state.subscribed).toBe(false);
    expect(state.recovery).toBe("gone");
    expect(state.last_gone_endpoint_hash).toBe(endpointHash(mozilla));
  });

  test("404/410 on old generation CANNOT delete replaced subscription (CAS)", async () => {
    const s = store();
    const you = youBot(s);
    const device = ulid();
    const keys1 = uaKeys();
    const keys2 = uaKeys();
    const vapid = vapidBytes();
    let fetchCount = 0;
    let fetchStartedResolve!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { fetchStartedResolve = resolve; });
    let finishFirstFetch!: () => void;
    const finishFirstFetchPromise = new Promise<void>((resolve) => { finishFirstFetch = resolve; });

    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => {
        fetchCount++;
        if (fetchCount === 1) {
          fetchStartedResolve();
          await finishFirstFetchPromise;
          return new Response(null, { status: 410 });
        }
        return new Response(null, { status: 201 });
      },
    });
    const fp = await service.vapidFingerprint();

    // Generation 1
    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: mozilla,
      ...keys1,
    });

    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "test" });
    });
    service.notify(notificationEvent(inserted));

    // Start flush (in-flight generation 1)
    const flushPromise = service.flush();
    await fetchStarted;

    // While generation 1 request is in flight, user re-subscribes (generation 2)
    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 1,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys2,
    });

    // Now let the old 410 response complete
    finishFirstFetch();
    await flushPromise;

    // The subscription must NOT have been deleted!
    const sub = pushSub(s, device);
    expect(sub).not.toBeNull();
    expect(sub!.generation).toBe(2);
    expect(sub!.endpoint).toBe(apple);

    const state = await service.publicState(device);
    expect(state.push_generation).toBe(2);
    expect(state.enabled).toBe(true);
    expect(state.subscribed).toBe(true);
  });
});

describe("strict P-256 curve point, auth, and endpoint validation", () => {
  test("rejects point not on P-256 curve (x=1, y=1)", () => {
    const invalidPoint = Buffer.alloc(65, 1);
    invalidPoint[0] = 0x04;
    expect(() => validateP256Point(invalidPoint)).toThrow();
  });

  test("rejects auth length not 16 bytes", () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });

    expect(() => {
      service.subscribe(device, {
        mode: "enable",
        if_device_revision: 0,
        application_server_key_fingerprint: "x",
        endpoint: apple,
        p256dh: keys.p256dh,
        auth: base64url(new Uint8Array(15)),
      });
    }).toThrow();
  });

  test("rejects duplicate endpoint registration by another device", async () => {
    const s = store();
    const dev1 = ulid();
    const dev2 = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(dev1, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });

    // dev2 tries to register same endpoint
    expect(() => {
      service.subscribe(dev2, {
        mode: "enable",
        if_device_revision: 0,
        application_server_key_fingerprint: fp,
        endpoint: apple,
        ...keys,
      });
    }).toThrow();
  });

  test("rejects re-registering recently gone endpoint on same device", async () => {
    const s = store();
    const you = youBot(s);
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 410 }),
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: mozilla,
      ...keys,
    });

    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "test" });
    });
    service.notify(notificationEvent(inserted));
    await service.flush();

    // Now mozilla isked gone
    expect(() => {
      service.subscribe(device, {
        mode: "enable",
        if_device_revision: 2,
        application_server_key_fingerprint: fp,
        endpoint: mozilla, // same gone endpoint!
        ...keys,
      });
    }).toThrow();

    // Different endpoint works
    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 2,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });
    expect(pushSub(s, device)!.endpoint).toBe(apple);
  });
});

/** The server_name in a TLS ClientHello record, or null when there is none. */
function clientHelloServerName(record: Buffer): string | null {
  // Record header (5), handshake header (4), client version (2), random (32).
  if (record[0] !== 0x16 || record[5] !== 0x01) return null;
  let at = 5 + 4 + 2 + 32;
  at += 1 + record[at]!; // session id
  at += 2 + record.readUInt16BE(at); // cipher suites
  at += 1 + record[at]!; // compression methods
  const end = Math.min(record.length, at + 2 + record.readUInt16BE(at));
  at += 2;
  while (at + 4 <= end) {
    const type = record.readUInt16BE(at);
    const length = record.readUInt16BE(at + 2);
    at += 4;
    // server_name: list length (2), name type (1), name length (2), name.
    if (type === 0x0000) return record.subarray(at + 5, at + 5 + record.readUInt16BE(at + 3)).toString("ascii");
    at += length;
  }
  return null;
}

describe("anti-SSRF and IP validation", () => {
  test("isPrivateOrForbiddenIp rejects loopback, RFC1918, link-local, CGNAT, multicast, IPv6 ULA, IPv4-mapped", () => {
    expect(isPrivateOrForbiddenIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("127.255.255.255")).toBe(true);
    expect(isPrivateOrForbiddenIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrForbiddenIp("192.168.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("100.64.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrForbiddenIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrForbiddenIp("224.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("240.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::")).toBe(true);
    expect(isPrivateOrForbiddenIp("fc00::1")).toBe(true);
    expect(isPrivateOrForbiddenIp("fe80::1")).toBe(true);
    expect(isPrivateOrForbiddenIp("ff02::1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrForbiddenIp("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("::127.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateOrForbiddenIp("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateOrForbiddenIp("2001:db8::1")).toBe(true);

    expect(isPrivateOrForbiddenIp("146.75.45.91")).toBe(false);
    expect(isPrivateOrForbiddenIp("17.0.0.1")).toBe(false);
    expect(isPrivateOrForbiddenIp("2606:4700:4700::1111")).toBe(false);
  });

  test("createSafePushFetch uses DNS-pinned Bun HTTPS and fails closed on loopback", async () => {
    const fetchFn = createSafePushFetch();
    const dns = (await import("node:dns")).default;
    const originalLookup = dns.lookup.bind(dns);
    dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : callback;
      if (hostname === "web.push.apple.com" && typeof cb === "function") {
        const err = new Error("anti_ssrf_forbidden_ip: 127.0.0.1");
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          (cb as (err: Error, addresses: []) => void)(err, []);
        } else {
          (cb as (err: Error, address: string, family: number) => void)(err, "", 4);
        }
        return;
      }
      return originalLookup(hostname as never, options as never, callback as never);
    }) as typeof dns.lookup;
    try {
      await expect(fetchFn("https://web.push.apple.com/v1/push/fixture", { method: "POST", redirect: "error" })).rejects.toThrow(/anti_ssrf/);
    } finally {
      dns.lookup = originalLookup;
    }
  });

  test("createSafePushFetch tunnels the pinned IP through HTTP_PROXY and keeps the endpoint name for TLS", async () => {
    const net = await import("node:net");
    const dns = (await import("node:dns")).default;
    const connects: string[] = [];
    // The proxy opens the tunnel and reads the name the client puts in its TLS ClientHello, then
    // hangs up. Nothing leaves the machine, so this runs the same with or without a real proxy.
    // Assigned from the socket callback, so keep TypeScript from narrowing it to null here.
    let sni = null as string | null;
    const proxy = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let tunnelled = false;
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!tunnelled) {
          const split = buf.indexOf("\r\n\r\n");
          if (split < 0) return;
          const target = /^CONNECT (\S+) HTTP\/1\.[01]/i.exec(buf.subarray(0, split).toString("latin1"))?.[1] ?? "";
          connects.push(target);
          if (target !== "1.1.1.1:443") {
            socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            return;
          }
          tunnelled = true;
          buf = buf.subarray(split + 4);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        }
        if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
          sni = clientHelloServerName(buf);
          socket.destroy();
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy did not bind");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
      no_proxy: process.env.no_proxy,
    };
    const originalLookup = dns.lookup.bind(dns);
    dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : callback;
      if (typeof cb !== "function") return originalLookup(hostname as never, options as never, callback as never);
      if (hostname === "fcm.googleapis.com") {
        const pinned = [{ address: "1.1.1.1", family: 4 }];
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          (cb as (err: null, addresses: typeof pinned) => void)(null, pinned);
        } else {
          (cb as (err: null, address: string, family: number) => void)(null, "1.1.1.1", 4);
        }
        return;
      }
      if (hostname === "web.push.apple.com") {
        const pinned = [{ address: "127.0.0.1", family: 4 }];
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          (cb as (err: null, addresses: typeof pinned) => void)(null, pinned);
        } else {
          (cb as (err: null, address: string, family: number) => void)(null, "127.0.0.1", 4);
        }
        return;
      }
      return originalLookup(hostname as never, options as never, callback as never);
    }) as typeof dns.lookup;
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) delete process.env[key];
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.NO_PROXY = "localhost,127.0.0.1";
    try {
      const fetchFn = createSafePushFetch();
      await expect(fetchFn("https://fcm.googleapis.com/", { method: "GET", redirect: "error" })).rejects.toThrow();
      expect(connects).toEqual(["1.1.1.1:443"]);
      expect(sni).toBe("fcm.googleapis.com");
      await expect(fetchFn("https://web.push.apple.com/v1/push/fixture", { method: "POST", redirect: "error" })).rejects.toThrow(/anti_ssrf/);
      expect(connects).toEqual(["1.1.1.1:443"]);
    } finally {
      dns.lookup = originalLookup;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      proxy.close();
    }
  });

  test("createSafePushFetch skips the proxy for NO_PROXY and fails a rejected CONNECT", async () => {
    const net = await import("node:net");
    const dns = (await import("node:dns")).default;
    let connections = 0;
    const proxy = net.createServer((socket) => {
      connections += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy did not bind");
    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
      no_proxy: process.env.no_proxy,
    };
    const originalLookup = dns.lookup.bind(dns);
    dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : callback;
      if (hostname === "fcm.googleapis.com" && typeof cb === "function") {
        if (process.env.NO_PROXY === "fcm.googleapis.com") {
          const err = Object.assign(new Error("getaddrinfo ENOTFOUND fcm.googleapis.com"), { code: "ENOTFOUND" });
          if (options && typeof options === "object" && (options as { all?: boolean }).all) {
            (cb as (err: Error, addresses: []) => void)(err, []);
          } else {
            (cb as (err: Error, address: string, family: number) => void)(err, "", 4);
          }
          return;
        }
        const pinned = [{ address: "1.1.1.1", family: 4 }];
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          (cb as (err: null, addresses: typeof pinned) => void)(null, pinned);
        } else {
          (cb as (err: null, address: string, family: number) => void)(null, "1.1.1.1", 4);
        }
        return;
      }
      return originalLookup(hostname as never, options as never, callback as never);
    }) as typeof dns.lookup;
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) delete process.env[key];
    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`;
    process.env.NO_PROXY = "fcm.googleapis.com";
    try {
      const fetchFn = createSafePushFetch();
      await expect(fetchFn("https://fcm.googleapis.com/", { method: "GET" })).rejects.toThrow(/ENOTFOUND/);
      expect(connections).toBe(0);
      delete process.env.NO_PROXY;
      await expect(fetchFn("https://fcm.googleapis.com/", { method: "GET" })).rejects.toThrow(/proxy_connect_failed: 403/);
      expect(connections).toBe(1);
      const held = net.createServer((socket) => {
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
      const heldAddress = held.address();
      if (!heldAddress || typeof heldAddress === "string") throw new Error("held proxy did not bind");
      process.env.HTTPS_PROXY = `http://127.0.0.1:${heldAddress.port}`;
      const controller = new AbortController();
      const pending = fetchFn("https://fcm.googleapis.com/", { method: "GET", signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/abort/i);
      held.close();
    } finally {
      dns.lookup = originalLookup;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      proxy.close();
    }
  });
});

describe("rate limit and 120s deadline", () => {
  test("a test after an expired retry sends again without a remote rejection", async () => {
    const s = store();
    const device = ulid();
    const vapid = vapidBytes();
    let now = Date.now();
    let attempts = 0;
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => {
        if (++attempts === 1) throw Object.assign(new Error("timeout"), { name: "AbortError" });
        return new Response(null, { status: 201 });
      },
    });
    cleanup.push(() => service.close());
    await enablePush(service, device, uaKeys());
    expect(await service.test(device)).toMatchObject({ status: "queued", error_code: "timeout" });
    now += 180_000;
    expect(await service.test(device)).toMatchObject({ status: "accepted" });
    expect(attempts).toBe(2);
    expect(s.db.query<{ state: string }, []>("SELECT state FROM notification_deliveries ORDER BY created_at").all())
      .toEqual([{ state: "expired" }, { state: "accepted" }]);
  });

  test("a test during a live retry returns push_pending and preserves the original delivery", async () => {
    const s = store();
    const device = ulid();
    const vapid = vapidBytes();
    let now = Date.now();
    let attempts = 0;
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => {
        attempts++;
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      },
    });
    cleanup.push(() => service.close());
    await enablePush(service, device, uaKeys());
    await service.test(device);
    const before = s.db.query("SELECT * FROM notification_deliveries").all();
    now += 60_000;
    await expect(service.test(device)).rejects.toMatchObject({ status: 409, code: "push_pending" });
    expect(s.db.query("SELECT * FROM notification_deliveries").all()).toEqual(before);
    expect(attempts).toBe(1);
  });

  test.each(["pending", "retry_wait", "unknown", "claimed"])("startup expires a stranded %s delivery at its deadline", async (state) => {
    const s = store();
    const device = ulid();
    const vapid = vapidBytes();
    let now = Date.now();
    const first = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); },
    });
    cleanup.push(() => first.close());
    await enablePush(first, device, uaKeys());
    await first.test(device);
    first.close();
    s.db.run("UPDATE notification_deliveries SET state = ?", [state]);
    now += 120_000;
    const recovered = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => new Response(null, { status: 201 }),
    });
    cleanup.push(() => recovered.close());
    recovered.recoverScheduled();
    expect(s.db.query("SELECT state FROM notification_deliveries").all()).toEqual([{ state: "expired" }]);
    expect(await recovered.test(device)).toMatchObject({ status: "accepted" });
  });

  test("an expired retry also releases automatic notification delivery", async () => {
    const s = store();
    const device = ulid();
    const you = youBot(s);
    const vapid = vapidBytes();
    let now = Date.now();
    let attempts = 0;
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => {
        if (++attempts === 1) throw Object.assign(new Error("timeout"), { name: "AbortError" });
        return new Response(null, { status: 201 });
      },
    });
    cleanup.push(() => service.close());
    await enablePush(service, device, uaKeys());
    await service.test(device);
    now += 120_000;
    s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "a new reply" });
    await service.flush();
    expect(attempts).toBe(2);
    expect(s.db.query("SELECT state FROM notification_deliveries ORDER BY created_at").all())
      .toEqual([{ state: "expired" }, { state: "accepted" }]);
  });

  test("recovery preserves an in-flight delivery even across its deadline", async () => {
    const s = store();
    const device = ulid();
    const vapid = vapidBytes();
    let now = Date.now();
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      now: () => now,
      fetch: async () => { started.resolve(); return response.promise; },
    });
    cleanup.push(() => service.close());
    await enablePush(service, device, uaKeys());
    const sending = service.test(device);
    await started.promise;
    now += 120_000;
    service.recoverScheduled();
    await expect(service.test(device)).rejects.toMatchObject({ code: "push_pending" });
    expect(s.db.query("SELECT state FROM notification_deliveries").all()).toEqual([{ state: "claimed" }]);
    response.resolve(new Response(null, { status: 201 }));
    expect(await sending).toMatchObject({ status: "accepted" });
  });

  test("test reports the timeout that caused a queued retry", async () => {
    const s = store();
    const device = ulid();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); },
    });
    cleanup.push(() => service.close());
    await enablePush(service, device, uaKeys());
    expect(await service.test(device)).toEqual({ ok: true, status: "queued", error_code: "timeout" });
  });
  test("service.test(deviceId) obeys 60s per-device rate limit", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 201 }),
    });
    const fp = await service.vapidFingerprint();

    service.subscribe(device, {
      mode: "enable",
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    });

    const res1 = await service.test(device);
    expect(res1.ok).toBe(true);
    expect(res1.status).toBe("accepted");
    await expect(service.test(device)).rejects.toMatchObject({ code: "rate_limited" });
  });

  test("test() refuses closed remote gates and missing contact without a queued no-op success", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    const open = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 201 }),
      remoteStatus: () => ({ state: "online", diagnostic: null, devices: 1 }),
    });
    await enablePush(open, device, keys);
    open.close();

    const gated = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 201 }),
      remoteStatus: () => ({ state: "activation_gated", diagnostic: "g_pack_not_verified", devices: 0 }),
    });
    await expect(gated.test(device)).rejects.toMatchObject({ code: "gateway_unavailable" });
    gated.close();

    const noContact = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
    });
    await expect(noContact.test(device)).rejects.toMatchObject({ code: "push_contact_required" });
    noContact.close();
  });

  test("subscribe requires an open remote gate; unsubscribe remains available for cleanup", async () => {
    const s = store();
    const device = ulid();
    const keys = uaKeys();
    const vapid = vapidBytes();
    let gate: "activation_gated" | "online" = "activation_gated";
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => new Response(null, { status: 201 }),
      remoteStatus: () => ({ state: gate, diagnostic: null, devices: 0 }),
    });
    const fp = await service.vapidFingerprint();
    const body = {
      mode: "enable" as const,
      if_device_revision: 0,
      application_server_key_fingerprint: fp,
      endpoint: apple,
      ...keys,
    };
    expect(() => service.subscribe(device, body)).toThrow(HttpError);
    try {
      service.subscribe(device, body);
    } catch (error) {
      expect((error as HttpError).code).toBe("gateway_unavailable");
    }
    expect(pushSub(s, device)).toBeNull();

    gate = "online";
    service.subscribe(device, body);
    expect(pushSub(s, device)?.endpoint).toBe(apple);

    gate = "activation_gated";
    service.unsubscribe(device, { if_device_revision: 1 });
    expect(pushSub(s, device)).toBeNull();
    expect(s.getNotificationDevice(device).enabled).toBe(false);
    service.close();
  });

  test("flush honors the shared 30s send slot and retry_wait next_attempt_at", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    const calls: number[] = [];
    let now = 100_000;
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push(now);
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    await enablePush(service, device, keys);
    const first = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "first" });
    });
    service.notify(notificationEvent(first));
    await service.flush();
    expect(calls).toEqual([100_000]);

    now = 105_000;
    const second = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "second" });
    });
    service.notify(notificationEvent(second));
    await service.flush();
    expect(calls).toEqual([100_000]);

    now = 100_000 + SEND_SLOT_INTERVAL_MS;
    await service.flush();
    expect(calls).toEqual([100_000, 130_000]);
    service.close();
  });

  test("timeouts retry instead of aborting, redirects are fatal, and trust is rechecked after await", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 200_000;
    const timeoutService = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      },
    });
    const timeoutDevice = ulid();
    await enablePush(timeoutService, timeoutDevice, keys);
    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "timeout" });
    });
    timeoutService.notify(notificationEvent(inserted));
    await timeoutService.flush();
    const timeoutRow = s.db.query<{ state: string; error_code: string | null; attempt: number }, [string]>(
      "SELECT state, error_code, attempt FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(timeoutDevice);
    expect(timeoutRow?.state).toBe("retry_wait");
    expect(timeoutRow?.error_code).toBe("timeout");
    expect(timeoutRow?.attempt).toBe(1);
    timeoutService.close();

    const redirectService = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      fetch: async () => {
        throw new HttpError(422, "redirect_forbidden", "redirects are not permitted");
      },
    });
    const redirectDevice = ulid();
    await enablePush(redirectService, redirectDevice, keys, fcm);
    const redirected = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "redirect" });
    });
    redirectService.notify(notificationEvent(redirected));
    await redirectService.flush();
    const redirectRow = s.db.query<{ state: string; error_code: string | null }, [string]>(
      "SELECT state, error_code FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(redirectDevice);
    expect(redirectRow?.state).toBe("failed");
    expect(redirectRow?.error_code).toBe("redirect_forbidden");
    redirectService.close();
  });

  test("recoverScheduled wakes due retry_wait deliveries after restart", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 400_000;
    const calls: number[] = [];
    const first = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push(now);
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      },
    });
    const device = ulid();
    await enablePush(first, device, keys);
    const inserted = committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "retry" });
    });
    first.notify(notificationEvent(inserted));
    await first.flush();
    const waiting = s.db.query<{ state: string; next_attempt_at: number | null }, [string]>(
      "SELECT state, next_attempt_at FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(device);
    expect(waiting?.state).toBe("retry_wait");
    first.close();

    now = Math.max(now + SEND_SLOT_INTERVAL_MS, (waiting?.next_attempt_at ?? now) + 1);
    const recovered = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push(now);
        return new Response(null, { status: 201 });
      },
    });
    recovered.recoverScheduled();
    await recovered.flush();
    const accepted = s.db.query<{ state: string }, [string]>(
      "SELECT state FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(device);
    expect(accepted?.state).toBe("accepted");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    recovered.close();
  });

  test("recoverScheduled reclaims stranded claimed without a second batch", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 500_000;
    const calls: string[] = [];
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push("send");
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    await enablePush(service, device, keys);
    committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "claimed-crash" });
    });
    const notif = s.listNotifications({ filter: "unread", limit: 1 }).items[0]!;
    const deliveryId = ulid();
    s.db.run(
      `INSERT INTO notification_deliveries (
        delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
        state, attempt, next_attempt_at, absolute_expires_at, push_generation, trust_generation, error_code, created_at
      ) VALUES (?, ?, 'remote_push', ?, ?, ?, 'claimed', 0, NULL, ?, 1, 1, NULL, ?)`,
      [deliveryId, device, `batch:${deliveryId}`, notif.ordinal, ulid(), now + 120_000, now],
    );
    s.db.run("INSERT INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)", [deliveryId, notif.id]);
    service.recoverScheduled();
    const afterRecover = s.db.query<{ state: string; error_code: string | null }, [string]>(
      "SELECT state, error_code FROM notification_deliveries WHERE delivery_id = ?",
    ).get(deliveryId);
    expect(afterRecover?.state).toBe("unknown");
    expect(afterRecover?.error_code).toBe("unknown");
    now = now + SEND_SLOT_INTERVAL_MS;
    await service.flush();
    const rows = s.db.query<{ state: string; delivery_id: string }, [string]>(
      "SELECT state, delivery_id FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at ASC",
    ).all(device);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery_id).toBe(deliveryId);
    expect(rows[0]!.state).toBe("accepted");
    expect(calls).toEqual(["send"]);
    service.close();
  });

  test("quiet hours schedule quiet-end once and do not spin due retries", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = Date.parse("2026-09-22T23:30:00Z");
    const calls: number[] = [];
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push(now);
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    await enablePush(service, device, keys);
    s.updateNotificationPolicy({
      if_revision: 1,
      quiet_hours: { enabled: true, start: "22:00", end: "08:00", time_zone: "UTC" },
    });
    committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "quiet-first" });
    });
    await service.flush();
    expect(calls).toEqual([]);
    expect(s.db.query("SELECT 1 FROM notification_deliveries WHERE receiver_id = ?").get(device)).toBeNull();

    const dueId = ulid();
    const notif = s.listNotifications({ filter: "unread", limit: 1 }).items[0]!;
    s.db.run(
      `INSERT INTO notification_deliveries (
        delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
        state, attempt, next_attempt_at, absolute_expires_at, push_generation, trust_generation, error_code, created_at
      ) VALUES (?, ?, 'remote_push', ?, ?, ?, 'retry_wait', 1, ?, ?, 1, 1, NULL, ?)`,
      [dueId, device, `batch:${dueId}`, notif.ordinal, ulid(), now, Date.parse("2026-09-23T08:30:00Z"), now],
    );
    s.db.run("INSERT INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)", [dueId, notif.id]);
    service.recoverScheduled();
    await Bun.sleep(25);
    expect(calls).toEqual([]);
    const stillWaiting = s.db.query<{ state: string }, [string]>("SELECT state FROM notification_deliveries WHERE delivery_id = ?").get(dueId);
    expect(stillWaiting?.state).toBe("retry_wait");

    now = Date.parse("2026-09-23T08:00:00Z");
    const dueAfter = s.db.query<{ next_attempt_at: number | null }, [string]>(
      "SELECT next_attempt_at FROM notification_deliveries WHERE delivery_id = ?",
    ).get(dueId);
    expect(dueAfter?.next_attempt_at ?? 0).toBeLessThanOrEqual(now);
    await service.flush();
    expect(calls).toEqual([now]);
    service.close();
  });

  test("gate-closed recover does not lose the fifth pending after status opens", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 600_000;
    let gate: "off" | "online" = "online";
    const started: string[] = [];
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      remoteStatus: () => ({ state: gate, diagnostic: null, devices: 0 }),
      fetch: async (input) => {
        started.push(String(input));
       return new Response(null, { status: 201 });
      },
    });
    const devices: string[] = [];
    const hosts = [
      apple,
      mozilla,
      fcm,
      "https://web.push.apple.com/v1/push/a",
      "https://web.push.apple.com/v1/push/b",
    ];
    for (let i = 0; i < 5; i++) {
      const device = ulid();
      devices.push(device);
      await enablePush(service, device, keys, hosts[i]);
      committed(s, () => {
        s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: `n${i}` });
      });
      const item = s.listNotifications({ filter: "unread", limit: 10 }).items[i]!;
      const deliveryId = ulid();
      s.db.run(
        `INSERT INTO notification_deliveries (
          delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
          state, attempt, next_attempt_at, absolute_expires_at, push_generation, trust_generation, error_code, created_at
        ) VALUES (?, ?, 'remote_push', ?, ?, ?, 'pending', 0, ?, ?, 1, 1, NULL, ?)`,
        [deliveryId, device, `batch:${deliveryId}`, item.ordinal, ulid(), now, now + 120_000, now],
      );
      s.db.run("INSERT OR IGNORE INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)", [deliveryId, item.id]);
    }
    started.length = 0;
    gate = "off";
    service.recoverScheduled();
    await Bun.sleep(20);
    expect(started).toHaveLength(0);
    gate = "online";
    now = now + 5_000;
    await service.flush();
    expect(started.length).toBeGreaterThanOrEqual(4);
    if (started.length < 5) {
      now = now + 250;
      await service.flush();
    }
    expect(started).toHaveLength(5);
    service.close();
  });

  test("retry suppresses after the item is read instead of occupying another slot", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 700_000;
    const calls: number[] = [];
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      fetch: async () => {
        calls.push(now);
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      },
    });
    const device = ulid();
    await enablePush(service, device, keys);
    committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "will-read" });
    });
    await service.flush();
    expect(calls).toEqual([700_000]);
    const waiting = s.db.query<{ delivery_id: string; state: string }, [string]>(
      "SELECT delivery_id, state FROM notification_deliveries WHERE receiver_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(device);
    expect(waiting?.state).toBe("retry_wait");
    s.db.run("UPDATE notifications SET read_at = created_at WHERE read_at IS NULL");
    now = now + SEND_SLOT_INTERVAL_MS + 20_000;
    await service.flush();
    const after = s.db.query<{ state: string }, [string]>("SELECT state FROM notification_deliveries WHERE delivery_id = ?").get(waiting!.delivery_id);
    expect(after?.state).toBe("suppressed");
    expect(calls).toEqual([700_000]);
    service.close();
  });

  test("focused PWA presence suppresses only that device", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    let now = 800_000;
    const calls: string[] = [];
    const presence = new PresenceManager();
    const focused = ulid();
    const background = ulid();
    presence.update(focused, { instance_id: "pwa-1", visible: true, focused: true, session_id: you.session.id, at_latest: true }, now);
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      pausedUpgrade: false,
      now: () => now,
      presence,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 201 });
      },
    });
    await enablePush(service, focused, keys, apple);
    await enablePush(service, background, keys, mozilla);
    committed(s, () => {
      s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "presence" });
    });
    await service.flush();
    expect(calls).toEqual([mozilla]);
    const focusedRow = s.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM notification_deliveries WHERE receiver_id = ?",
    ).get(focused);
    expect(focusedRow?.count).toBe(0);
    service.close();
  });
});
