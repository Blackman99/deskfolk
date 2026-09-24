import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64url, canonicalBytes, canonicalHash, canonicalize, DeviceSession, fromBase64url, generateIdentity, requestDigest,
  identityPublic, openPairingGrant, randomBytes, sealPairing, signEnrollmentProof, Reassembler, decodeFileChunk,
  encodeFileChunk, sha256Hex, type EnrollmentChallenge, type RemoteRequest, type UvChallenge } from "@real-bot/remote";
import { startRelay } from "../../../relay/src/server";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { createLocalApi } from "../local-api";
import { ulid } from "../ids";
import { HttpError } from "../errors";
import { RemoteNativeClient, type LocalAction } from "../remote-native";
import { RemoteController } from "./controller";
import { RemoteTrust } from "./trust";
import { RemoteUv } from "./uv";
import { dispatchLocalSetup } from "./local-setup";
import { finishLifecycle, recoverLifecycle } from "./lifecycle";
import { validateBusiness } from "./routes";
import { ptyHelperPath } from "../pty";
import { remoteError } from "./errors";
import { noisePng } from "../test-images";
import { inflateRawSync } from "node:zlib";
import { finishRestart, finishStop, maintenanceDiagnostics, restartAvailable, type MaintenanceControl } from "./maint";
import { RuntimeLifecycle } from "../lifecycle";
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
  let keys = generateIdentity(), highwater = 1;
  const vapid = (() => {
    for (;;) {
      const raw = Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }).d!, "base64url");
      if (raw.length === 32) return raw;
    }
  })();
  const pending = new Map<string, { action: LocalAction; proof?: string }>();
  const client = new RemoteNativeClient(async r => {
    let value: string | undefined, expiresIn: number | undefined;
    if (r.op === "read") {
      const epoch = Buffer.alloc(4); epoch.writeUInt32BE(highwater);
      const bytes = r.material === "host_identity" ? Buffer.concat([keys.dh, keys.signing])
        : r.material === "enrollment" ? keys.enrollment
        : r.material === "vapid" ? vapid
        : epoch;
      value = Buffer.from(bytes).toString("base64");
    } else if (r.op === "advance_highwater") {
      if (r.expected !== highwater || r.next! <= highwater) return { ...r, ok: false, error: "rollback" };
      highwater = r.next!;
    } else if (r.op === "prepare") {
      value = Buffer.from(randomBytes(32)).toString("base64"); expiresIn = 120;
      pending.set(value, { action: r.action! });
    } else if (r.op === "consume" || r.op === "reset") {
      const entry = pending.get(r.challenge!); pending.delete(r.challenge!);
      if (!entry || entry.proof !== r.proof || canonicalHash(entry.action) !== canonicalHash(r.action)) return { ...r, ok: false, error: "proof" };
      if (r.op === "reset") {
        if (r.action?.kind !== "reset_identity" || r.expected !== highwater) return { ...r, ok: false, error: "rollback" };
        keys = generateIdentity(); highwater++;
      }
    } else if (r.op !== "capability") return { ...r, ok: false, error: "malformed" };
    return { v: 1, id: r.id, ok: true, ...(value ? { value } : {}), ...(expiresIn ? { expiresIn } : {}) };
  });
  return { client, get keys() { return keys; }, get highwater() { return highwater; }, confirm(challenge: string) {
    const row = pending.get(challenge); if (!row) throw new Error("fixture confirmation absent");
    row.proof = Buffer.from(randomBytes(32)).toString("base64"); return row.proof;
  } };
}
function maintControl(dir: string, kind: RuntimeLifecycle["kind"] = "window", alive = true): { maint: MaintenanceControl; exits: string[]; setAlive: (value: boolean) => void } {
  const lifecycle = new RuntimeLifecycle(dir, kind);
  const exits: string[] = [];
  let windowAlive = alive;
  const maint: MaintenanceControl = {
    version: "0.1.0-rc.2", lifecycle, windowAlive: () => windowAlive,
    requestExit: (reason) => { exits.push(reason); },
  };
  return { maint, exits, setAlive: (value) => { windowAlive = value; } };
}

async function fixture(completions?: import("../completions").CompletionsClient, holdAfterMetadata = false, withMaint = false) {
  const root = mkdtempSync(join(tmpdir(), "rb-rc07-"));
  const endpointKeys = memoryKeyStore();
  const store = new Store({ filename: join(root, "host.sqlite"), endpointKey: endpointKeys });
  await store.patchSettings({ workspace_path: root });
  const api = createLocalApi({ store, token: "fixture", schedule: false, completions });
  const native = nativeFixture();
  const bootstrap = base64url(randomBytes(32));
  const relay = startRelay({ hostname: "127.0.0.1", port: 0, database: join(root, "relay.sqlite"), bootstrap,
    origin: ORIGIN, relayId: "fixture", enabled: true, pairingEnabled: true });
  const localOrigin = `http://127.0.0.1:${relay.port}`;
  let hold = false;
  const control = withMaint ? maintControl(root) : null;
  const controller = new RemoteController({ store, api, native: native.client, maint: control?.maint,
    socketFactory: url => {
      const ws = new WebSocket(`${localOrigin.replace("http:", "ws:")}${new URL(url).pathname}`);
      if (holdAfterMetadata) {
        let sent = 0, link = false;
        const send = ws.send.bind(ws);
        ws.send = (bytes) => {
          if (typeof bytes === "string" && JSON.parse(bytes).mode === "link") link = true;
          send(bytes); if (link && typeof bytes !== "string" && ++sent === 3) hold = true;
        };
        // A full 64 KiB buffer is what actually holds the pump. A leftover byte does not:
        // the amount still buffered lags the bytes that already left.
        Object.defineProperty(ws, "bufferedAmount", { get: () => link && hold ? 65536 : 0 });
      }
      return ws;
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(ORIGIN, localOrigin), init)) as typeof fetch,
    pushFetch: async () => { throw new Error("isolated tests must not send web push"); },
  });
  // Terminals first: a live one's pty outlives the test otherwise, and its coalesced screen write
  // lands a second later in a store that has closed, as a failure of whichever test runs then.
  cleanup.push(async () => { api.terminals.shutdown(); controller.stop(); api.quiesce.close(); await api.engine.close(); await relay.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
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
    /** Ids of answers that came compressed. */
    const compressed: string[] = [];
    const snapshotPages = new Map<string, { transfer: string; count: number; chunks: Uint8Array[] }>();
    async function rpc(request: RemoteRequest) {
      socket.send(new Uint8Array(noise.send(1, canonicalBytes(request))));
      for (;;) {
        const frame = noise.receive(await next() as Uint8Array);
        if (frame.type === 5) { decodeFileChunk(frame.body); continue; }
        if (frame.type === 6) continue;
        const logical = frame.type === 4 ? assembler.accept(frame.body, performance.now()) : frame;
        if (!logical) continue;
        if (logical.body[0] === 0) compressed.push(request.id);
        const json = logical.body[0] === 0 ? inflateRawSync(logical.body.subarray(1)) : logical.body;
        const message = JSON.parse(new TextDecoder().decode(json));
        if (message.id === request.id) {
          if (message.snapshotPage) {
            const page = message.snapshotPage;
            const state = snapshotPages.get(request.id) ?? { transfer: page.transferId, count: page.count, chunks: [] as Uint8Array[] };
            expect(page.transferId).toBe(state.transfer); expect(page.count).toBe(state.count); expect(page.index).toBe(state.chunks.length);
            state.chunks.push(fromBase64url(page.bytes)); snapshotPages.set(request.id, state);
            if (state.chunks.length < state.count) continue;
            snapshotPages.delete(request.id);
            return { ...message, body: JSON.parse(Buffer.concat(state.chunks).toString("utf8")) };
          }
          return message;
        }
        events.push(message);
      }
    }
    async function download(path: string): Promise<{ bytes: number; hash: string; streamId: number }> {
      const meta = await rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path } });
      expect(meta.status).toBe(200);
      if (typeof meta.file?.bytes === "string") {
        const inline = fromBase64url(meta.file.bytes);
        expect(inline.length).toBe(meta.file.size);
        return { bytes: inline.length, hash: createHash("sha256").update(inline).digest("hex"), streamId: 0 };
      }
      const hash = createHash("sha256"); let offset = 0;
      for (;;) {
        const frame = noise.receive(await next() as Uint8Array);
        if (frame.type === 3 || frame.type === 4 || frame.type === 6) continue;
        expect(frame.type).toBe(5); const chunk = decodeFileChunk(frame.body);
        expect(chunk.streamId).toBe(meta.file.streamId); expect(chunk.offset).toBe(BigInt(offset));
        hash.update(chunk.chunk); offset += chunk.chunk.length;
        if (chunk.eof) break;
      }
      expect(offset).toBe(meta.file.size);
      return { bytes: offset, hash: hash.digest("hex"), streamId: meta.file.streamId };
    }
    async function upload(sessionId: string, filename: string, bytes: Uint8Array, opts: { offset?: number; hash?: string; cancel?: boolean } = {}) {
      const id = ulid();
      const declared = { filename, size: bytes.length, sha256: opts.hash ?? sha256Hex(bytes) };
      socket.send(new Uint8Array(noise.send(1, canonicalBytes({
        v: 1, id, method: "POST", path: `/v1/sessions/${sessionId}/messages`,
        body: { body: filename, parent_id: null, fork: false, ask_id: null, files: [declared] },
      }))));
      let opened: { streamId: number } | undefined;
      for (;;) {
        const frame = noise.receive(await next() as Uint8Array);
        if (frame.type === 3 || frame.type === 4) continue;
        expect(frame.type).toBe(2);
        const message = JSON.parse(new TextDecoder().decode(frame.body));
        if (message.id !== id) continue;
        opened = message.upload?.files?.[0];
        expect(message.status).toBe(message.upload ? 202 : message.status);
        break;
      }
      if (opts.cancel && opened) {
        const cancel = Buffer.alloc(4); cancel.writeUInt32BE(opened.streamId);
        socket.send(new Uint8Array(noise.send(6, cancel)));
      } else if (opened && bytes.length) {
        socket.send(new Uint8Array(noise.send(5, encodeFileChunk({
          streamId: opened.streamId, offset: BigInt(opts.offset ?? 0), eof: true, chunk: bytes,
        }))));
      }
      for (;;) {
        const frame = noise.receive(await next() as Uint8Array);
        if (frame.type === 3 || frame.type === 4 || frame.type === 6) continue;
        if (frame.type === 5) continue;
        const message = JSON.parse(new TextDecoder().decode(frame.body));
        if (message.id === id) return message;
      }
    }
    return { socket, noise, next, rpc, download, upload, events, ready, compressed };
  }
  return { root, store, endpointKeys, api, native, controller, relay, pair, connect, post, maint: control, releasePressure: () => { hold = false; } };
}

