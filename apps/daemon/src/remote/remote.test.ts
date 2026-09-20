import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64url, canonicalBytes, canonicalHash, canonicalize, DeviceSession, fromBase64url, generateIdentity,
  identityPublic, openPairingGrant, randomBytes, sealPairing, signEnrollmentProof, Reassembler, decodeFileChunk,
  type EnrollmentChallenge, type RemoteRequest, type UvChallenge } from "@real-bot/remote";
import { startRelay } from "../../../relay/src/server";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { createLocalApi } from "../local-api";
import { ulid } from "../ids";
import { RemoteNativeClient, type LocalAction } from "../remote-native";
import { RemoteController } from "./controller";
import { RemoteTrust } from "./trust";
import { RemoteUv } from "./uv";
import { dispatchLocalSetup } from "./local-setup";
import { generateKeyPairSync, sign, createHash } from "node:crypto";

function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([major * 32 + n]) : n < 256 ? Buffer.from([major * 32 + 24, n]) : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("fixture CBOR value");
}
function authenticator() {
  const keys = generateKeyPairSync("ed25519"), pub = keys.publicKey.export({ format: "jwk" });
  const id = randomBytes(24), cose = cbor(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, fromBase64url(pub.x!)]]));
  const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
  function auth(flags: number, count: number) { const counter = Buffer.alloc(4); counter.writeUInt32BE(count); return Buffer.concat([hash(new URL(ORIGIN).hostname), Buffer.from([flags]), counter]); }
  return {
    registration(record: UvChallenge) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const data = Buffer.concat([auth(0x45, 0), Buffer.alloc(16), length, id, cose]);
      return { credentialId: base64url(id), clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: record.challenge, origin: ORIGIN })),
        attestationObject: cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]])) };
    },
    assertion(record: UvChallenge, count = 1, flags = 5, origin = ORIGIN) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: record.challenge, origin }));
      const authenticatorData = auth(flags, count);
      return { credentialId: base64url(id), clientDataJSON, authenticatorData, signature: sign(null, Buffer.concat([authenticatorData, hash(clientDataJSON)]), keys.privateKey) };
    },
  };
}

