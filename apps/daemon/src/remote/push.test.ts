import { afterEach, describe, expect, test } from "bun:test";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { INTERRUPT_NOTE_BODY, USER_MEMBER, WEB_PUSH_COPY, WEB_PUSH_PAYLOAD, type ClientEvent } from "@real-bot/protocol";
import { base64url } from "@real-bot/remote";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { ulid } from "../ids";
import {
  PUSH_ALLOWED_HOSTS, PUSH_PLAINTEXT, PUSH_VISIBLE_COPY, PushService, assertNoContentLeak,
  deletePushSubs, encryptPush, isAllowedPushHost, livePushSubs, parsePushEndpoint, parseSubscribe,
  pushSub, shouldNotify, upsertPushSub, vapidPublic,
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
  test("notifies approval, ask, error, interrupt and user-facing final replies; suppresses Bot↔Bot", () => {
    const s = store();
    const you = youBot(s);
    const them = botBot(s);
    const trigger = s.insertMessage({ sessionId: you.session.id, kind: "user", author: USER_MEMBER, body: "hi" });
    const turn = s.createTurn({ sessionId: you.session.id, botId: you.bot.id, triggerMessageId: trigger.id });
    const approval = s.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-write", summary: "secret-file.txt by Writer", target: "/tmp/secret-file.txt" });
    const pending: ClientEvent = { event: "approval.upsert", occurred_at: "now", ...approval };
    expect(shouldNotify(s, pending)).toBe(true);
    expect(shouldNotify(s, { ...pending, status: "denied" })).toBe(false);

    const ask = s.insertMessage({ sessionId: you.session.id, kind: "ask", author: you.bot.id, body: "Need secret-file.txt?" });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...ask })).toBe(true);
    const reply = s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "Done with secret-file.txt" });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...reply })).toBe(true);
    const error = s.insertMessage({ sessionId: you.session.id, kind: "system", author: you.bot.id, body: "这一轮没写完：端点出错" });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...error })).toBe(true);
    const interrupt = s.insertMessage({ sessionId: you.session.id, kind: "system", author: you.bot.id, body: INTERRUPT_NOTE_BODY });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...interrupt })).toBe(false);
    expect(shouldNotify(s, { event: "turn.upsert", occurred_at: "now", ...turn, status: "interrupted" })).toBe(true);
    expect(shouldNotify(s, { event: "turn.upsert", occurred_at: "now", ...turn, status: "completed" })).toBe(false);
    const user = s.insertMessage({ sessionId: you.session.id, kind: "user", author: USER_MEMBER, body: "hi" });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...user })).toBe(false);

    const chatter = s.insertMessage({ sessionId: them.session.id, kind: "bot", author: them.a.id, body: "Bot chatter secret-file.txt" });
    expect(shouldNotify(s, { event: "message.created", occurred_at: "now", ...chatter })).toBe(false);
    const themTurn = s.createTurn({ sessionId: them.session.id, botId: them.a.id, triggerMessageId: chatter.id });
    const themApproval = s.insertApproval({ turnId: themTurn.id, messageId: null, kind_key: "outside-write", summary: "secret", target: "/tmp/x" });
    expect(shouldNotify(s, { event: "approval.upsert", occurred_at: "now", ...themApproval })).toBe(false);
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
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (init?.redirect !== "error") throw new Error("redirects must be refused");
        return new Response(null, { status: 201 });
      },
    });
    const device = ulid();
    upsertPushSub(s, device, { endpoint: apple, ...keys }, 1);
    const reply = s.insertMessage({ sessionId: you.session.id, kind: "bot", author: you.bot.id, body: "Wrote secret-file.txt for Writer" });
    service.notify({ event: "message.created", occurred_at: "now", ...reply });
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
    expect(PUSH_PLAINTEXT).toBe(JSON.stringify(WEB_PUSH_PAYLOAD));
    expect(PUSH_VISIBLE_COPY.zh).toBe("Real Bot 有待处理事项");
    expect(PUSH_VISIBLE_COPY.en).toBe("Real Bot has pending items");
    expect(JSON.parse(PUSH_PLAINTEXT)).toEqual({ t: "pending" });
    expect(Object.keys(JSON.parse(PUSH_PLAINTEXT))).toEqual(["t"]);

    const redirected = new PushService({
      store: s,
      native,
      fetch: async () => { throw new TypeError("redirect"); },
    });
    await redirected.flush();
    expect(pushSub(s, device)).not.toBeNull();
  });

  test("gone endpoints delete the subscription; inbox rows remain", async () => {
    const s = store();
    const you = youBot(s);
    const keys = uaKeys();
    const vapid = vapidBytes();
    const device = ulid();
    upsertPushSub(s, device, { endpoint: mozilla, ...keys }, 1);
    const approval = s.insertApproval({
      turnId: s.createTurn({ sessionId: you.session.id, botId: you.bot.id, triggerMessageId: s.insertMessage({ sessionId: you.session.id, kind: "user", author: USER_MEMBER, body: "go" }).id }).id,
      messageId: null, kind_key: "outside-write", summary: "card", target: "/tmp/x",
    });
    const service = new PushService({
      store: s,
      native: { read: async () => new Uint8Array(vapid) },
      fetch: async () => new Response(null, { status: 410 }),
    });
    await service.flush();
    service.close();
    expect(pushSub(s, device)).toBeNull();
    expect(s.getApproval(approval.id).status).toBe("pending");
  });

  test("parseSubscribe rejects extra fields and truncated keys", () => {
    const keys = uaKeys();
    expect(() => parseSubscribe({ endpoint: apple, ...keys, title: "no" })).toThrow();
    expect(() => parseSubscribe({ endpoint: apple, p256dh: keys.p256dh, auth: "AA" })).toThrow();
    expect(() => parseSubscribe({ endpoint: "https://evil.example/push", ...keys })).toThrow();
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