test("cancel fences the pump's current unsent frame under held socket pressure", async () => {
  const f = await fixture(undefined, true), d = await f.pair(), c = await f.connect(d);
  writeFileSync(join(f.root, "cancel.bin"), Buffer.alloc(100_000));
  const metadata = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "cancel.bin" } });
  const cancel = Buffer.alloc(4); cancel.writeUInt32BE(metadata.file.streamId);
  c.socket.send(new Uint8Array(c.noise.send(6, cancel)));
  await Bun.sleep(10); f.releasePressure();
  const frame = c.noise.receive(await c.next() as Uint8Array); expect(frame.type).toBe(6);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" })).status).toBe(200);
});

/** A phone asks for a chip-sized picture, and hears what the original would cost to open. */
test.skipIf(process.platform !== "darwin")("a picture's scaled copy crosses the link with the original's size", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const picture = noisePng(1200, 800);
  writeFileSync(join(f.root, "frame.png"), picture);
  const thumb = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "frame.png", size: "thumb" } });
  expect(thumb.status).toBe(200);
  expect(thumb.headers).toMatchObject({ contentType: "image/jpeg", originalSize: picture.byteLength });
  expect(fromBase64url(thumb.file.bytes).byteLength).toBeLessThan(picture.byteLength / 10);
  const original = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "frame.png" } });
  expect(original.headers.originalSize).toBeUndefined();
  expect(original.file.size).toBe(picture.byteLength);
});

test("size names a picture variant on the file GETs and nothing else", () => {
  const get = (path: string, query: Record<string, string>) => () => validateBusiness({ v: 1, id: ulid(), method: "GET", path, query });
  const attachment = `/v1/attachments/${ulid()}/content`;
  expect(get("/v1/workspace/file", { path: "a.png", size: "thumb" })).not.toThrow();
  expect(get("/v1/workspace/file", { path: "a.png", size: "preview" })).not.toThrow();
  expect(get(attachment, { size: "thumb" })).not.toThrow();
  expect(get("/v1/workspace/file", { path: "a.png", size: "full" })).toThrow();
  expect(get(attachment, { size: "full" })).toThrow();
  expect(get("/v1/workspace/tree", { path: "", size: "thumb" })).toThrow();
});

test("a paired device can ask for a spend summary and a filtered page", () => {
  const get = (path: string, query: Record<string, string>) => () => validateBusiness({ v: 1, id: ulid(), method: "GET", path, query });
  const id = ulid();
  expect(get("/v1/spend/summary", { group_by: "day", tz: "America/New_York", kind: "turn,route_review", from: "2026-03-01T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z", bot_id: "", session_id: id, model: "fast", provider_id: id, turn_id: id })).not.toThrow();
  expect(get("/v1/spend/summary", { from: "2026-02-31T00:00:00.000Z" })).toThrow();
  expect(get("/v1/spend", { from: "2026-01-01T00:00:00Z" })).not.toThrow();
  expect(get("/v1/spend", { limit: "50", cursor: "2026-03-01T00:00:00.000Z|" + id, model: "", session_id: id })).not.toThrow();
  expect(get("/v1/spend/summary", { group_by: "hour" })).toThrow();
  expect(get("/v1/spend/summary", { tz: "Not/AZone" })).toThrow();
  expect(get("/v1/spend", { kind: "nope" })).toThrow();
  expect(get("/v1/spend", { limit: "201" })).toThrow();
});

test("an encrypted spend summary returns the daemon aggregate, not the ledger", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Writer", duties: "", boundaries: "" });
  const provider = f.store.createProviderSync({
    name: "Priced",
    base_url: "https://priced.invalid",
    models: [{ name: "fast", price: 1, pricing: { input: 1, output: 1 } }],
  });
  const turn = f.store.insertSpend({
    kind: "turn",
    sessionId: bot.direct_session.id,
    botId: bot.bot.id,
    turnId: ulid(),
    providerId: provider.id,
    model: "fast",
    inputTokens: 10,
    outputTokens: 2,
    costUsdTicks: 4,
  });
  f.store.db.run(`UPDATE spend SET created_at = ? WHERE id = ?`, ["2026-03-01T00:00:00.900Z", turn.id]);
  f.store.insertSpend({
    kind: "composer_suggest",
    sessionId: bot.direct_session.id,
    botId: null,
    providerId: provider.id,
    model: null,
    inputTokens: 3,
    outputTokens: 1,
  });
  const summary = await c.rpc({
    v: 1,
    id: ulid(),
    method: "GET",
    path: "/v1/spend/summary",
    query: { group_by: "model", tz: "UTC", kind: "turn,composer_suggest" },
  });
  expect(summary.status).toBe(200);
  expect(summary.body.totals).toMatchObject({ calls: 2, reported_usd_ticks: 4, estimated_usd_ticks: null, input_tokens: 13 });
  expect(summary.body.groups).toHaveLength(2);
  expect(summary.body.groups.find((row: { model: string | null }) => row.model === null)).toMatchObject({
    id: null,
    provider_id: null,
    calls: 1,
  });
  expect(summary.body.items).toBeUndefined();
  const page = await c.rpc({
    v: 1,
    id: ulid(),
    method: "GET",
    path: "/v1/spend",
    query: { limit: "1", kind: "turn", model: "fast" },
  });
  expect(page.status).toBe(200);
  expect(page.body.items).toHaveLength(1);
  expect(page.body.items[0].kind).toBe("turn");
  expect(page.body.next).toBeNull();
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/spend/summary", query: { tz: "Not/AZone" } })).status).toBe(422);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/spend", query: { from: "yesterday" } })).status).toBe(422);
  const stacked = await c.rpc({
    v: 1,
    id: ulid(),
    method: "GET",
    path: "/v1/spend/summary",
    query: {
      from: "2026-01-01T00:00:00Z",
      to: "2099-01-01T00:00:00.000Z",
      kind: "turn,composer_suggest",
      bot_id: bot.bot.id,
      session_id: bot.direct_session.id,
      provider_id: provider.id,
      model: "fast",
      group_by: "day",
      tz: "UTC",
    },
  });
  expect(stacked.status).toBe(200);
  expect(stacked.body.totals.calls).toBe(1);
  expect(stacked.body.groups.map((row: { id: string }) => row.id)).toEqual(["2026-03-01"]);
});

test("a conversation snapshot takes a page limit and nothing else", () => {
  const get = (query: Record<string, string>) => () => validateBusiness({ v: 1, id: ulid(), method: "GET", path: `/v1/sessions/${ulid()}/snapshot`, query });
  expect(get({ limit: "20" })).not.toThrow();
  expect(get({})).not.toThrow();
  expect(get({ limit: "0" })).toThrow();
  expect(get({ limit: "201" })).toThrow();
  expect(get({ cursor: "x" })).toThrow();
});

/** A device that asks gets its JSON answers deflated; one that does not, and file bytes, never. */
test("answers are compressed only for a device that asked, and never a file", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  for (let i = 0; i < 40; i++) f.store.createBot({ name: `Bot ${i}`, duties: "the same duties text again and again", boundaries: "" });
  const plain = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" });
  expect(plain.status).toBe(200);
  expect(c.compressed).toEqual([]);
  const asked = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/features", body: { compress: ["deflate-raw"] } });
  expect(asked.body).toEqual({ compress: "deflate-raw" });
  const bots = { v: 1 as const, id: ulid(), method: "GET" as const, path: "/v1/bots" };
  const packed = await c.rpc(bots);
  expect(packed.body.items).toHaveLength(40);
  expect(c.compressed).toEqual([bots.id]);
  // A file keeps its bytes as they are, whatever the device asked for.
  writeFileSync(join(f.root, "notes.md"), "same line\n".repeat(500));
  const file = { v: 1 as const, id: ulid(), method: "GET" as const, path: "/v1/workspace/file", query: { path: "notes.md" } };
  await c.rpc(file);
  expect(c.compressed).not.toContain(file.id);
  // Asking for nothing turns it off again.
  await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/features", body: { compress: [] } });
  const again = { ...bots, id: ulid() };
  await c.rpc(again);
  expect(c.compressed).not.toContain(again.id);
});