const ORIGIN = "https://relay.example.test", HOST = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function nativeFixture() {
  const keys = generateIdentity(); let highwater = 1;
  const pending = new Map<string, { action: LocalAction; proof?: string }>();
  const client = new RemoteNativeClient(async r => {
    let value: string | undefined, expiresIn: number | undefined;
    if (r.op === "read") {
      const epoch = Buffer.alloc(4); epoch.writeUInt32BE(highwater);
      const bytes = r.material === "host_identity" ? Buffer.concat([keys.dh, keys.signing]) : r.material === "enrollment" ? keys.enrollment : epoch;
      value = Buffer.from(bytes).toString("base64");
    } else if (r.op === "advance_highwater") {
      if (r.expected !== highwater || r.next! <= highwater) return { ...r, ok: false, error: "rollback" };
      highwater = r.next!;
    } else if (r.op === "prepare") {
      value = Buffer.from(randomBytes(32)).toString("base64"); expiresIn = 120;
      pending.set(value, { action: r.action! });
    } else if (r.op === "consume") {
      const entry = pending.get(r.challenge!); pending.delete(r.challenge!);
      if (!entry || entry.proof !== r.proof || canonicalHash(entry.action) !== canonicalHash(r.action)) return { ...r, ok: false, error: "proof" };
    } else if (r.op !== "capability") return { ...r, ok: false, error: "malformed" };
    return { v: 1, id: r.id, ok: true, ...(value ? { value } : {}), ...(expiresIn ? { expiresIn } : {}) };
  });
  return { client, keys, get highwater() { return highwater; }, confirm(challenge: string) {
    const row = pending.get(challenge); if (!row) throw new Error("fixture confirmation absent");
    row.proof = Buffer.from(randomBytes(32)).toString("base64"); return row.proof;
  } };
}
async function fixture(completions?: import("../completions").CompletionsClient) {
  const root = mkdtempSync(join(tmpdir(), "rb-rc07-"));
  const store = new Store({ filename: join(root, "host.sqlite"), endpointKey: memoryKeyStore() });
  await store.patchSettings({ workspace_path: root });
  const api = createLocalApi({ store, token: "fixture", schedule: false, completions });
  const native = nativeFixture();
  const bootstrap = base64url(randomBytes(32));
  const relay = startRelay({ hostname: "127.0.0.1", port: 0, database: join(root, "relay.sqlite"), bootstrap,
    origin: ORIGIN, relayId: "fixture", enabled: true, pairingEnabled: true });
  const localOrigin = `http://127.0.0.1:${relay.port}`;
  const controller = new RemoteController({ store, api, native: native.client,
    socketFactory: url => new WebSocket(url.replace("wss://relay.example.test", localOrigin.replace("http:", "ws:"))),
    fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(ORIGIN, localOrigin), init)) as typeof fetch });
  cleanup.push(async () => { controller.stop(); api.quiesce.close(); await api.engine.close(); await relay.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await controller.initialize({ origin: ORIGIN, relayId: "fixture", hostId: HOST }, bootstrap);
  expect(controller.status().state).toBe("online");
  const post = (value: unknown) => fetch(`${localOrigin}/v1/pair/mailbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: canonicalize(value) });
  async function pair() {
    const qr = await controller.openPair(), keys = generateIdentity(), pub = identityPublic(keys), deviceId = ulid();
    const context = { pairingId: qr.pairingId, hostId: qr.hostId, expiresUnix: qr.expiresUnix };
    const request = { device_id: deviceId, name: "Fixture device", ua_hint: "test", device_e_pk: base64url(pub.dh), device_s_pk: base64url(pub.signing), enrollment_pk: base64url(pub.enrollment) };
    const envelope = sealPairing(request, fromBase64url(qr.secret), context, Math.floor(Date.now() / 1000));
    expect((await post({ op: "submit", pairing_id: qr.pairingId, ciphertext: base64url(envelope) })).status).toBe(202);
    const prepared = await controller.preparePair(qr.pairingId);
    if ("pending" in prepared) throw new Error("fixture request missing");
    expect(store.db.query("SELECT device_id FROM remote_devices WHERE device_id = ?").get(deviceId)).toBeNull();
    await controller.confirmPair(qr.pairingId, native.confirm(prepared.challenge));
    const reply = await (await post({ op: "poll", pairing_id: qr.pairingId })).json() as { ciphertext: string };
    const grant = openPairingGrant(fromBase64url(reply.ciphertext), fromBase64url(qr.secret), context, Math.floor(Date.now() / 1000),
      fromBase64url(qr.hostSigningPublic), { hostId: HOST, deviceId, deviceDhPublic: pub.dh, deviceSigningPublic: pub.signing,
        enrollmentPublic: pub.enrollment, trustEpoch: qr.trustEpoch, protocolVersion: 1, relayOrigin: ORIGIN, issuedAt: qr.issuedAt }).grant;
    return { keys, pub, deviceId, grant, qr };
  }
  async function connect(device: Awaited<ReturnType<typeof pair>>) {
    const socket = new WebSocket(`${localOrigin.replace("http:", "ws:")}/v1/relay/device`); socket.binaryType = "arraybuffer";
    const queue: Array<string | Uint8Array> = [], waiters: Array<(value: string | Uint8Array) => void> = [];
    socket.onmessage = e => { const value = typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer); const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value); };
    const next = async () => {
      if (queue.length) return queue.shift()!;
      let timer: ReturnType<typeof setTimeout>;
      try { return await Promise.race([new Promise<string | Uint8Array>(resolve => waiters.push(resolve)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture timeout")), 3000); })]); }
      finally { clearTimeout(timer!); }
    };
    cleanup.push(() => socket.close());
    await new Promise<void>(resolve => { socket.onopen = () => resolve(); });
    socket.send(canonicalize({ type: "hello", id: device.deviceId, nonce_c: base64url(randomBytes(16)) }));
    const challenge = JSON.parse(await next() as string) as EnrollmentChallenge;
    socket.send(canonicalize({ type: "proof", signature: signEnrollmentProof(challenge, device.keys.enrollment) }));
    expect(JSON.parse(await next() as string).mode).toBe("link");
    const noise = new DeviceSession({ identity: device.keys, peer: { dh: fromBase64url(device.qr.hostDhPublic), signing: fromBase64url(device.qr.hostSigningPublic) },
      binding: { hostId: HOST, deviceId: device.deviceId, trustEpoch: device.grant.trustEpoch, protocolVersion: 1, relayOrigin: ORIGIN } });
    socket.send(new Uint8Array(noise.start())); noise.accept(await next() as Uint8Array);
    const ready = JSON.parse(new TextDecoder().decode(noise.receive(await next() as Uint8Array).body));
    expect(ready.type).toBe("ready");
    const assembler = new Reassembler();
    const events: unknown[] = [];
    async function rpc(request: RemoteRequest) {
      socket.send(new Uint8Array(noise.send(1, canonicalBytes(request))));
      for (;;) {
        const frame = noise.receive(await next() as Uint8Array);
        if (frame.type === 5) throw new Error("unexpected file");
        const logical = frame.type === 4 ? assembler.accept(frame.body, performance.now()) : frame;
        if (!logical) continue;
        const message = JSON.parse(new TextDecoder().decode(logical.body));
        if (message.id === request.id) return message;
        events.push(message);
      }
    }
    return { socket, noise, next, rpc, events, ready };
  }
  return { root, store, api, native, controller, relay, pair, connect, post };
}

test("remote chat uses the actual engine and event stream, not a parallel business implementation", async () => {
  const f = await fixture({ judge: async () => ({ content: "{}", hadToolCalls: false, usage: null, failKind: null }),
    complete: async request => { request.onToken?.("remote fixture"); return { ok: true, content: "remote fixture", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null }; } });
  await f.store.patchSettings({ endpoint_base_url: "https://fixture.invalid", endpoint_api_key: "fixture-only", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
  const d = await f.pair(), c = await f.connect(d), bot = f.store.createBot({ name: "Remote Chat", duties: "", boundaries: "" });
  const sent = await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/sessions/${bot.direct_session.id}/messages`, body: { body: "remote user" } });
  expect(sent.status).toBe(201);
  const deadline = Date.now() + 2000;
  while (!f.store.listMessages(bot.direct_session.id).items.some(m => m.body === "remote fixture") && Date.now() < deadline) await Bun.sleep(5);
  const history = await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/sessions/${bot.direct_session.id}/snapshot` });
  expect(history.status).toBe(200);
  expect(f.store.listMessages(bot.direct_session.id).items.some(m => m.body === "remote fixture")).toBe(true);
  expect(JSON.stringify(c.events)).toContain("message.upsert");
  expect(JSON.stringify(c.events)).not.toContain('"turn.token"');
});

test("lost accepted response reconnects with fresh Noise and same receipt without duplicate mutation", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d), id = ulid();
  const request: RemoteRequest = { v: 1, id, method: "POST", path: "/v1/bots", body: { name: "Lost response", duties: "", boundaries: "" } };
  c.socket.send(new Uint8Array(c.noise.send(1, canonicalBytes(request))));
  const deadline = Date.now() + 2000;
  while (!f.store.receipts.lookup({ deviceId: d.deviceId, requestId: id }) && Date.now() < deadline) await Bun.sleep(2);
  expect(f.store.listBots()).toHaveLength(1);
  const closed = new Promise<void>(resolve => c.socket.addEventListener("close", () => resolve(), { once: true }));
  c.socket.close(); await closed;
  const fresh = await f.connect(d);
  expect(base64url(fresh.noise.authenticatedSessionId)).not.toBe(base64url(c.noise.authenticatedSessionId));
  expect((await fresh.rpc(request)).status).toBe(201);
  expect(f.store.listBots()).toHaveLength(1);
  expect((await fresh.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${id}` })).status).toBe(201);
});