test("real relay budget supports 50MiB and concurrent 1MiB GETs, cancellation and paged snapshot", async () => {
  const f = await fixture(), a = await f.pair(), b = await f.pair();
  const bot = f.store.createBot({ name: "Large snapshot", duties: "", boundaries: "" });
  for (let n = 0; n < 32; n++) f.store.createSkill({ bot_id: bot.bot.id, name: `large-${n}`, description: "fixture", body: "x".repeat(32000) });
  const extra = f.store.createBot({ name: "Extra snapshot", duties: "", boundaries: "" });
  f.store.createSkill({ bot_id: extra.bot.id, name: "extra", description: "fixture", body: "x".repeat(32000) });
  const ca = await f.connect(a), cb = await f.connect(b);
  const large = Buffer.alloc(50 * 1024 * 1024, 0x6a), small = Buffer.alloc(1024 * 1024, 0x37);
  writeFileSync(join(f.root, "large.bin"), large); writeFileSync(join(f.root, "small.bin"), small);
  const started = Date.now();
  const [big, little] = await Promise.all([ca.download("large.bin"), cb.download("small.bin")]);
  expect(big.hash).toBe(createHash("sha256").update(large).digest("hex"));
  expect(little.hash).toBe(createHash("sha256").update(small).digest("hex"));
  expect(Date.now() - started).toBeGreaterThan(20_000);
  const state = await ca.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/snapshot" });
  expect(state.body.skills).toHaveLength(33); expect(state.snapshotPage.count).toBeGreaterThan(1);
  const late = Buffer.alloc(4); late.writeUInt32BE(big.streamId);
  ca.socket.send(new Uint8Array(ca.noise.send(6, late)));
  expect((await ca.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" })).status).toBe(200);
  const meta = await cb.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "large.bin" } });
  const cancel = Buffer.alloc(4); cancel.writeUInt32BE(meta.file.streamId);
  cb.socket.send(new Uint8Array(cb.noise.send(6, cancel)));
  for (;;) {
    const frame = cb.noise.receive(await cb.next() as Uint8Array);
    if (frame.type === 6) { expect(new DataView(frame.body.buffer, frame.body.byteOffset, 4).getUint32(0)).toBe(meta.file.streamId); break; }
    expect(frame.type).toBe(5);
  }
  expect((await cb.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" })).status).toBe(200);
}, 90_000);

test("recovery at equal epoch advances native highwater and a restored old grant fails", async () => {
  const f = await fixture(), d = await f.pair(), pin = f.controller.trust.device(d.deviceId)!;
  const kinds: string[] = [];
  const prepare = f.native.client.prepare.bind(f.native.client);
  const preparedNative = spyOn(f.native.client, "prepare").mockImplementation(async (action) => { kinds.push(action.kind); return prepare(action); });
  const prepared = await f.controller.prepareRecovery();
  expect(kinds).toEqual(["recover_trust"]); preparedNative.mockRestore();
  await f.controller.confirmRecovery(f.native.confirm(prepared.challenge));
  expect(f.native.highwater).toBe(2); expect(f.controller.trust.host()!.generation).toBe(2);
  f.store.db.run("UPDATE remote_host SET generation = 1"); f.store.db.run("UPDATE remote_devices SET revoked = 0, generation = 1");
  await expect(f.controller.trust.reconcile()).rejects.toThrow(); expect(f.controller.trust.trusted(pin)).toBe(false);
});

test("more than one relay control burst of revoked history reconciles once and survives reconnect", async () => {
  const f = await fixture(), d = await f.pair();
  f.controller.stop();
  f.store.db.run("UPDATE remote_devices SET revoked = 1, relay_pending = 1");
  for (let n = 0; n < 72; n++) {
    const keys = identityPublic(generateIdentity());
    f.store.db.run(`INSERT INTO remote_devices(device_id,name,ua_hint,dh_pk,signing_pk,enrollment_pk,grant_epoch,generation,revoked,pairing_id,onboarding_until)
      VALUES (?, 'old', '', ?, ?, ?, 1, 1, 1, ?, 0)`, [ulid(), base64url(keys.dh), base64url(keys.signing), base64url(keys.enrollment), ulid()]);
  }
  await f.controller.start(); expect(f.controller.status().state).toBe("online");
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM remote_devices WHERE relay_pending = 1").get()!.n).toBe(0);
  f.controller.stop(); await f.controller.start(); expect(f.controller.status().state).toBe("online");
  expect(f.controller.trust.device(d.deviceId)!.revoked).toBe(1);
}, 15_000);

test("trusted native renewal reopens only the current paired Split session", async () => {
  const f = await fixture(), d = await f.pair(), first = await f.connect(d);
  const closed = new Promise<void>(resolve => first.socket.addEventListener("close", () => resolve(), { once: true })); first.socket.close(); await closed;
  const second = await f.connect(d);
  expect((await second.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/register-challenge", body: {} })).status).toBe(403);
  const kinds: string[] = [];
  const prepare = f.native.client.prepare.bind(f.native.client);
  const preparedNative = spyOn(f.native.client, "prepare").mockImplementation(async (action) => { kinds.push(action.kind); return prepare(action); });
  const prepared = await f.controller.prepareUvRenewal(d.deviceId);
  expect(kinds).toEqual(["renew_first_uv"]); preparedNative.mockRestore();
  const proof = f.native.confirm(prepared.challenge);
  await f.controller.confirmUvRenewal(proof);
  const challenge = await second.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/register-challenge", body: {} });
  expect(challenge.status).toBe(200);
  expect(challenge.body.binding.sessionId).toBe(base64url(second.noise.authenticatedSessionId));
  await expect(f.controller.confirmUvRenewal(proof)).rejects.toThrow();
});

test("native-confirmed relay, identity and workspace changes persist exact targets", async () => {
  const f = await fixture(), d = await f.pair(), oldKeys = base64url(identityPublic(f.native.keys).signing);
  const next = { hostId: ulid(), origin: "https://next.example.test", relayId: "next" };
  const relay = await f.controller.prepareChange({ kind: "change_relay", config: next });
  await f.controller.confirmChange(f.native.confirm(relay.challenge));
  expect(f.controller.trust.host()).toMatchObject({ relay_origin: next.origin, generation: 2 });
  expect(f.controller.trust.device(d.deviceId)!.revoked).toBe(1);
  f.controller.stop(); await f.controller.trust.reconcile();
  const reset = await f.controller.prepareChange({ kind: "reset_identity", config: { ...next, hostId: ulid() } });
  await f.controller.confirmChange(f.native.confirm(reset.challenge));
  expect(f.native.highwater).toBe(3); expect(base64url(identityPublic(f.native.keys).signing)).not.toBe(oldKeys);
  f.controller.stop(); await f.controller.trust.reconcile();
  const root = join(f.root, "new-workspace"); mkdirSync(root);
  const workspace = await f.controller.prepareChange({ kind: "change_workspace", path: root });
  await f.controller.confirmChange(f.native.confirm(workspace.challenge));
  expect(f.store.workspacePath()).toBe(root.replace(/^\/var\//, "/private/var/"));
}, 30_000);

test("native reset crash intent fails closed, native-done relay transition reconciles, target tampering denies", async () => {
  const f = await fixture(), d = await f.pair();
  const change = { kind: "change_relay" as const, config: { origin: ORIGIN, relayId: "fixture", hostId: ulid() } };
  const staged = await f.controller.prepareChange(change);
  f.store.db.run("UPDATE remote_devices SET signing_pk = ? WHERE device_id = ?", [base64url(identityPublic(generateIdentity()).signing), d.deviceId]);
  await expect(f.controller.confirmChange(f.native.confirm(staged.challenge))).rejects.toThrow();
  expect(f.native.highwater).toBe(1);
  const prepared = await f.controller.prepareChange(change);
  f.store.db.run("CREATE TRIGGER fail_transition BEFORE UPDATE ON remote_host BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await expect(f.controller.confirmChange(f.native.confirm(prepared.challenge))).rejects.toThrow();
  expect(f.native.highwater).toBe(2);
  expect(f.store.db.query<{ phase: string }, []>("SELECT phase FROM remote_transition").get()!.phase).toBe("native_done");
  await expect(f.controller.trust.reconcile()).rejects.toThrow();
  f.store.db.run("DROP TRIGGER fail_transition");
  await f.controller.start(); expect(f.controller.trust.host()!.generation).toBe(2);
  expect(f.store.db.query("SELECT * FROM remote_transition").get()).toBeNull();
  const reset = await f.controller.prepareChange({ kind: "reset_identity", config: { ...change.config, hostId: ulid() } });
  const original = f.native.client.reset.bind(f.native.client);
  const lost = spyOn(f.native.client, "reset").mockImplementation(async (...args) => { await original(...args); throw new Error("response lost"); });
  await expect(f.controller.confirmChange(f.native.confirm(reset.challenge))).rejects.toThrow(); lost.mockRestore();
  expect(f.native.highwater).toBe(3);
  expect(f.store.db.query<{ phase: string }, []>("SELECT phase FROM remote_transition").get()!.phase).toBe("native_uncertain");
  await f.controller.start(); expect(f.controller.status().state).toBe("trust_mismatch");
  const recovery = await f.controller.prepareRecovery();
  await f.controller.confirmRecovery(f.native.confirm(recovery.challenge));
  expect(f.controller.trust.host()!.generation).toBe(3); expect(f.controller.trust.device(d.deviceId)!.revoked).toBe(1);
});

test("model probe cancellation after stored credential hydration never starts an outbound call", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  let calls = 0;
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { calls++; return Response.json({ data: [{ id: "fixture" }] }); } });
  cleanup.push(() => endpoint.stop(true));
  await f.store.patchSettings({ endpoint_base_url: `http://127.0.0.1:${endpoint.port}`, endpoint_api_key: "fixture-only" });
  let release!: () => void;
  const original = f.store.endpointKey.bind(f.store);
  const held = spyOn(f.store, "endpointKey").mockImplementation(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
  const pin = f.controller.trust.device(d.deviceId)!;
  const pending = f.controller.dispatcher.dispatch({ v: 1, id: ulid(), method: "POST", path: "/v1/models/probe", body: {} },
    { device: pin, sessionId: base64url(c.noise.authenticatedSessionId), active: () => true });
  while (!release) await Bun.sleep(1);
  await f.controller.trust.revoke(d.deviceId, () => f.controller.trust.assert(pin)); release();
  await expect(pending).rejects.toThrow(); held.mockRestore(); expect(calls).toBe(0);
});

test("composer and model probe recheck revocation after credential waits; probes never replay", async () => {
  let calls = 0;
  const f = await fixture({ judge: async () => { calls++; return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null }; },
    complete: async () => { throw new Error("unused"); } });
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { calls++; return Response.json({ data: [{ id: "fixture-model" }] }); } });
  cleanup.push(() => endpoint.stop(true));
  await f.store.patchSettings({ endpoint_base_url: `http://127.0.0.1:${endpoint.port}`, endpoint_api_key: "fixture-only", endpoint_models: ["fixture-model"], endpoint_default_model: "fixture-model" });
  const d = await f.pair(), c = await f.connect(d), bot = f.store.createBot({ name: "Suggestions", duties: "", boundaries: "" });
  const probe: RemoteRequest = { v: 1, id: ulid(), method: "POST", path: "/v1/models/probe", body: {} };
  expect((await c.rpc(probe)).body.models).toEqual(["fixture-model"]);
  expect((await c.rpc(probe)).status).toBe(200); expect(calls).toBe(2);
  expect(f.store.receipts.lookup({ deviceId: d.deviceId, requestId: probe.id })).toBeNull();
  let release!: () => void;
  const original = f.store.settings.bind(f.store);
  const held = spyOn(f.store, "settings").mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
  const pin = f.controller.trust.device(d.deviceId)!;
  const pending = f.controller.dispatcher.dispatch({ v: 1, id: ulid(), method: "GET", path: `/v1/sessions/${bot.direct_session.id}/composer-suggestions` },
    { device: pin, sessionId: base64url(c.noise.authenticatedSessionId), active: () => true });
  while (!release) await Bun.sleep(1);
  await f.controller.trust.revoke(d.deviceId, () => f.controller.trust.assert(pin)); release();
  await expect(pending).rejects.toThrow(); expect(calls).toBe(2); held.mockRestore();
});

test("strict remote history accepts the shared timestamp-plus-ID pagination cursor", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d), bot = f.store.createBot({ name: "History", duties: "", boundaries: "" });
  for (let n = 0; n < 3; n++) f.store.postMessage(bot.direct_session.id, { body: `message${n}` });
  const first = await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/sessions/${bot.direct_session.id}/messages`, query: { limit: "1" } });
  expect(first.body.next).toContain("|");
  const second = await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/sessions/${bot.direct_session.id}/messages`, query: { limit: "1", cursor: first.body.next } });
  expect(second.status).toBe(200); expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
});

test("remote Stop is 204 for missing and terminal direct turns, group rejection and receipts remain", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d), bot = f.store.createBot({ name: "Stop", duties: "", boundaries: "" });
  for (const status of ["running", "stopped", "completed", "interrupted"] as const) {
    const message = f.store.postMessage(bot.direct_session.id, { body: "fixture" });
    const turn = f.store.createTurn({ sessionId: message.session_id, botId: bot.bot.id, triggerMessageId: message.id });
    f.store.setTurnStatus(turn.id, status);
    const request: RemoteRequest = { v: 1, id: ulid(), method: "POST", path: "/v1/turns/stop", body: { turn_id: turn.id } };
    expect((await c.rpc(request)).status).toBe(204); expect((await c.rpc(request)).status).toBe(204);
    expect((await c.rpc({ ...request, id: ulid() })).status).toBe(204);
  }
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/turns/stop", body: { turn_id: ulid() } })).status).toBe(204);
});

test("route contracts reject unknown fields and wrong types across every mutation family before effects", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d), id = ulid();
  const cases: Array<[RemoteRequest["method"], string, Record<string, unknown>]> = [
    ["POST", "/v1/bots", { name: "n", duties: "", boundaries: "" }], ["PATCH", `/v1/bots/${id}`, { name: "n", if_revision: "r" }],
    ["POST", "/v1/providers", { name: "n", base_url: "https://fixture.invalid" }], ["PATCH", `/v1/providers/${id}`, { name: "n", if_revision: "r" }],
    ["POST", "/v1/mcp-servers", { name: "n" }], ["PATCH", `/v1/mcp-servers/${id}`, { enabled: true, if_revision: "r" }],
    ["POST", "/v1/skills", { bot_id: id, name: "n", description: "d", body: "b" }], ["PATCH", `/v1/skills/${id}`, { body: "b", if_revision: "r" }],
    ["POST", "/v1/routines", { bot_id: id, title: "t", instruction: "i", schedule: { kind: "daily", time: "12:00" } }],
    ["PATCH", `/v1/routines/${id}`, { enabled: false, if_revision: "r" }], ["PATCH", `/v1/memories/${id}`, { body: "b", if_revision: "r" }],
    ["POST", "/v1/sessions", { name: "n", members: [id] }], ["POST", `/v1/sessions/${id}/messages`, { body: "b" }],
    ["POST", `/v1/sessions/${id}/members`, { bot_id: id }], ["POST", `/v1/sessions/${id}/read`, {}],
    ["POST", `/v1/approvals/${id}/resolve`, { action: "deny" }], ["POST", `/v1/credential-operations/${id}/resolve`, { action: "cancel" }],
    ["POST", "/v1/allow-rules", { kind_key: "k", scope: "s" }], ["POST", "/v1/models/probe", {}],
    ["PUT", "/v1/workspace/file", { path: "x", content: "y" }], ["PUT", `/v1/messages/${id}/reactions`, { emoji: "x" }],
    ["DELETE", `/v1/bots/${id}`, { if_revision: "r" }], ["PATCH", "/v1/settings", { theme: "dark", if_revision: 1 }],
    ["POST", "/v1/terminals", { cwd: "/tmp" }], ["POST", `/v1/terminals/${id}/input`, { data: "AA==" }],
    ["POST", `/v1/terminals/${id}/resize`, { rows: 24, cols: 80 }], ["POST", `/v1/terminals/${id}/signal`, { signal: "SIGINT" }],
    ["POST", `/v1/terminals/${id}/watch`, { from: 0 }], ["POST", `/v1/terminals/${id}/clear`, {}],
    ["POST", `/v1/terminals/${id}/colors`, { foreground: "#000000", background: "#ffffff", cursor: "#000000", palette: ["#000000"] }],
    ["POST", "/v1/annotations", { target_message_id: id, relpath: "report.md", anchor_kind: "text_range", anchor: { start_line: 1 }, content_sha256: "a".repeat(64), body: "b" }],
    ["PATCH", `/v1/annotations/${id}`, { body: "b", if_revision: "r" }], ["DELETE", `/v1/annotations/${id}`, { if_revision: "r" }],
    ["POST", "/v1/annotations/send", { session_id: id, body: "b", annotation_ids: [id] }],
  ];
  for (const [method, path, body] of cases) {
    expect((await c.rpc({ v: 1, id: ulid(), method, path, body: { ...body, unknown_property: true } })).status).toBe(422);
    for (const key of Object.keys(body)) {
      expect(() => validateBusiness({ v: 1, id: ulid(), method, path, body: { ...body, [key]: { wrong: true } } })).toThrow();
    }
  }
  for (const path of ["/v1/bots", "/v1/search", "/v1/workspace/file", `/v1/sessions/${id}/messages`, "/v1/annotations"]) {
    expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path, query: { unknown: "true" } })).status).toBe(422);
  }
  expect(f.store.listBots()).toHaveLength(0);
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n).toBe(0);
});

test("route contracts reject prototype field names on body and query before effects and keep the session", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Proto", duties: "", boundaries: "" });
  const prototypeKeys = ["constructor", "toString", "valueOf", "toLocaleString", "__proto__", "__defineGetter__"] as const;
  const withKey = (base: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> =>
    Object.defineProperty({ ...base }, key, { value, enumerable: true, configurable: true, writable: true });
  const receipts = () => f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n;
  const revisions = () => f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM profile_revisions").get()!.n;
  const beforeReceipts = receipts(), beforeRevisions = revisions(), updated = bot.bot.updated_at;
  const invalid = (request: RemoteRequest) => {
    try { validateBusiness(request); throw new Error("expected invalid_args"); }
    catch (error) { expect(error).toBeInstanceOf(HttpError); expect((error as HttpError).status).toBe(422); expect((error as HttpError).code).toBe("invalid_args"); }
  };
  for (const key of prototypeKeys) {
    const extra = key === "__proto__" ? { x: 1 } : true;
    expect((await c.rpc({ v: 1, id: ulid(), method: "PATCH", path: `/v1/bots/${bot.bot.id}`,
      body: withKey({ if_revision: updated }, key, extra) })).status).toBe(422);
    expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/bots",
      body: withKey({ name: "n", duties: "", boundaries: "" }, key, extra) })).status).toBe(422);
    invalid({ v: 1, id: ulid(), method: "GET", path: "/v1/bots", query: withKey({}, key, "1") as Record<string, string> });
  }
  expect((await c.rpc({ v: 1, id: ulid(), method: "PATCH", path: `/v1/bots/${bot.bot.id}`,
    body: withKey({ if_revision: updated }, "constructor", true) })).status).toBe(422);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/bots",
    body: withKey({ name: "Extra", duties: "", boundaries: "" }, "constructor", true) })).status).toBe(422);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots", query: { constructor: "1" } })).status).toBe(422);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots", query: withKey({}, "__proto__", "1") as Record<string, string> })).status).toBe(422);
  const poisoned: Record<string, unknown> = { name: "n", duties: "", boundaries: "" };
  Object.defineProperty(poisoned, "name", { get() { throw new TypeError("illegal getter"); }, enumerable: true });
  invalid({ v: 1, id: ulid(), method: "POST", path: "/v1/bots", body: poisoned });
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/bots" })).status).toBe(200);
  expect(f.store.listBots()).toHaveLength(1);
  expect(f.store.getBot(bot.bot.id).updated_at).toBe(updated);
  expect(revisions()).toBe(beforeRevisions);
  expect(receipts()).toBe(beforeReceipts);
});