test("actual relay + native confirmation fixture + signed mailbox grant + Noise RPC and binary file", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const created = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/bots", body: { name: "Remote", duties: "test", boundaries: "fixture" } });
  expect(created.status).toBe(201);
  const id = ulid(), request: RemoteRequest = { v: 1, id, method: "POST", path: "/v1/skills", body: { bot_id: created.body.bot.id, name: "skill", description: "test", body: "actual" } };
  const first = await c.rpc(request); expect(first.status).toBe(201);
  expect(await c.rpc(request)).toEqual(first);
  expect((await c.rpc({ ...request, body: { ...request.body, name: "different" } })).status).toBe(409);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${id}` })).body).toEqual(first.body);
  const snapshot = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/snapshot" });
  expect(snapshot.body.bots).toHaveLength(1); expect(snapshot.body.skills).toHaveLength(1);
  expect(snapshot.body.event_instance_id).toBe(c.ready.event_instance_id);
  expect(c.events.length).toBeGreaterThan(0);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/runtime/quit" })).status).toBe(404);
  expect((await c.rpc({ v: 1, id: ulid(), method: "PATCH", path: "/v1/settings", body: { workspace_path: "/secret" } })).status).toBe(403);
  const bytes = randomBytes(100_000); writeFileSync(join(f.root, "fixture.bin"), bytes);
  const file = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "fixture.bin" } });
  expect(file.file.size).toBe(bytes.length);
  const received = new Uint8Array(bytes.length); let offset = 0;
  while (offset < bytes.length) {
    const frame = c.noise.receive(await c.next() as Uint8Array); expect(frame.type).toBe(5);
    const chunk = decodeFileChunk(frame.body); expect(chunk.offset).toBe(BigInt(offset));
    received.set(chunk.chunk, offset); offset += chunk.chunk.length;
  }
  expect(received).toEqual(new Uint8Array(bytes));
  writeFileSync(join(f.root, "fixture.json"), '{"file":true}');
  const jsonFile = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "fixture.json" } });
  expect(jsonFile.body).toBeNull(); expect(jsonFile.file.size).toBe(13);
  const jsonChunk = decodeFileChunk(c.noise.receive(await c.next() as Uint8Array).body);
  expect(new TextDecoder().decode(jsonChunk.chunk)).toBe('{"file":true}');
  c.socket.close();
}, 15_000);

test("authenticated RPC requires revisions, redacts stored provider secrets and preserves group stop rule", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Policy", duties: "", boundaries: "" });
  expect((await c.rpc({ v: 1, id: ulid(), method: "DELETE", path: `/v1/bots/${bot.bot.id}` })).status).toBe(409);
  const patch = await c.rpc({ v: 1, id: ulid(), method: "PATCH", path: `/v1/bots/${bot.bot.id}`, body: { name: "Updated", if_revision: bot.bot.updated_at } });
  expect(patch.status).toBe(200);
  await f.store.patchSettings({ endpoint_base_url: "https://fixture.invalid", endpoint_api_key: "CANARY-NOT-RETURNED" });
  for (const path of ["/v1/settings", "/v1/providers", "/v1/snapshot"]) {
    const value = await c.rpc({ v: 1, id: ulid(), method: "GET", path });
    expect(JSON.stringify(value)).not.toContain("CANARY-NOT-RETURNED");
  }
  const message = f.store.postMessage(bot.direct_session.id, { body: "manual turn" });
  const turn = f.store.createTurn({ sessionId: message.session_id, botId: bot.bot.id, triggerMessageId: message.id });
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/turns/stop", body: { turn_id: turn.id } })).status).toBe(204);
  const other = f.store.createBot({ name: "Other", duties: "", boundaries: "" });
  const group = f.store.createGroup({ name: "Group", members: [bot.bot.id, other.bot.id] });
  const trigger = f.store.postMessage(group.id, { body: "manual" });
  const grouped = f.store.createTurn({ sessionId: group.id, botId: bot.bot.id, triggerMessageId: trigger.id });
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/turns/stop", body: { turn_id: grouped.id } })).status).toBe(422);
  expect(f.store.getTurn(grouped.id).status).toBe("running");
});

test("revocation closes a live channel and rejects async guarded effects after hydration", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const pin = f.controller.trust.device(d.deviceId)!;
  let release!: () => void;
  const original = f.store.settings.bind(f.store);
  const held = spyOn(f.store, "settings").mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
  cleanup.push(() => held.mockRestore());
  const pending = f.controller.dispatcher.dispatch({ v: 1, id: ulid(), method: "POST", path: "/v1/bots", body: { name: "Never", duties: "", boundaries: "" } },
    { device: pin, sessionId: base64url(c.noise.authenticatedSessionId), active: () => true });
  while (!release) await Bun.sleep(1);
  const closed = new Promise<void>(resolve => c.socket.addEventListener("close", () => resolve(), { once: true }));
  await f.controller.trust.revoke(d.deviceId, () => f.controller.trust.assert(pin));
  release(); await expect(pending).rejects.toThrow(); await closed;
  expect(f.store.listBots()).toHaveLength(0);
});

test("default native provider never reads credentials and local bearer has no setup bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc07-off-")), store = new Store({ filename: join(root, "db"), endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "local", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const remote = new RemoteController({ store, api, config: { origin: ORIGIN, relayId: "fixture", hostId: HOST } });
  cleanup.push(async () => { remote.stop(); api.quiesce.close(); await api.engine.close(); await server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  await remote.start(); expect(remote.status().state).toBe("native_unavailable");
  for (const path of ["/remote/uv/challenge", "/remote/local/setup", "/remote/action"]) {
    expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { Authorization: "Bearer local" }, body: "{}" })).status).toBe(404);
  }
  await expect(dispatchLocalSetup(remote, { operation: "read", material: "host_identity" })).rejects.toThrow();
});

test("single-device revoke keeps survivor grant valid after generation bump and fresh reconnect", async () => {
  const f = await fixture(), a = await f.pair(), b = await f.pair();
  const ca = await f.connect(a), cb = await f.connect(b);
  const old = f.controller.trust.device(b.deviceId)!;
  const closed = new Promise<void>(resolve => cb.socket.addEventListener("close", () => resolve(), { once: true }));
  await f.controller.trust.revoke(a.deviceId, () => f.controller.trust.assert(old)); await closed;
  expect(f.controller.trust.trusted(old)).toBe(false);
  expect(f.controller.trust.device(b.deviceId)!.grant_epoch).toBe(b.grant.trustEpoch);
  const deadline = Date.now() + 3000;
  while (f.controller.status().state !== "online" && Date.now() < deadline) await Bun.sleep(10);
  expect(f.controller.status().state).toBe("online");
  const fresh = await f.connect(b);
  expect((await fresh.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" })).status).toBe(200);
  ca.socket.close();
}, 10_000);

test("native-ahead transaction failure stays closed and replay capacity refuses rather than evicts", async () => {
  const f = await fixture(), d = await f.pair(), trust = f.controller.trust, pin = trust.device(d.deviceId)!;
  f.store.transaction(() => {
    for (let i = 0; i < 2048; i++) f.store.db.run("INSERT INTO remote_replays VALUES (?, ?, ?, ?)",
      [base64url(randomBytes(16)), d.deviceId, base64url(randomBytes(32)), Date.now() + 120_000]);
  });
  expect(trust.claimReplay(pin, { deviceId: d.deviceId, ephemeralPublic: randomBytes(32), sessionId: randomBytes(16), minimumTtlMs: 120_000 })).toBe(false);
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM remote_replays").get()!.n).toBe(2048);
  f.store.db.run("CREATE TRIGGER fail_remote_epoch BEFORE UPDATE ON remote_host BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await expect(trust.revoke(d.deviceId, () => trust.assert(pin))).rejects.toThrow();
  expect(f.native.highwater).toBe(2); expect(trust.host()!.generation).toBe(1);
  expect(trust.trusted(pin)).toBe(false);
  f.store.db.run("DROP TRIGGER fail_remote_epoch");
  await expect(trust.reconcile()).rejects.toThrow();
  const prepared = await f.controller.prepareRecovery();
  await f.controller.confirmRecovery(f.native.confirm(prepared.challenge));
  expect(trust.host()!.generation).toBe(2);
  expect(trust.device(d.deviceId)!.revoked).toBe(1);
  expect(trust.trusted(pin)).toBe(false);
});

test("durable dual replay reservation and single revoke highwater reject stale DB and old pins", async () => {
  const f = await fixture(), d = await f.pair(), trust = f.controller.trust, pin = trust.device(d.deviceId)!;
  const claim = { deviceId: d.deviceId, ephemeralPublic: randomBytes(32), sessionId: randomBytes(16), minimumTtlMs: 120_000 };
  expect(trust.claimReplay(pin, claim)).toBe(true);
  expect(trust.claimReplay(pin, { ...claim, sessionId: randomBytes(16) })).toBe(false);
  expect(trust.claimReplay(pin, { ...claim, ephemeralPublic: randomBytes(32) })).toBe(false);
  const reopened = new Store({ filename: join(f.root, "host.sqlite"), endpointKey: memoryKeyStore() });
  const restored = new RemoteTrust(reopened, f.native.client); await restored.reconcile();
  expect(restored.claimReplay(pin, claim)).toBe(false); reopened.close();
  await trust.revoke(d.deviceId, () => trust.assert(pin)); expect(f.native.highwater).toBe(2);
  expect(trust.trusted(pin)).toBe(false);
  f.store.db.run("UPDATE remote_host SET generation = 1");
  f.store.db.run("UPDATE remote_devices SET generation = 1, revoked = 0");
  await expect(trust.reconcile()).rejects.toThrow(); expect(trust.trusted(pin)).toBe(false);
});

test("real WebAuthn registration, fresh assertions, CAS races, expiry and exact replacement material", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const uv = f.controller.dispatcher.uv, device = f.controller.trust.device(d.deviceId)!;
  let active = true;
  const principal = { device, sessionId: base64url(c.noise.authenticatedSessionId), active: () => active };
  const first = authenticator(), reg = uv.registrationChallenge(principal, ulid());
  await uv.register(principal, reg.challenge, first.registration(reg));
  expect(f.controller.trust.device(device.device_id)!.credential_version).toBe(1);
  const challenge = uv.issue(principal, ulid(), "quiesce.force", "runtime", canonicalHash({ force: true }));
  for (const bad of [first.assertion(challenge, 1, 1), first.assertion(challenge, 1, 5, "https://evil.example.test")]) {
    await expect(uv.assertion(principal, challenge.challenge, challenge.binding, bad)).rejects.toThrow();
  }
  let effects = 0;
  const response = first.assertion(challenge);
  const raced = await Promise.allSettled([uv.assertion(principal, challenge.challenge, challenge.binding, response, () => effects++),
    uv.assertion(principal, challenge.challenge, challenge.binding, response, () => effects++)]);
  expect(raced.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(effects).toBe(1);
  const fresh = uv.issue(principal, ulid(), "quiesce.force", "runtime", canonicalHash({ force: true }));
  const pending = uv.assertion(principal, fresh.challenge, fresh.binding, first.assertion(fresh, 2), () => effects++);
  active = false;
  await expect(pending).rejects.toThrow(); expect(effects).toBe(1); active = true;
  const second = authenticator(), create = uv.registrationChallenge(principal, ulid()), staged = second.registration(create);
  await expect(uv.register(principal, create.challenge, staged)).rejects.toThrow();
  const replacement = uv.replacementChallenge(principal, create.challenge, staged);
  await uv.register(principal, create.challenge, staged, { challenge: replacement.challenge, assertion: first.assertion(replacement, 2) });
  expect(f.controller.trust.device(device.device_id)!.credential_id).toBe(staged.credentialId);
  expect(f.controller.trust.device(device.device_id)!.credential_version).toBe(2);
  const next = uv.issue(principal, ulid(), "quiesce.force", "runtime", canonicalHash({ force: true }));
  await expect(uv.assertion(principal, next.challenge, next.binding, first.assertion(next, 3))).rejects.toThrow();
  let now = Date.now();
  const clockTrust = new RemoteTrust(f.store, f.native.client, () => now); await clockTrust.reconcile();
  const clockUv = new RemoteUv(clockTrust);
  const expires = clockUv.issue(principal, ulid(), "quiesce.force", "runtime", canonicalHash({ force: true }));
  const expired = clockUv.assertion(principal, expires.challenge, expires.binding, second.assertion(expires), () => effects++);
  now += 60_000;
  await expect(expired).rejects.toThrow(); expect(effects).toBe(1);
  const op = { action: "quiesce.force", targetId: "runtime", requestId: ulid() };
  const issued = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/challenge", body: { operation: op } });
  const assertion = second.assertion(issued.body);
  const actionRequest: RemoteRequest = { v: 1, id: op.requestId, method: "POST", path: "/remote/action", body: { operation: op, challenge: issued.body.challenge,
    assertion: { credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON), authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature) } } };
  expect((await c.rpc(actionRequest)).status).toBe(204);
  expect(f.api.quiesce.state().forced).toBe(true);
  expect((await c.rpc(actionRequest)).status).toBe(204);
  expect((await c.rpc({ ...actionRequest, body: { ...actionRequest.body, operation: { ...op, action: "quiesce.cancel" } } })).status).toBe(409);
});

test("quiesce keeps existing ask/reply alive, rejects new body and resumes without exit", async () => {
  let calls = 0;
  const completions: import("../completions").CompletionsClient = {
    judge: async () => ({ content: "{}", hadToolCalls: false, usage: null, failKind: null }),
    complete: async () => ({ ok: true, content: calls++ ? "finished" : "", toolCalls: calls === 1 ? [{ id: "ask", name: "ask_user", arguments: '{"question":"continue?"}' }] : [],
      finishReason: "stop", hadChoices: true, usage: null, missingReason: null }),
  };
  const f = await fixture(completions);
  await f.store.patchSettings({ endpoint_base_url: "https://fixture.invalid", endpoint_api_key: "fixture-only", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
  const bot = f.store.createBot({ name: "Drain", duties: "fixture", boundaries: "fixture" });
  const call = (body: unknown) => f.api.dispatchBusiness(new Request(`http://remote.invalid/v1/sessions/${bot.direct_session.id}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { deviceId: "fixture", requestId: ulid() });
  expect((await call({ body: "start" })).status).toBe(201);
  const deadline = Date.now() + 2000;
  while (!f.store.listMessages(bot.direct_session.id).items.some(m => m.kind === "ask") && Date.now() < deadline) await Bun.sleep(5);
  const ask = f.store.listMessages(bot.direct_session.id).items.find(m => m.kind === "ask")!;
  expect(ask).toBeDefined();
  expect(f.api.quiesce.begin().phase).toBe("draining");
  await Bun.sleep(100);
  expect(f.api.quiesce.state().phase).toBe("draining");
  expect((await call({ body: "must not persist" })).status).toBe(409);
  expect(f.store.listMessages(bot.direct_session.id).items.some(m => m.body === "must not persist")).toBe(false);
  expect((await call({ body: "yes", ask_id: ask.id })).status).toBe(201);
  expect((await f.api.quiesce.wait()).phase).toBe("drained");
  expect(f.api.quiesce.cancel().phase).toBe("running");
  expect(f.api.quiesce.force().phase).toBe("drained");
  expect(f.store.listBots()).toHaveLength(1);
}, 10_000);

test("pair native proof is single use and bound to authoritative keys, not browser UV claims", async () => {
  const f = await fixture(), qr = await f.controller.openPair();
  await expect(f.controller.confirmPair(qr.pairingId, Buffer.from(randomBytes(32)).toString("base64"))).rejects.toThrow();
  expect(f.controller.trust.devices()).toHaveLength(0);
  const d = await f.pair(), c = await f.connect(d);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/action", body: { uv: true, credentialId: "claimed" } })).status).toBe(403);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/challenge", body: { operation: { action: "quiesce.force", targetId: "runtime", requestId: ulid() } } })).status).toBe(403);
});