test("lifecycle failure and restart never manufacture a success receipt, error codes survive encryption", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d), auth = authenticator();
  const principal = { device: f.controller.trust.device(d.deviceId)!, sessionId: base64url(c.noise.authenticatedSessionId), active: () => true };
  const reg = f.controller.dispatcher.uv.registrationChallenge(principal, ulid());
  await f.controller.dispatcher.uv.register(principal, reg.challenge, auth.registration(reg));
  const operation = { action: "quiesce.begin", targetId: "runtime", requestId: ulid() };
  const challenge = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/challenge", body: { operation } });
  const assertion = auth.assertion(challenge.body);
  const request: RemoteRequest = { v: 1, id: operation.requestId, method: "POST", path: "/remote/action", body: { operation, challenge: challenge.body.challenge,
    assertion: { credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON), authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature) } } };
  const effect = spyOn(f.api.quiesce, "begin").mockImplementation(() => { throw new Error("fixture-secret-path"); });
  const failed = await c.rpc(request); expect(failed.status).toBe(503); expect(failed.body.error.code).toBe("lifecycle_failed");
  expect(JSON.stringify(failed)).not.toContain("fixture-secret-path"); expect((await c.rpc(request)).status).toBe(503); expect(effect).toHaveBeenCalledTimes(1); effect.mockRestore();
  f.store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'quiesce.begin')", [d.deviceId, request.id]);
  f.store.db.run("UPDATE request_receipts SET status = 202 WHERE device_id = ? AND request_id = ?", [d.deviceId, request.id]);
  recoverLifecycle(f.store);
  const unknown = await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${request.id}` });
  expect(unknown.body.error.code).toBe("lifecycle_unknown"); expect(f.api.quiesce.state().phase).toBe("running");
  const bot = f.store.createBot({ name: "Codes", duties: "", boundaries: "" }); f.api.quiesce.begin();
  const rejected: RemoteRequest = { v: 1, id: ulid(), method: "POST", path: `/v1/sessions/${bot.direct_session.id}/messages`, body: { body: "not persisted" } };
  expect((await c.rpc(rejected)).body.error.code).toBe("draining");
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${rejected.id}` })).body.error.code).toBe("draining");
  f.store.receipts.prune(Date.now(), 0);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${rejected.id}` })).body.error.code).toBe("receipt_expired");
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${ulid()}` })).body.error.code).toBe("not_found");
});

test("force lifecycle receipt remains pending until started work settles and never replays on retry", async () => {
  const f = await fixture(), scope = { deviceId: "fixture", requestId: ulid() };
  f.store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
    VALUES (?, ?, ?, 'POST', '/remote/action', 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
    [scope.deviceId, scope.requestId, "a".repeat(64), Date.now()]);
  f.store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'quiesce.force')", [scope.deviceId, scope.requestId]);
  let release!: () => void;
  const waiting = spyOn(f.api.quiesce, "wait").mockImplementation(() => new Promise(resolve => { release = () => resolve({ phase: "drained", remaining: [], forced: true }); }));
  const pending = finishLifecycle(f.store, f.api, scope, "quiesce.force");
  expect(f.store.receipts.read(scope).status).toBe(202);
  f.store.receipts.prune(Date.now() + 10 * 86400_000, 0);
  expect(f.store.receipts.read(scope).status).toBe(202);
  release(); expect((await pending).status).toBe(204); waiting.mockRestore();
  expect(f.store.receipts.read(scope).status).toBe(204);
});

test("wire errors preserve pending credentials, superseded receipt, revision conflict and bounded categories", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const held = spyOn(f.endpointKeys, "set").mockRejectedValue(new Error("fixture locked"));
  const id = ulid();
  const request: RemoteRequest = { v: 1, id, method: "POST", path: "/v1/providers", body: { name: "Pending", base_url: "https://fixture.invalid", api_key: "secret" } };
  const pending = await c.rpc(request); expect(pending.status).toBe(503); expect(pending.body.error.code).toBe("key_write_pending"); held.mockRestore();
  const operations = f.store.listCredentialOperations(); expect(operations).toHaveLength(1);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/credential-operations/${operations[0]!.id}/resolve`, body: { action: "cancel" } })).status).toBe(204);
  expect((await c.rpc(request)).body.error.code).toBe("credential_superseded");
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${id}` })).body.error.code).toBe("credential_superseded");
  const bot = f.store.createBot({ name: "Revision", duties: "", boundaries: "" });
  expect((await c.rpc({ v: 1, id: ulid(), method: "PATCH", path: `/v1/bots/${bot.bot.id}`, body: { name: "Changed", if_revision: "stale" } })).body.error.code).toBe("conflict");
});

test("remote chat uses the actual engine and event stream, not a parallel business implementation", async () => {
  const f = await fixture({ judge: async () => ({ content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null }),
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
  expect(JSON.stringify(c.events)).toContain("message.created");
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
  expect(jsonFile.body).toBeNull();
  expect(jsonFile.file).toEqual({ streamId: 0, size: 13, bytes: base64url(Buffer.from('{"file":true}')) });
  expect(new TextDecoder().decode(fromBase64url(jsonFile.file.bytes))).toBe('{"file":true}');
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

test("connected device activity is recorded and local removal revokes the selected device", async () => {
  const f = await fixture(), d = await f.pair();
  expect(f.controller.trust.device(d.deviceId)!.last_active_at).toBeGreaterThan(0);
  f.store.db.run("UPDATE remote_devices SET last_active_at = 1 WHERE device_id = ?", [d.deviceId]);
  const c = await f.connect(d);
  const activeAt = f.controller.trust.device(d.deviceId)!.last_active_at;
  expect(activeAt).toBeGreaterThan(1);
  const listed = await dispatchLocalSetup(f.controller, { operation: "list_devices" }) as { items: Array<{ id: string; name: string; lastActiveAt: number }> };
  expect(listed.items).toEqual([{ id: d.deviceId, name: "Fixture device", lastActiveAt: activeAt }]);
  const prepared = await dispatchLocalSetup(f.controller, { operation: "prepare_remove_device", deviceId: d.deviceId }) as { challenge: string };
  const closed = new Promise<void>(resolve => c.socket.addEventListener("close", () => resolve(), { once: true }));
  await dispatchLocalSetup(f.controller, { operation: "confirm_remove_device", proof: f.native.confirm(prepared.challenge) });
  await closed;
  expect(f.controller.trust.device(d.deviceId)!.revoked).toBe(1);
  expect((await f.controller.listDevices())).toEqual([]);
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
    judge: async () => ({ content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null }),
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

test("authenticated push subscribe stores the endpoint and revoke deletes it without resolving inbox", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const ecdh = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const p256dh = base64url(Buffer.concat([Buffer.from([4]), Buffer.from(ecdh.x!, "base64url"), Buffer.from(ecdh.y!, "base64url")]));
  const auth = base64url(randomBytes(16));
  const endpoint = "https://web.push.apple.com/v1/push/isolated";

  // Legacy subscribe format returns 409 client_upgrade_required in PR6
  const legacy = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/push/subscribe",
    body: { endpoint, p256dh, auth } });
  expect(legacy.status).toBe(409);

  // Read VAPID public state
  const pushStateRes = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/remote/push" });
  expect(pushStateRes.status).toBe(200);
  const pushState = pushStateRes.body as { vapid_key_fingerprint: string; device_revision: number };

  const sub = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/push/subscribe",
    body: {
      mode: "enable",
      if_device_revision: pushState.device_revision,
      application_server_key_fingerprint: pushState.vapid_key_fingerprint,
      endpoint,
      p256dh,
      auth,
    } });
  expect(sub.status).toBe(204);
  const row = f.store.db.query<{ endpoint: string }, [string]>("SELECT endpoint FROM remote_push_subs WHERE device_id = ?").get(d.deviceId);
  expect(row?.endpoint).toBe(endpoint);
  const denied = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/push/subscribe",
    body: {
      mode: "enable",
      if_device_revision: 1,
      application_server_key_fingerprint: pushState.vapid_key_fingerprint,
      endpoint: "https://evil.example/push",
      p256dh,
      auth,
    } });
  expect(denied.status).toBe(422);
  const bot = f.store.createBot({ name: "Inbox", duties: "fixture", boundaries: "fixture" });
  const trigger = f.store.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: "user", body: "go" });
  const turn = f.store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: trigger.id });
  const approval = f.store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-write", summary: "card", target: "/tmp/x" });
  await f.controller.trust.revoke(d.deviceId, () => f.controller.trust.assertHost());
  expect(f.store.db.query("SELECT 1 FROM remote_push_subs WHERE device_id = ?").get(d.deviceId)).toBeNull();
  expect(f.store.getApproval(approval.id).status).toBe("pending");
});

test("encrypted push tests recover expired retries and preserve a live delivery with a safe error code", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  let now = Date.now();
  const clock = spyOn(f.controller.push, "now").mockImplementation(() => now);
  cleanup.push(() => { clock.mockRestore(); });
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const state = await f.controller.push.publicState(d.deviceId);
  f.controller.push.subscribe(d.deviceId, {
    mode: "enable", if_device_revision: state.device_revision,
    application_server_key_fingerprint: state.vapid_key_fingerprint,
    endpoint: "https://fcm.googleapis.com/fcm/send/isolated",
    p256dh: base64url(Buffer.concat([Buffer.from([4]), Buffer.from(key.x!, "base64url"), Buffer.from(key.y!, "base64url")])),
    auth: base64url(randomBytes(16)),
  });
  const expired = ulid();
  f.store.db.run(`INSERT INTO notification_deliveries
    (delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref, state, attempt,
     next_attempt_at, absolute_expires_at, push_generation, trust_generation, error_code, created_at)
    VALUES (?, ?, 'remote_push', ?, 0, ?, 'retry_wait', 2, ?, ?, ?, 1, 'timeout', ?)`,
  [expired, d.deviceId, `test:${expired}`, ulid(), now - 60_000, now - 1, state.push_generation + 1, now - 120_000]);
  const send = () => c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/push/test", body: {} });
  const first = await send();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ ok: true, status: "queued", error_code: "network_error" });
  expect(f.store.db.query<{ state: string }, [string]>("SELECT state FROM notification_deliveries WHERE delivery_id = ?").get(expired)?.state).toBe("expired");
  now += 60_000;
  const busy = await send();
  expect(busy.status).toBe(409);
  expect(busy.body.error.code).toBe("push_pending");
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM notification_deliveries WHERE state = 'retry_wait'").get()?.n).toBe(1);
  now += 60_000;
  expect((await send()).status).toBe(200);
});

test("pair native proof is single use and bound to authoritative keys, not browser UV claims", async () => {
  const f = await fixture(), qr = await f.controller.openPair();
  await expect(f.controller.confirmPair(qr.pairingId, Buffer.from(randomBytes(32)).toString("base64"))).rejects.toThrow();
  expect(f.controller.trust.devices()).toHaveLength(0);
  const d = await f.pair(), c = await f.connect(d);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/action", body: { uv: true, credentialId: "claimed" } })).status).toBe(403);
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/challenge", body: { operation: { action: "quiesce.force", targetId: "runtime", requestId: ulid() } } })).status).toBe(403);
});

test("remote oversize text PUT keeps too_large on the Noise body", () => {
  expect(remoteError("too_large").error.code).toBe("too_large");
});

test("host browse lists directories, rejects other homes, and returns typed permission errors", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  mkdirSync(join(f.root, "keep"));
  writeFileSync(join(f.root, "note.md"), "hi");
  const page = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/host/tree", query: { path: f.root } });
  expect(page.status).toBe(200);
  expect(page.body.items.map((row: { name: string }) => row.name)).toContain("keep");
  expect(page.body.items.map((row: { name: string }) => row.name)).toContain("note.md");
  const denied = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/host/tree", query: { path: "/Users/not-this-user" } });
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("host_permission");
});

test("duplex upload commits after EOF hash and rejects bad offset, hash, cap and extra streams", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Files", duties: "", boundaries: "" });
  const bytes = Buffer.from("hello-remote");
  const ok = await c.upload(bot.direct_session.id, "ok.txt", bytes);
  expect(ok.status).toBe(201);
  expect(existsSync(join(f.root, "inbox", "ok.txt"))).toBe(true);
  expect(readFileSync(join(f.root, "inbox", "ok.txt")).toString()).toBe("hello-remote");
  const badHash = await c.upload(bot.direct_session.id, "bad.txt", bytes, { hash: "a".repeat(64) });
  expect(badHash.status).toBeGreaterThanOrEqual(400);
  expect(existsSync(join(f.root, "inbox", "bad.txt"))).toBe(false);
  const badOffset = await c.upload(bot.direct_session.id, "off.txt", bytes, { offset: 3 });
  expect(badOffset.status).toBeGreaterThanOrEqual(400);
  const cancelled = await c.upload(bot.direct_session.id, "cancel.txt", bytes, { cancel: true });
  expect(cancelled.status).toBeGreaterThanOrEqual(400);
  expect(existsSync(join(f.root, "inbox", "cancel.txt"))).toBe(false);
  const oversize = await c.rpc({
    v: 1, id: ulid(), method: "POST", path: `/v1/sessions/${bot.direct_session.id}/messages`,
    body: { body: "x", parent_id: null, fork: false, ask_id: null, files: [{ filename: "big.bin", size: 50 * 1024 * 1024 + 1, sha256: "a".repeat(64) }] },
  });
  expect(oversize.status).toBe(413);
});

test("same request id replays a committed attachment POST without staged files", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Replay", duties: "", boundaries: "" });
  const bytes = Buffer.from("hello-remote");
  const first = await c.upload(bot.direct_session.id, "ok.txt", bytes);
  expect(first.status).toBe(201);
  const id = first.id as string;
  expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true);
  const replay = await c.rpc({
    v: 1, id, method: "POST", path: `/v1/sessions/${bot.direct_session.id}/messages`,
    body: { body: "ok.txt", parent_id: null, fork: false, ask_id: null,
      files: [{ filename: "ok.txt", size: bytes.length, sha256: sha256Hex(bytes) }] },
  });
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(first.body);
  expect(f.store.listMessages(bot.direct_session.id).items.filter((row) => row.kind === "user")).toHaveLength(1);
  expect(existsSync(join(f.root, "inbox", "ok2.txt"))).toBe(false);
});

test("remote workspace PUT requires If-Match and returns 409 after an external rewrite", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  writeFileSync(join(f.root, "note.txt"), "old");
  const got = await c.download("note.txt");
  const etag = `"${got.hash}"`;
  writeFileSync(join(f.root, "note.txt"), "rewritten");
  const conflict = await c.rpc({ v: 1, id: ulid(), method: "PUT", path: "/v1/workspace/file", body: { path: "note.txt", content: "mine" }, ifMatch: etag });
  expect(conflict.status).toBe(409);
  const missing = await c.rpc({ v: 1, id: ulid(), method: "PUT", path: "/v1/workspace/file", body: { path: "note.txt", content: "mine" } });
  expect(missing.status).toBe(422);
});

test("two concurrent remote streams stay at the per-device ceiling", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const bot = f.store.createBot({ name: "Ceil", duties: "", boundaries: "" });
  const extra = await c.rpc({
    v: 1, id: ulid(), method: "POST", path: `/v1/sessions/${bot.direct_session.id}/messages`,
    body: { body: "x", parent_id: null, fork: false, ask_id: null, files: [
      { filename: "a.txt", size: 1, sha256: "a".repeat(64) },
      { filename: "b.txt", size: 1, sha256: "b".repeat(64) },
      { filename: "c.txt", size: 1, sha256: "c".repeat(64) },
    ] },
  });
  expect(extra.status).toBe(429);
}, 15_000);

async function signedUv(f: Awaited<ReturnType<typeof fixture>>, d: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["pair"]>>, c: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>>) {
  const auth = authenticator();
  const principal = { device: f.controller.trust.device(d.deviceId)!, sessionId: base64url(c.noise.authenticatedSessionId), active: () => true };
  const reg = f.controller.dispatcher.uv.registrationChallenge(principal, ulid());
  await f.controller.dispatcher.uv.register(principal, reg.challenge, auth.registration(reg));
  let count = 1;
  function nextAssertion(record: Parameters<typeof auth.assertion>[0]) {
    return auth.assertion(record, count++);
  }
  async function act(action: string, path: string, extra: Record<string, unknown> = {}, rpc = c.rpc) {
    const operation = { action, targetId: "runtime", requestId: ulid() };
    const challenge = await rpc({ v: 1, id: ulid(), method: "POST", path: "/remote/uv/challenge", body: { operation, ...extra } });
    const assertion = nextAssertion(challenge.body);
    return rpc({ v: 1, id: operation.requestId, method: "POST", path, body: { operation, challenge: challenge.body.challenge, assertion: {
      credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON),
      authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature),
    }, ...extra } });
  }
  return { auth, principal, act, nextAssertion };
}

test("maintenance status is redacted and diagnostics omit names bodies paths and secrets", async () => {
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d);
  f.store.createBot({ name: "SecretBot", duties: "/Users/secret/path", boundaries: "api-key-CANARY" });
  const status = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/remote/status" });
  expect(status.status).toBe(200);
  expect(status.body.version).toBe("0.1.0-rc.2");
  expect(status.body.mode).toBe("window");
  expect(status.body.restart).toBe("available");
  expect(status.body.reachability).toBe("online");
  const dump = JSON.stringify(status);
  expect(dump).not.toContain("SecretBot");
  expect(dump).not.toContain("/Users/secret");
  expect(dump).not.toContain("api-key-CANARY");
  const peek = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/remote/diagnostics" });
  expect(peek.status).toBe(200);
  expect(JSON.stringify(peek)).not.toContain("SecretBot");
  const { act } = await signedUv(f, d, c);
  const report = await act("diagnostics.download", "/remote/action");
  expect(report.status).toBe(200);
  expect(report.body.counts.bots).toBe(1);
  expect(JSON.stringify(report)).not.toContain("SecretBot");
  expect(JSON.stringify(report)).not.toContain("/Users/secret");
  expect(JSON.stringify(report)).not.toContain("api-key-CANARY");
});

test("empty live-set drain restart records receipt, exits without latch, and reconnect does not restart again", async () => {
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d), { principal, nextAssertion } = await signedUv(f, d, c);
  const operation = { action: "runtime.restart", targetId: "runtime", requestId: ulid() };
  const issued = f.controller.dispatcher.uv.issue(principal, operation.requestId, operation.action, "runtime",
    requestDigest({ method: "POST", path: "/remote/runtime/restart", body: { ...operation, force: false }, encoding: "json" }));
  const assertion = nextAssertion(issued);
  const request = { v: 1 as const, id: operation.requestId, method: "POST" as const, path: "/remote/runtime/restart", body: {
    operation, force: false, challenge: issued.challenge, assertion: {
      credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON),
      authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature),
    } } };
  const first = await c.rpc(request);
  expect(first.status).toBe(200);
  expect(first.body.latch).toBe(false);
  expect(f.maint!.exits).toEqual(["restart"]);
  expect(f.maint!.maint.lifecycle.isStopped()).toBe(false);
  expect(await c.rpc(request)).toEqual(first);
  const lookup = await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${operation.requestId}` });
  expect(lookup.status).toBe(200);
  expect(f.maint!.exits).toEqual(["restart"]);
});

test("force restart requires a new UV bound to force true and never auto-forces on wait cancel", async () => {
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d), { act, principal, nextAssertion } = await signedUv(f, d, c);
  const bot = f.store.createBot({ name: "Live", duties: "", boundaries: "" });
  const message = f.store.postMessage(bot.direct_session.id, { body: "hold" });
  f.store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: message.id });
  const abort = new AbortController();
  const drained = spyOn(f.api.quiesce, "wait").mockImplementation((signal?: AbortSignal) => new Promise((_, reject) => {
    const fail = () => reject(new HttpError(409, "cancelled", "drain wait cancelled"));
    if (signal?.aborted) fail();
    signal?.addEventListener("abort", fail, { once: true });
  }));
  const operation = { action: "runtime.restart", targetId: "runtime", requestId: ulid() };
  const issued = f.controller.dispatcher.uv.issue(principal, operation.requestId, operation.action, "runtime",
    requestDigest({ method: "POST", path: "/remote/runtime/restart", body: { ...operation, force: false }, encoding: "json" }));
  const assertion = nextAssertion(issued);
  const pending = f.controller.dispatcher.dispatch({
    v: 1, id: operation.requestId, method: "POST", path: "/remote/runtime/restart",
    body: { operation, force: false, challenge: issued.challenge, assertion: {
      credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON),
      authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature),
    } },
  }, { ...principal, signal: abort.signal });
  await Bun.sleep(10);
  abort.abort();
  const cancelled = await pending;
  expect(cancelled.status).toBe(409);
  expect(JSON.parse(await cancelled.text()).error.code).toBe("cancelled");
  expect(f.api.quiesce.state().forced).toBe(false);
  expect(f.maint!.exits).toEqual([]);
  drained.mockRestore();
  f.api.quiesce.cancel();
  const reused = f.controller.dispatcher.uv.issue(principal, ulid(), "runtime.restart", "runtime",
    requestDigest({ method: "POST", path: "/remote/runtime/restart", body: { action: "runtime.restart", targetId: "runtime", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", force: true }, encoding: "json" }));
  await expect(f.controller.dispatcher.uv.assertion(principal, reused.challenge, reused.binding, assertion)).rejects.toThrow();
  const forced = await act("runtime.restart", "/remote/runtime/restart", { force: true });
  expect(forced.status).toBe(200);
  expect(forced.body.forced).toBe(true);
  expect(f.maint!.exits).toEqual(["restart"]);
});

test("stop writes the latch then exits and is not mixed with restart", async () => {
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d), { act } = await signedUv(f, d, c);
  const stopped = await act("runtime.stop", "/remote/runtime/stop");
  expect(stopped.status).toBe(200);
  expect(stopped.body.latch).toBe(true);
  expect(f.maint!.maint.lifecycle.isStopped()).toBe(true);
  expect(f.maint!.exits).toEqual(["stop"]);
  expect(restartAvailable(f.maint!.maint.lifecycle, () => true)).toBe(false);
  const mixed = await act("runtime.restart", "/remote/runtime/stop");
  expect(mixed.status).toBe(403);
});

test("no supervisor marks restart unavailable and loopback still rejects maintenance writes", async () => {
  const none = maintControl(mkdtempSync(join(tmpdir(), "rb-rc11-none-")), "none", false);
  expect(restartAvailable(none.maint.lifecycle, () => false)).toBe(false);
  const gone = maintControl(mkdtempSync(join(tmpdir(), "rb-rc11-gone-")), "window", false);
  expect(restartAvailable(gone.maint.lifecycle, () => false)).toBe(false);
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d);
  f.maint!.setAlive(false);
  expect((await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/remote/status" })).body.restart).toBe("unavailable");
  const local = createLocalApi({ store: f.store, token: "local", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: local.fetch, websocket: local.websocket });
  cleanup.push(async () => { local.quiesce.close(); await local.engine.close(); await server.stop(true); });
  for (const path of ["/remote/runtime/restart", "/remote/runtime/stop", "/remote/diagnostics"]) {
    expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { Authorization: "Bearer local" }, body: "{}" })).status).toBe(404);
  }
  expect((await fetch(`http://127.0.0.1:${server.port}/remote/diagnostics`, { headers: { Authorization: "Bearer local" } })).status).toBe(404);
});

test("long drain wait never auto-forces and a second restart is 409 while draining", async () => {
  const f = await fixture(undefined, false, true), d = await f.pair(), c = await f.connect(d), { principal, nextAssertion } = await signedUv(f, d, c);
  const bot = f.store.createBot({ name: "Hold", duties: "", boundaries: "" });
  const message = f.store.postMessage(bot.direct_session.id, { body: "hold" });
  f.store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: message.id });
  let release!: (state: { phase: "drained"; remaining: string[]; forced: boolean }) => void;
  const waiting = spyOn(f.api.quiesce, "wait").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const firstOp = { action: "runtime.restart", targetId: "runtime", requestId: ulid() };
  const issued = f.controller.dispatcher.uv.issue(principal, firstOp.requestId, firstOp.action, "runtime",
    requestDigest({ method: "POST", path: "/remote/runtime/restart", body: { ...firstOp, force: false }, encoding: "json" }));
  const assertion = nextAssertion(issued);
  const pending = f.controller.dispatcher.dispatch({
    v: 1, id: firstOp.requestId, method: "POST", path: "/remote/runtime/restart",
    body: { operation: firstOp, force: false, challenge: issued.challenge, assertion: {
      credentialId: assertion.credentialId, clientDataJSON: base64url(assertion.clientDataJSON),
      authenticatorData: base64url(assertion.authenticatorData), signature: base64url(assertion.signature),
    } },
  }, principal);
  while (!f.maint!.maint.busy) await Bun.sleep(2);
  expect(f.api.quiesce.state().forced).toBe(false);
  const secondOp = { action: "runtime.restart", targetId: "runtime", requestId: ulid() };
  const secondIssued = f.controller.dispatcher.uv.issue(principal, secondOp.requestId, secondOp.action, "runtime",
    requestDigest({ method: "POST", path: "/remote/runtime/restart", body: { ...secondOp, force: false }, encoding: "json" }));
  const secondAssertion = nextAssertion(secondIssued);
  await expect(f.controller.dispatcher.dispatch({
    v: 1, id: secondOp.requestId, method: "POST", path: "/remote/runtime/restart",
    body: { operation: secondOp, force: false, challenge: secondIssued.challenge, assertion: {
      credentialId: secondAssertion.credentialId, clientDataJSON: base64url(secondAssertion.clientDataJSON),
      authenticatorData: base64url(secondAssertion.authenticatorData), signature: base64url(secondAssertion.signature),
    } },
  }, principal)).rejects.toMatchObject({ status: 409, code: "draining" });
  release({ phase: "drained", remaining: [], forced: false });
  const done = await pending;
  expect(done.status).toBe(200);
  waiting.mockRestore();
});

test("caller finishRestart/stop never write a latch on restart and stop stays stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-rc11-finish-"));
  const store = new Store({ filename: join(dir, "host.sqlite"), endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const { maint, exits } = maintControl(dir, "window", true);
  cleanup.push(async () => { api.quiesce.close(); await api.engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const restartScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
    VALUES (?, ?, ?, 'POST', '/remote/runtime/restart', 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
    [restartScope.deviceId, restartScope.requestId, "a".repeat(64), Date.now()]);
  store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'runtime.restart')", [restartScope.deviceId, restartScope.requestId]);
  const restarted = await finishRestart(store, api, maint, restartScope, false);
  expect(restarted.status).toBe(200);
  await Bun.sleep(5);
  expect(exits).toEqual(["restart"]);
  expect(maint.lifecycle.isStopped()).toBe(false);
  maint.busy = null;
  const stopScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
    VALUES (?, ?, ?, 'POST', '/remote/runtime/stop', 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
    [stopScope.deviceId, stopScope.requestId, "b".repeat(64), Date.now()]);
  store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'runtime.stop')", [stopScope.deviceId, stopScope.requestId]);
  expect((await finishStop(store, maint, stopScope)).status).toBe(200);
  await Bun.sleep(5);
  expect(exits).toEqual(["restart", "stop"]);
  expect(maint.lifecycle.isStopped()).toBe(true);
  const report = maintenanceDiagnostics(store, api, maint);
  expect(Object.values(report.counts).every(n => typeof n === "number")).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/\/Users\//);
});

test("post-UV busy conflict finalizes the loser's receipt to 409 and drops its lifecycle row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-rc11-busy-"));
  const store = new Store({ filename: join(dir, "host.sqlite"), endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const { maint, exits } = maintControl(dir, "window", true);
  cleanup.push(async () => { api.quiesce.close(); await api.engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const pending = (scope: { deviceId: string; requestId: string }, path: string, action: string, digest: string) => {
    store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
      VALUES (?, ?, ?, 'POST', ?, 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
      [scope.deviceId, scope.requestId, digest, path, Date.now()]);
    store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, ?)", [scope.deviceId, scope.requestId, action]);
  };
  const leftover = (scope: { deviceId: string; requestId: string }) =>
    store.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) n FROM remote_lifecycle WHERE device_id = ? AND request_id = ?")
      .get(scope.deviceId, scope.requestId)?.n ?? 0;

  maint.busy = "restart";
  const stopScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  pending(stopScope, "/remote/runtime/stop", "runtime.stop", "c".repeat(64));
  const stopped = await finishStop(store, maint, stopScope);
  expect(stopped.status).toBe(409);
  expect(JSON.parse(await stopped.text()).error.code).toBe("draining");
  const stopReceipt = store.receipts.read(stopScope);
  expect(stopReceipt.status).toBe(409);
  expect(JSON.parse(stopReceipt.body!).error.code).toBe("draining");
  expect(leftover(stopScope)).toBe(0);
  expect(exits).toEqual([]);
  expect(maint.busy).toBe("restart");
  expect(maint.lifecycle.isStopped()).toBe(false);

  maint.busy = "stop";
  const restartScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  pending(restartScope, "/remote/runtime/restart", "runtime.restart", "d".repeat(64));
  const restarted = await finishRestart(store, api, maint, restartScope, false);
  expect(restarted.status).toBe(409);
  expect(JSON.parse(await restarted.text()).error.code).toBe("draining");
  const restartReceipt = store.receipts.read(restartScope);
  expect(restartReceipt.status).toBe(409);
  expect(JSON.parse(restartReceipt.body!).error.code).toBe("draining");
  expect(leftover(restartScope)).toBe(0);
  expect(exits).toEqual([]);
  expect(maint.busy).toBe("stop");
});

test("concurrent finishRestart and finishStop do not mix latch and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-rc11-mix-"));
  const store = new Store({ filename: join(dir, "host.sqlite"), endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const { maint, exits } = maintControl(dir, "window", true);
  cleanup.push(async () => { api.quiesce.close(); await api.engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const restartScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  const stopScope = { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: ulid() };
  store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
    VALUES (?, ?, ?, 'POST', '/remote/runtime/restart', 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
    [restartScope.deviceId, restartScope.requestId, "e".repeat(64), Date.now()]);
  store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'runtime.restart')", [restartScope.deviceId, restartScope.requestId]);
  store.db.run(`INSERT INTO request_receipts(device_id,request_id,payload_sha256,method,path,state,status,body,headers,created_at)
    VALUES (?, ?, ?, 'POST', '/remote/runtime/stop', 'complete', 202, '{"state":"lifecycle_pending"}', '{}', ?)`,
    [stopScope.deviceId, stopScope.requestId, "f".repeat(64), Date.now()]);
  store.db.run("INSERT INTO remote_lifecycle VALUES (?, ?, 'runtime.stop')", [stopScope.deviceId, stopScope.requestId]);
  const [restarted, stopped] = await Promise.all([finishRestart(store, api, maint, restartScope, false), finishStop(store, maint, stopScope)]);
  expect([restarted.status, stopped.status].sort()).toEqual([200, 409]);
  await Bun.sleep(5);
  const restartReceipt = store.receipts.read(restartScope);
  const stopReceipt = store.receipts.read(stopScope);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM remote_lifecycle").get()?.n).toBe(0);
  if (restarted.status === 200) {
    expect(JSON.parse(await restarted.text()).latch).toBe(false);
    expect(stopReceipt.status).toBe(409);
    expect(JSON.parse(stopReceipt.body!).error.code).toBe("draining");
    expect(existsSync(maint.lifecycle.latchPath)).toBe(false);
    expect(exits).toEqual(["restart"]);
    expect(maint.lifecycle.isStopped()).toBe(false);
  } else {
    expect(JSON.parse(await stopped.text()).latch).toBe(true);
    expect(restartReceipt.status).toBe(409);
    expect(JSON.parse(restartReceipt.body!).error.code).toBe("draining");
    expect(existsSync(maint.lifecycle.latchPath)).toBe(true);
    expect(exits).toEqual(["stop"]);
  }
});

test("a watched terminal streams to the device that asked, and stops when it stops asking", async () => {
  const helper = (() => { try { return ptyHelperPath(); } catch { return null; } })();
  if (!helper) return;
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);

  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/terminals/x/bogus", body: {} })).status).toBe(404);

  const opened = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/terminals", body: { cwd: f.root, rows: 24, cols: 80 } });
  expect(opened.status).toBe(200);
  const id = opened.body.id as string;

  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/watch`, body: { from: 0 } })).status).toBe(200);
  await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/input`,
    body: { data: Buffer.from("echo REMOTE_MARK\n").toString("base64") } });

  /** Frames only land in `events` while an rpc is in flight, so poll with a harmless one. */
  const streamed = async (): Promise<string> => {
    await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/terminals/${id}` });
    return c.events
      .filter((event): event is { type: string; id: string; data: string } =>
        !!event && typeof event === "object" && (event as { type?: string }).type === "stream" && (event as { id?: string }).id === id)
      .map((event) => Buffer.from(event.data, "base64").toString("utf8"))
      .join("");
  };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(await streamed()).includes("REMOTE_MARK")) await Bun.sleep(100);
  expect(await streamed()).toContain("REMOTE_MARK");

  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/unwatch`, body: {} })).status).toBe(204);
  const seen = (await streamed()).length;
  await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/input`,
    body: { data: Buffer.from("echo AFTER_UNWATCH\n").toString("base64") } });
  await Bun.sleep(400);
  const after = await streamed();
  expect(after).not.toContain("AFTER_UNWATCH");
  expect(after.length).toBe(seen);

  // Keystrokes are not receipted: nothing to replay, nothing stored.
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n).toBe(0);
});

test("a burst of terminal output past one frame reaches the device whole and in order", async () => {
  // A full-screen program redraws in bursts like this. Each window used to send its last 8 KiB
  // and drop the rest, so the phone printed "output outran the reader" into the program's screen.
  const helper = (() => { try { return ptyHelperPath(); } catch { return null; } })();
  if (!helper) return;
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  const opened = await c.rpc({ v: 1, id: ulid(), method: "POST", path: "/v1/terminals", body: { cwd: f.root, rows: 24, cols: 80 } });
  const id = opened.body.id as string;
  expect((await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/watch`, body: { from: 0 } })).status).toBe(200);
  // 40 000 bytes at once, five frames' worth; the marker is computed, so the echoed command is not it.
  await c.rpc({ v: 1, id: ulid(), method: "POST", path: `/v1/terminals/${id}/input`,
    body: { data: Buffer.from("head -c 40000 /dev/zero | tr '\\0' x; echo; echo BURST_$((6*7))\n").toString("base64") } });

  type Frame = { type: string; id: string; offset: number; data: string; skipped?: number };
  const frames = () => c.events.filter((event): event is Frame =>
    !!event && typeof event === "object" && (event as Frame).type === "stream" && (event as Frame).id === id);
  const text = () => frames().map((frame) => Buffer.from(frame.data, "base64").toString("latin1")).join("");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !text().includes("BURST_42")) {
    await c.rpc({ v: 1, id: ulid(), method: "GET", path: `/v1/terminals/${id}` });
    await Bun.sleep(50);
  }
  expect(text()).toContain("x".repeat(40000));
  expect(text()).toContain("BURST_42");
  expect(frames().some((frame) => frame.skipped)).toBe(false);
  // Each frame starts where the one before it ended.
  let next = frames()[0]!.offset;
  for (const frame of frames()) {
    expect(frame.offset).toBe(next);
    next += Buffer.from(frame.data, "base64").length;
  }
  expect((await c.rpc({ v: 1, id: ulid(), method: "DELETE", path: `/v1/terminals/${id}` })).status).toBe(204);
});

test("encrypted media ranges carry 206 metadata and only the selected bytes", async () => {
  const f = await fixture(), d = await f.pair(), c = await f.connect(d);
  writeFileSync(join(f.root, "media.mp4"), "0123456789");
  const response = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "media.mp4", range: "bytes=3-6" } });
  expect(response.status).toBe(206);
  expect(response.headers).toMatchObject({ contentType: "video/mp4", contentRange: "bytes 3-6/10" });
  expect(new TextDecoder().decode(fromBase64url(response.file.bytes))).toBe("3456");
  const invalid = await c.rpc({ v: 1, id: ulid(), method: "GET", path: "/v1/workspace/file", query: { path: "media.mp4", range: "bytes=99-" } });
  expect(invalid.status).toBe(416);
  expect(invalid.headers.contentRange).toBe("bytes */10");
});
