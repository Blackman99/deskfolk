import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApi, type LocalApiOptions } from "./local-api";
import { Store, type EndpointKeyStore } from "./store";
import { memoryKeyStore } from "./secrets";
import { ulid } from "./ids";
// The real browser client is loaded at runtime across the packages' different TS library targets.
const { ApiError } = await import(new URL("../../messenger/src/lib/api.ts", import.meta.url).href);
const { LocalApi: Client } = await import(new URL("../../messenger/src/lib/local-api.ts", import.meta.url).href);
import type { ClientEvent } from "@real-bot/protocol";
import { listWorkspaceDir } from "./workspace-browse";
import { canonicalJson, requestDigest, requestPreimage, normalizeFiles, sha256, type CanonicalEncoder, type DigestFile, type NormalizedFile } from "./request-digest";
import { HttpError } from "./errors";
import { canonicalize, normalizeAttachmentDigests, requestDigest as sharedDigest, requestDigestBytes, sha256Hex, type RequestDigestInput } from "@real-bot/remote/canonical";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function harness(keys: EndpointKeyStore = memoryKeyStore(), extra: Partial<LocalApiOptions> = {}, workspace = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rc02-review-test-")));
  const filename = join(root, "db.sqlite");
  const store = new Store({ filename, endpointKey: keys });
  if (workspace) await store.patchSettings({ workspace_path: root });
  const events: ClientEvent[] = [];
  const api = createLocalApi({ ...extra, store, token: "fixture", schedule: false });
  const socket = { data: { authed: false }, send(value: string) { events.push(JSON.parse(value)); }, close() {} } as unknown as Bun.ServerWebSocket<{ authed: boolean }>;
  api.websocket.open(socket);
  api.websocket.message(socket, JSON.stringify({ type: "auth", token: "fixture" }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const client = new Client({ origin: `http://127.0.0.1:${server.port}`, token: "fixture" });
  const request = (method: string, path: string, body: unknown = {}, id = ulid(), headers: Record<string, string> = {}) => fetch(`${client.endpoint.origin}${path}`, { method, headers: { Authorization: "Bearer fixture", "X-Request-Id": id, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...headers }, body: method === "GET" ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  closes.push(async () => { api.websocket.close(socket); await api.engine.close(); await server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, api, root, filename, client, request, events };
}

test("review1: concurrent internal-symlink uploads reserve canonical targets and hydrate receipts", async () => {
  const h = await harness();
  mkdirSync(join(h.root, "uploads"));
  symlinkSync("uploads", join(h.root, "inbox"));
  const tree = listWorkspaceDir(h.root, "");
  expect(new Set(tree.items.map((item) => item.path)).size).toBe(tree.items.length);
  const bot = h.store.createBot({ name: "fixture", duties: "", boundaries: "" });
  const form = (bytes: string) => { const data = new FormData(); data.set("body", "fixture"); data.append("files", new File([bytes], "same.txt")); return data; };
  const results = await Promise.all(["first", "second"].map((value) => h.request("POST", `/v1/sessions/${bot.direct_session.id}/messages`, form(value))));
  const attachments = await Promise.all(results.map(async (res) => { expect(res.status).toBe(201); return (await res.json() as { attachments: Array<{ workspace_relpath: string; exists: boolean; size: number }> }).attachments[0]!; }));
  expect(new Set(attachments.map((att) => att.workspace_relpath)).size).toBe(2);
  expect(attachments.every((att) => att.exists && att.size > 0)).toBe(true);
  expect(attachments.map((att) => readFileSync(join(h.root, att.workspace_relpath), "utf8")).sort()).toEqual(["first", "second"]);
});

test("review4/5/6: unhealthy inbox cannot block stop/repair; route guards and cross-route revisions agree", async () => {
  const h = await harness();
  symlinkSync(tmpdir(), join(h.root, "inbox"));
  expect((await h.request("PATCH", "/v1/settings", { theme: "dark" })).status).toBe(200);
  expect((await h.request("POST", "/v1/turns/stop")).status).toBe(204);
  const replacement = join(h.root, "replacement"); mkdirSync(replacement);
  expect((await h.request("PATCH", "/v1/settings", { workspace_path: replacement })).status).toBe(200);
  rmSync(replacement, { recursive: true });
  expect((await h.request("PATCH", "/v1/settings", { theme: "light" })).status).toBe(200);
  expect((await h.request("POST", "/v1/turns/stop")).status).toBe(204);
  const bot = h.store.createBot({ name: "fixture", duties: "", boundaries: "" });
  for (const route of ["bots", "providers", "mcp-servers", "skills", "memories", "routines", "sessions", "settings"]) {
    const suffix = route === "settings" ? "" : `/${bot.bot.id}`;
    for (const path of [`/v1//${route}${suffix}`, `/v1/${route}${suffix}/`, `//v1/${route}${suffix}`]) {
      await expect(h.api.dispatchBusiness(new Request(`http://fixture${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duties: "bypass" }) }), { deviceId: "device", requestId: ulid(), requireRevision: true })).rejects.toMatchObject({ status: 422 });
    }
  }
  const provider = await h.store.createProvider({ name: "provider", base_url: "https://example.invalid/old" });
  const old = h.store.settingsCached();
  await h.store.patchProvider(provider.id, { base_url: "https://example.invalid/new" });
  expect(h.store.settingsCached().settings_rev!).toBeGreaterThan(old.settings_rev!);
  const stale = await h.api.dispatchBusiness(new Request("http://fixture/v1/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint_base_url: old.endpoint_base_url, if_revision: old.settings_rev }) }), { deviceId: "device", requestId: ulid(), requireRevision: true });
  expect(stale.status).toBe(409);
  expect(h.store.settingsCached().endpoint_base_url).toBe("https://example.invalid/new");
});

test("routine integration: required revisions, receipt replay and committed journal share one transaction", async () => {
  const h = await harness();
  h.api.engine.fireRoutine = () => null;
  const { bot } = h.store.createBot({ name: "routine", duties: "", boundaries: "" });
  const row = h.store.createRoutine({ bot_id: bot.id, title: "First", instruction: "", enabled: false, schedule: { kind: "daily", time: "09:00" } });
  const path = `/v1/routines/${row.id}`;
  const request = (method: string, body: unknown, requestId = ulid()) => h.api.dispatchBusiness(new Request(`http://fixture${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { deviceId: "routine-device", requestId, requireRevision: true });
  const emitted: ClientEvent[] = [];
  const id = ulid();
  h.store.onCommit((event) => {
    if (!event.event.startsWith("routine.")) return;
    expect(h.store.db.inTransaction).toBe(false);
    expect(h.store.receipts.lookup({ deviceId: "routine-device", requestId: id })?.status).toBe(200);
    emitted.push(event);
  });
  for (const method of ["PATCH", "DELETE"]) {
    for (const if_revision of [undefined, null, 3, ""]) {
      const response = await request(method, if_revision === undefined ? {} : { if_revision });
      expect(response.status).toBe(422);
    }
  }
  expect(emitted).toEqual([]);
  const body = { title: "Second", if_revision: row.updated_at };
  const first = await request("PATCH", body, id);
  expect(first.status).toBe(200);
  const bytes = await first.text();
  const next = h.store.getRoutine(row.id);
  expect(next.title).toBe("Second");
  expect(next.updated_at > row.updated_at).toBe(true);
  expect(emitted.map((event) => event.event)).toEqual(["routine.upsert"]);
  const replay = await request("PATCH", body, id);
  expect(await replay.text()).toBe(bytes);
  expect(emitted).toHaveLength(1);
  for (const method of ["PATCH", "DELETE"]) {
    const staleId = ulid();
    const stale = await request(method, { if_revision: row.updated_at }, staleId);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" } });
    expect((await request(method, { if_revision: row.updated_at }, staleId)).status).toBe(409);
  }
  expect(h.store.getRoutine(row.id)).toEqual(next);
  expect(emitted).toHaveLength(1);
  const deletion = ulid();
  expect((await request("DELETE", { if_revision: next.updated_at }, deletion)).status).toBe(204);
  expect((await request("DELETE", { if_revision: next.updated_at }, deletion)).status).toBe(204);
  expect((await request("DELETE", { if_revision: next.updated_at })).status).toBe(404);
  expect(emitted.map((event) => event.event)).toEqual(["routine.upsert", "routine.removed"]);
});

test("integration review: legacy credential events have exactly one fresh payload per committed phase", async () => {
  const h = await harness();
  const provider = await h.client.createProvider({ name: "phases", base_url: "https://example.invalid", api_key: "fake" });
  expect(h.events.filter((event) => event.event === "provider.upsert").map((event) => event.event === "provider.upsert" && event.key_set)).toEqual([false, true]);
  expect(h.events.filter((event) => event.event === "settings.changed")).toHaveLength(2);
  h.events.length = 0;
  await h.client.patchSettings({ theme: "dark" });
  expect(h.events.map((event) => event.event)).toEqual(["settings.changed"]);
  h.events.length = 0;
  await h.client.deleteProvider(provider.id);
  expect(h.events.filter((event) => event.event === "provider.removed")).toHaveLength(1);
  expect(h.events.filter((event) => event.event === "provider.upsert")).toEqual([]);
  h.events.length = 0;
  await h.client.createMcpServer({ name: "phases", command: "never-run", enabled: false, auth: "fake" });
  expect(h.events.filter((event) => event.event === "mcp.upsert").map((event) => event.event === "mcp.upsert" && event.auth_set)).toEqual([false, true]);
  expect(h.events.some((event) => event.event === "credential_operations.changed")).toBe(false);
});

test("review3/7/8: actual LocalApi retains IDs for explicit create/update/delete retries and commit events stay fresh", async () => {
  let failed = true;
  const keys = memoryKeyStore();
  const held = gate(); const entered = gate(); let hold = false;
  const h = await harness({ get: keys.get, async set(value, name) { if (hold) { entered.resolve(); await held.promise; } if (failed) throw new Error("locked"); await keys.set(value, name); }, async delete(name) { if (failed) throw new Error("locked"); await keys.delete(name); } });
  const body = { name: "one", base_url: "https://example.invalid", api_key: "fake-secret" };
  let id = "";
  try { await h.client.createProvider(body); } catch (error) { expect(error).toBeInstanceOf(ApiError); id = (error as { requestId: string }).requestId; }
  expect(id).toHaveLength(26); expect(h.client.pendingRequests()).toHaveLength(1);
  await expect(h.client.createProvider({ ...body, name: "changed" })).rejects.toMatchObject({ code: "request_pending" });
  failed = false;
  const provider = await h.client.createProvider(body);
  expect(h.store.providersCached()).toHaveLength(1);
  expect(h.client.pendingRequests()).toHaveLength(0);
  failed = true;
  await expect(h.client.patchProvider(provider.id, { api_key: "replacement" })).rejects.toMatchObject({ code: "key_write_pending" });
  failed = false;
  await h.client.patchProvider(provider.id, { api_key: "replacement" });
  hold = true;
  const pending = h.client.createProvider({ ...body, name: "two" });
  await entered.promise;
  await h.client.patchSettings({ theme: "dark" });
  const at = h.events.length;
  held.resolve(); await pending;
  const settingsEvents = h.events.slice(at).filter((event) => event.event === "settings.changed");
  expect(settingsEvents.length).toBeGreaterThan(0);
  expect(settingsEvents.every((event) => event.theme === "dark")).toBe(true);
  failed = true;
  await expect(h.client.deleteProvider(provider.id)).rejects.toMatchObject({ code: "key_write_pending" });
  expect(h.events.some((event) => event.event === "provider.removed" && event.id === provider.id)).toBe(true);
  failed = false; await h.client.deleteProvider(provider.id);
  const mcp = await h.client.createMcpServer({ name: "off", command: "never", enabled: false, auth: "fake" });
  failed = true; await expect(h.client.deleteMcpServer(mcp.id)).rejects.toMatchObject({ code: "key_write_pending" });
  expect(h.events.some((event) => event.event === "mcp.removed" && event.id === mcp.id)).toBe(true);
  failed = false; await h.client.deleteMcpServer(mcp.id);
  expect(h.store.listCredentialOperations()).toHaveLength(0);
});

test("review2: approval-originated failed credential can be repaired after reopen without replaying the tool", async () => {
  let fail = false; let calls = 0; const finished = gate();
  const keys = memoryKeyStore();
  const h = await harness({ get: keys.get, delete: keys.delete, async set(value, name) { if (fail) throw new Error("locked"); await keys.set(value, name); } }, { completions: {
    async judge() { return { content: null, hadToolCalls: false, usage: null, failKind: "unreachable" }; },
    async complete() { calls++; if (calls > 1) finished.resolve(); return { ok: true, content: calls > 1 ? "finished" : "", toolCalls: calls === 1 ? [{ id: "add", name: "add_endpoint", arguments: JSON.stringify({ name: "orphan", base_url: "https://example.invalid" }) }] : [], finishReason: "stop", hadChoices: true, usage: null, missingReason: "endpoint_omitted" }; },
  } });
  const provider = await h.store.createProvider({ name: "model", base_url: "https://example.invalid", api_key: "model-key", models: ["fake"] });
  const bot = h.store.createBot({ name: "bot", duties: "", boundaries: "", model: "fake", provider_id: provider.id });
  const message = h.store.postMessage(bot.direct_session.id, { body: "add endpoint" });
  await h.api.engine.handleInboundMessage(message);
  // Completion and approval park on microtasks; no wall-clock race is used.
  for (let i = 0; i < 100 && !h.store.listApprovals().length; i++) await Promise.resolve();
  const approval = h.store.listApprovals()[0]!;
  expect(approval).toBeDefined(); fail = true;
  const id = ulid();
  expect((await h.request("POST", `/v1/approvals/${approval.id}/resolve`, { action: "allow_once", api_key: "orphan-key" }, id)).status).toBe(200);
  await finished.promise;
  expect(h.store.listCredentialOperations()).toHaveLength(1);
  expect((await h.request("POST", `/v1/approvals/${approval.id}/resolve`, { action: "allow_once", api_key: "orphan-key" }, id)).status).toBe(200);
  const before = calls;
  const reopened = new Store({ filename: h.filename, endpointKey: keys });
  const api = createLocalApi({ store: reopened, token: "fixture", schedule: false });
  const op = reopened.listCredentialOperations()[0]!;
  const response = await api.dispatchBusiness(new Request(`http://fixture/v1/credential-operations/${op.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "repair", value: "repaired" }) }), { deviceId: "local", requestId: ulid() });
  expect(response.status).toBe(204); expect(reopened.listCredentialOperations()).toHaveLength(0); expect(calls).toBe(before);
  expect((await reopened.listProviders()).find((row) => row.name === "orphan")?.key_set).toBe(true);
  await api.engine.close(); reopened.close();
});

test("review2: cancel after physical key write invalidates the old receipt and deletes only the credential", async () => {
  const keys = memoryKeyStore(); let fail = true;
  const h = await harness({ get: keys.get, delete: keys.delete, async set(value, name) { await keys.set(value, name); if (fail) throw new Error("crash after key write"); } });
  const body = { name: "cancel", base_url: "https://example.invalid", api_key: "secret" }; const id = ulid();
  expect((await h.request("POST", "/v1/providers", body, id)).status).toBe(503);
  const op = h.store.listCredentialOperations()[0]!; fail = false;
  expect((await h.request("POST", `/v1/credential-operations/${op.id}/resolve`, { action: "cancel" })).status).toBe(204);
  expect((await h.request("POST", "/v1/providers", body, id)).status).toBe(409);
  expect(h.store.providersCached()).toHaveLength(1);
  expect(h.store.providersCached()[0]!.key_set).toBe(false);
  expect(h.store.listCredentialOperations()).toHaveLength(0);
});

test("review9: out-of-order MCP inspection results cannot overwrite newer connection revisions", async () => {
  const old = gate<{ instructions: string; tools: Array<{ name: string; description: string }> }>(); const next = gate<{ instructions: string; tools: Array<{ name: string; description: string }> }>();
  const h = await harness(memoryKeyStore(), { mcp: { async listChatTools() { return []; }, async listForTurn() { return { tools: [], guides: [] }; }, inspect(server) { return server.command === "old" ? old.promise : next.promise; }, async call() { return { ok: false, error: { code: "disabled", message: "fixture" } }; }, async close() {} } });
  const server = await h.client.createMcpServer({ name: "fixture", command: "old", enabled: true });
  await h.client.patchMcpServer(server.id, { command: "new" });
  next.resolve({ instructions: "new", tools: [{ name: "new_tool", description: "new" }] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  old.resolve({ instructions: "old", tools: [{ name: "old_tool", description: "old" }] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.store.listMcpServers()[0]!.instructions).toBe("new");
  expect(h.store.listMcpServers()[0]!.tool_catalog.map((tool) => tool.name)).toEqual(["new_tool"]);
  expect(h.events.some((event) => event.event === "mcp.upsert" && event.instructions === "old")).toBe(false);
});

test("review2: explicit credential repair cannot race an in-flight original write", async () => {
  const entered = gate(); const released = gate(); const keys = memoryKeyStore();
  const h = await harness({ get: keys.get, delete: keys.delete, async set(value, name) { entered.resolve(); await released.promise; await keys.set(value, name); } });
  const pending = h.client.createProvider({ name: "held", base_url: "https://example.invalid", api_key: "held-key" });
  await entered.promise;
  const op = h.store.listCredentialOperations()[0]!;
  expect((await h.request("POST", `/v1/credential-operations/${op.id}/resolve`, { action: "cancel" })).status).toBe(409);
  released.resolve(); await pending;
  expect(h.store.providersCached()[0]!.key_set).toBe(true);
  expect(h.store.listCredentialOperations()).toHaveLength(0);
});

test("review10: conditional execution and media kind use the exact bound values", async () => {
  const h = await harness();
  const body = { name: "encoded", duties: "", boundaries: "" };
  expect((await h.request("POST", "/v1/bots", body, ulid(), { "Content-Type": "application/jsonp" })).status).toBe(422);
  const id = ulid();
  expect((await h.request("POST", "/v1/bots", body, id)).status).toBe(201);
  const form = new FormData(); for (const [key, value] of Object.entries(body)) form.set(key, value);
  expect((await h.request("POST", "/v1/bots", form, id)).status).toBe(409);
  expect(h.store.listBots()).toHaveLength(1);
});

test("review10/11: agreed field order, canonical conditions, duplicate-name ordering and format rejection", () => {
  const input = { method: "POST", path: "/v1/messages", body: { b: 2, a: 1 } };
  expect(requestPreimage(input)).toBe('POST\x1f/v1/messages\x1f{"a":1,"b":2}\x1fjson\x1f\x1f{}');
  expect(requestDigest(input)).toBe("caf582f4423c2c5b8e82a222afecb70514aa0d3f5ac1dadfbf8be33b6cceeddf");
  const files = [{ filename: "same.txt", bytes: Buffer.from("second") }, { filename: "same.txt", bytes: Buffer.from("first") }];
  let count = 0; const normalized = normalizeFiles(files, (file) => { count++; return file; });
  expect(count).toBe(2);
  expect(requestDigest({ ...input, multipart: true, normalizedFiles: normalized })).toBe(requestDigest({ ...input, multipart: true, files: [...files].reverse() }));
  expect(requestDigest({ ...input, multipart: true, files })).toBe("a6dab6682df2cb83ad06bd60896c59e6cb8bca8f79984ebc6d2041ba509334c6");
  expect(requestDigest({ method: "PUT", path: "/v1/workspace/file", body: { path: "note.txt", content: "new" }, ifMatch: `"${"a".repeat(64)}"` })).toBe("cf696f981376d85e0a80a69403e1e5ae9712e5f8f51fec7e104a69f12e14f808");
  for (const ifMatch of ["*", 'W/"abc"', '"ABC"', '"abc", "def"']) expect(() => requestDigest({ ...input, ifMatch })).toThrow();
  for (const path of ["/v1//bots/x", "/v1/bots/x/", "/v1/bots/%2f", "/v1/bots/%zz"]) expect(() => requestDigest({ ...input, path })).toThrow();
  expect(() => normalizeFiles([{ filename: "a\x1fb", bytes: Buffer.from("x") }], (file) => file)).toThrow();
  expect(canonicalJson({ "if-match": `"${"a".repeat(64)}"` })).toBe(`{"if-match":"\\"${"a".repeat(64)}\\""}`);
});


test("integration: daemon and canonical export share every six-field golden without relaxing If-Match", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../../packages/remote/test/fixtures/request-digest.json", import.meta.url), "utf8")) as Array<{ input: RequestDigestInput; preimage: string; sha256: string }>;
  for (const vector of vectors) {
    expect(new TextDecoder().decode(requestDigestBytes(vector.input))).toBe(vector.preimage);
    expect(sharedDigest(vector.input)).toBe(vector.sha256);
    const input = {
      method: vector.input.method, path: vector.input.path, body: vector.input.body, multipart: vector.input.encoding === "multipart",
      normalizedFiles: vector.input.files?.map((file) => ({ file, filename: file.filename, hash: file.sha256 })),
      ifMatch: vector.input.conditionalHeaders?.["If-Match"],
    };
    if (input.ifMatch) {
      expect(() => requestDigest(input)).toThrow("strong SHA-256 ETag");
    } else {
      expect(requestPreimage(input)).toBe(vector.preimage);
      expect(requestDigest(input)).toBe(vector.sha256);
    }
  }
  const body = { b: 2, a: 1 };
  const files = [{ filename: "same.txt", bytes: Buffer.from("second") }, { filename: "same.txt", bytes: Buffer.from("first") }];
  const cases = [
    { local: { method: "POST", path: "/v1/messages", body }, golden: "caf582f4423c2c5b8e82a222afecb70514aa0d3f5ac1dadfbf8be33b6cceeddf" },
    { local: { method: "POST", path: "/v1/messages", body, multipart: true, files }, golden: "a6dab6682df2cb83ad06bd60896c59e6cb8bca8f79984ebc6d2041ba509334c6" },
    { local: { method: "PUT", path: "/v1/workspace/file", body: { path: "note.txt", content: "new" }, ifMatch: `"${"a".repeat(64)}"` }, golden: "cf696f981376d85e0a80a69403e1e5ae9712e5f8f51fec7e104a69f12e14f808" },
  ];
  for (const { local, golden } of cases) {
    const shared: RequestDigestInput = { ...local, encoding: local.multipart ? "multipart" : "json",
      files: local.files?.map((file) => ({ filename: file.filename, sha256: sha256Hex(file.bytes) })),
      conditionalHeaders: local.ifMatch ? { "IF-MATCH": local.ifMatch } : {},
    };
    expect(requestPreimage(local)).toBe(new TextDecoder().decode(requestDigestBytes(shared)));
    expect(requestDigest(local)).toBe(golden);
    expect(sharedDigest(shared)).toBe(golden);
  }
  expect(sha256).toBe(sha256Hex);
  const duplicates = [files[0]!, files[1]!, files[1]!, { filename: "😀", bytes: Buffer.from("x") }, { filename: "דּ", bytes: Buffer.from("y") }];
  const normalized = normalizeFiles(duplicates, (file) => file);
  const shared = normalizeAttachmentDigests(duplicates.map((file) => ({ file, filename: file.filename, sha256: sha256Hex(file.bytes) })));
  expect(normalized.map((item) => item.file)).toEqual(shared.map((item) => item.file));
  expect(normalized).toHaveLength(5);
  expect(requestDigest({ method: "POST", path: "/v1/messages", body, multipart: true, normalizedFiles: normalized })).toBe(sharedDigest({ method: "POST", path: "/v1/messages", body, encoding: "multipart", files: shared }));
  for (const value of [new Array(1), { get a() { throw new Error("accessor invoked"); } }, { a: undefined }]) {
    expect(() => canonicalJson(value)).toThrow();
  }
});

test("integration: encoder injection reaches shared body and condition encoding in real HTTP receipts", async () => {
  const seen: unknown[] = [];
  const encode = (value: unknown) => { seen.push(value); return ` ${canonicalize(value)}`; };
  const h = await harness(memoryKeyStore(), { canonicalEncoder: encode });
  const body = { name: "injected", duties: "", boundaries: "" }; const id = ulid();
  expect((await h.request("POST", "/v1/bots", body, id)).status).toBe(201);
  expect(seen).toEqual([body, {}]);
  const shared: RequestDigestInput = { method: "POST", path: "/v1/bots", body, encoding: "json" };
  const stored = h.store.receipts.lookup({ deviceId: "local", requestId: id })!.payload_sha256;
  expect(stored).toBe(sharedDigest(shared, encode));
  expect(stored).not.toBe(sharedDigest(shared));
  expect((await h.request("POST", "/v1/bots", body, id)).status).toBe(201);
  expect(h.store.listBots()).toHaveLength(1);
});

test("integration review B1: raw and normalized attachment holes fail422 instead of becoming empty files", () => {
  const file: DigestFile = { filename: "same.txt", bytes: Buffer.from("bytes") };
  const normalized = { file, filename: file.filename, hash: sha256(file.bytes) };
  const rawLists = [new Array<DigestFile>(1), [file, , file], [, file], [file, ,]] as DigestFile[][];
  const normalizedLists = [new Array<NormalizedFile<DigestFile>>(1), [normalized, , normalized], [, normalized], [normalized, ,]] as NormalizedFile<DigestFile>[][];
  const inherited = new Array<DigestFile>(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: file }));
  rawLists.push(inherited);
  const inheritedNormalized = new Array<NormalizedFile<DigestFile>>(1);
  Object.setPrototypeOf(inheritedNormalized, Object.assign(Object.create(Array.prototype), { 0: normalized }));
  normalizedLists.push(inheritedNormalized);
  const input = { method: "POST", path: "/v1/messages", body: {}, multipart: true };
  const rejects422 = (run: () => unknown) => {
    let error: unknown;
    try { run(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 422, code: "invalid_args" });
  };
  for (const files of rawLists) {
    rejects422(() => normalizeFiles(files, (item) => item));
    rejects422(() => requestPreimage({ ...input, files }));
    rejects422(() => requestDigest({ ...input, files }));
  }
  for (const normalizedFiles of normalizedLists) {
    rejects422(() => requestPreimage({ ...input, normalizedFiles }));
    rejects422(() => requestDigest({ ...input, normalizedFiles }));
  }
  const dense = normalizeFiles([file, file], (item) => item);
  expect(dense).toHaveLength(2);
  expect(dense[0]!.file).toBe(file); expect(dense[1]!.file).toBe(file);
  expect(requestDigest({ ...input, normalizedFiles: dense })).toBe(requestDigest({ ...input, files: [file, file] }));
  expect(requestDigest({ ...input, normalizedFiles: dense })).not.toBe(requestDigest({ ...input, files: [file] }));
});

for (const field of ["body", "conditions"] as const) {
  test(`integration review S1: invalid ${field} encoders fail422 before receipts, files or business effects`, async () => {
    let selected: () => unknown = () => Promise.resolve("{}");
    let valid = false; let calls = 0; let coercions = 0;
    const encoder = ((value: unknown) => {
      calls++;
      if (valid || (field === "conditions" && Object.hasOwn(value as object, "name"))) return canonicalize(value);
      return selected();
    }) as CanonicalEncoder;
    const h = await harness(memoryKeyStore(), { canonicalEncoder: encoder });
    const id = ulid(); const initial = { name: "before", duties: "", boundaries: "" };
    const factories: Array<() => unknown> = [
      () => undefined, () => null, () => 1, () => new String("{}"), () => Buffer.from("{}"),
      () => new Uint8Array([123, 125]), () => ({ toString() { coercions++; return "{}"; } }),
      () => ({ then() { coercions++; throw new Error("must not execute thenable"); } }),
      () => Promise.resolve("{}"), () => Promise.reject(new Error("encoder rejected")),
      () => (async () => "{}")(), () => (async () => { throw new Error("async encoder rejection"); })(),
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("late encoder rejection")), 0)),
      () => new Promise(() => {}),
    ];
    for (const factory of factories) {
      selected = factory;
      for (const body of [initial, { ...initial, name: "changed" }]) {
        const beforeCalls = calls;
        const response = await h.request("POST", "/v1/bots", body, id);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_args" } });
        expect(calls - beforeCalls).toBe(field === "body" ? 1 : 2);
        expect(h.store.receipts.lookup({ deviceId: "local", requestId: id })).toBeNull();
        expect(h.store.listBots()).toHaveLength(0);
        expect(h.store.db.query("SELECT COUNT(*) AS n FROM file_stages").get()).toEqual({ n: 0 });
        expect(h.store.db.query("SELECT COUNT(*) AS n FROM file_commits").get()).toEqual({ n: 0 });
      }
    }
    valid = true;
    expect((await h.request("POST", "/v1/bots", initial, id)).status).toBe(201);
    expect((await h.request("POST", "/v1/bots", { ...initial, name: "changed" }, id)).status).toBe(409);
    expect(h.store.listBots()).toHaveLength(1);
    expect(h.store.listBots()[0]!.name).toBe("before");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(coercions).toBe(0);
  });
}

test("integration: live API receipts bind shared files, query, media and actual If-Match without replaying effects", async () => {
  const h = await harness();
  const id = ulid(); const path = "/v1/bots?q=folder%2Fnested";
  const body = { name: "shared", duties: "", boundaries: "" };
  const created = await h.request("POST", path, body, id);
  expect(created.status).toBe(201);
  expect(h.store.receipts.lookup({ deviceId: "local", requestId: id })!.payload_sha256).toBe(sharedDigest({ method: "POST", path, body, encoding: "json" }));
  expect((await h.request("POST", "/v1/bots?q=other%2Fnested", body, id)).status).toBe(409);
  const bot = h.store.listBots()[0]!;
  const session = h.store.createBot({ name: "files", duties: "", boundaries: "" }).direct_session.id;
  const messagePath = `/v1/sessions/${session}/messages`; const uploadId = ulid();
  const values = ["second", "first", "first"];
  const form = (items: string[]) => { const data = new FormData(); data.set("body", "photos"); for (const item of items) data.append("files", new File([item], "same.txt")); return data; };
  const uploaded = await h.request("POST", messagePath, form(values), uploadId);
  expect(uploaded.status).toBe(201);
  const first = await uploaded.text();
  const attachments = (JSON.parse(first) as { attachments: Array<{ workspace_relpath: string }> }).attachments;
  expect(attachments).toHaveLength(3);
  const files = normalizeAttachmentDigests(values.map((value) => ({ value, filename: "same.txt", sha256: sha256Hex(value) })));
  expect(attachments.map((attachment) => readFileSync(join(h.root, attachment.workspace_relpath), "utf8"))).toEqual(files.map((file) => file.value));
  expect(h.store.receipts.lookup({ deviceId: "local", requestId: uploadId })!.payload_sha256).toBe(sharedDigest({ method: "POST", path: messagePath, body: { body: "photos" }, encoding: "multipart", files }));
  const replay = await h.request("POST", messagePath, form([...values].reverse()), uploadId);
  expect(replay.status).toBe(201); expect(await replay.text()).toBe(first);
  expect((await h.request("POST", messagePath, form(values.slice(0, 2)), uploadId)).status).toBe(409);
  const duplicateFields = form([]); duplicateFields.append("body", "other");
  expect((await h.request("POST", messagePath, duplicateFields)).status).toBe(422);
  writeFileSync(join(h.root, "note.txt"), "old");
  const get = await h.request("GET", "/v1/workspace/file?path=note.txt");
  expect(get.status).toBe(200); const etag = get.headers.get("ETag")!;
  expect(etag).toBe(`"${sha256Hex("old")}"`);
  const putBody = { path: "note.txt", content: "new" }; const putId = ulid();
  const saved = await h.request("PUT", "/v1/workspace/file", putBody, putId, { "If-Match": etag });
  expect(saved.status).toBe(204); expect(saved.headers.get("ETag")).toBe(`"${sha256Hex("new")}"`);
  expect(h.store.receipts.lookup({ deviceId: "local", requestId: putId })!.payload_sha256).toBe(sharedDigest({ method: "PUT", path: "/v1/workspace/file", body: putBody, encoding: "json", conditionalHeaders: { "if-match": etag } }));
  expect((await h.request("PUT", "/v1/workspace/file", putBody, putId, { "If-Match": etag })).status).toBe(204);
  expect((await h.request("PUT", "/v1/workspace/file", putBody, putId, { "If-Match": `"${sha256Hex("new")}"` })).status).toBe(409);
  expect((await h.request("PUT", "/v1/workspace/file", { ...putBody, content: "stale" }, ulid(), { "If-Match": etag })).status).toBe(409);
  for (const ifMatch of ["*", 'W/"abc"', '"rev-1"', '"abc", "def"']) {
    expect((await h.request("PUT", "/v1/workspace/file", putBody, ulid(), { "If-Match": ifMatch })).status).toBe(422);
  }
  expect(readFileSync(join(h.root, "note.txt"), "utf8")).toBe("new");
  const missing = await h.api.dispatchBusiness(new Request("http://fixture/v1/workspace/file", { method: "PUT", body: JSON.stringify(putBody) }), { deviceId: "fixture-device", requestId: ulid(), requireRevision: true });
  expect(missing.status).toBe(422);
  expect(h.store.getBot(bot.id).name).toBe("shared");
});

test("round2 query data: real client opens nested files/trees and slash searches without weakening route guards", async () => {
  const h = await harness();
  mkdirSync(join(h.root, "folder", "nested"), { recursive: true });
  writeFileSync(join(h.root, "folder", "nested", "note.txt"), "nested bytes");
  expect(await (await h.client.getWorkspaceFileBlob("folder/nested/note.txt")).text()).toBe("nested bytes");
  expect((await h.client.workspaceTree("folder/nested")).items).toContainEqual({ name: "note.txt", path: "folder/nested/note.txt", kind: "file" });
  const bot = h.store.createBot({ name: "query", duties: "", boundaries: "" });
  h.store.postMessage(bot.direct_session.id, { body: "folder/nested" });
  expect(await h.client.search("folder/nested")).toBeArray();
  await expect(h.client.getWorkspaceFileBlob("../db.sqlite")).rejects.toMatchObject({ status: 422 });
  const body = { method: "POST", path: "/v1/bots?q=folder%2Fnested", body: {} };
  expect(requestDigest(body)).not.toBe(requestDigest({ ...body, path: "/v1/bots?q=other%2Fnested" }));
  expect(() => requestDigest({ ...body, path: "/v1%2Fbots?q=folder%2Fnested" })).toThrow();
});

for (const mode of ["create", "update"] as const) {
  for (const finish of ["repair", "cancel"] as const) {
    test(`round2 takeover chain: ${mode} -> failed repair -> ${finish} retires every terminal client payload`, async () => {
      let locked = false;
      const keys = memoryKeyStore();
      const h = await harness({ get: keys.get, delete: keys.delete, async set(value, name) { if (locked) throw new Error("locked"); await keys.set(value, name); } });
      const input = { name: "chain", base_url: "https://example.invalid", api_key: "original-secret" };
      const existing = mode === "update" ? await h.client.createProvider(input) : null;
      locked = true;
      const initial = existing ? h.client.patchProvider(existing.id, { api_key: "update-secret" }) : h.client.createProvider(input);
      await expect(initial).rejects.toMatchObject({ code: "key_write_pending" });
      const originalId = h.client.pendingRequests()[0]!.id;
      const op = (await h.client.credentialOperations()).items[0]!;
      await expect(h.client.resolveCredential(op.id, "repair", "replacement-secret")).rejects.toMatchObject({ code: "key_write_pending" });
      expect(h.client.pendingRequests()).toHaveLength(1);
      expect(h.client.pendingRequests()[0]!.id).not.toBe(originalId);
      expect(h.store.receipts.read({ deviceId: "local", requestId: originalId }).status).toBe(409);
      locked = false;
      const replacement = (await h.client.credentialOperations()).items[0]!;
      await h.client.resolveCredential(replacement.id, finish, finish === "repair" ? "final-secret" : undefined);
      expect(h.client.pendingRequests()).toHaveLength(0);
      expect((await h.client.credentialOperations()).items).toHaveLength(0);
      if (existing) {
        expect((await h.client.patchProvider(existing.id, { name: "after", api_key: "new-secret" })).name).toBe("after");
      } else {
        expect((await h.client.createProvider({ ...input, name: "after" })).name).toBe("after");
      }
      expect(h.client.pendingRequests()).toHaveLength(0);
    });
  }
}

for (const kind of ["provider", "mcp"] as const) {
  test(`round2 deleted ${kind} cannot be repaired into an orphan credential`, async () => {
    let locked = false;
    const keys = memoryKeyStore();
    const h = await harness({ get: keys.get, set: keys.set, async delete(name) { if (locked) throw new Error("delete locked"); await keys.delete(name); } });
    const entity = kind === "provider"
      ? await h.client.createProvider({ name: "delete", base_url: "https://example.invalid", api_key: "old-secret" })
      : await h.client.createMcpServer({ name: "delete", command: "never", enabled: false, auth: "old-secret" });
    locked = true;
    await expect(kind === "provider" ? h.client.deleteProvider(entity.id) : h.client.deleteMcpServer(entity.id)).rejects.toMatchObject({ code: "key_write_pending" });
    const op = (await h.client.credentialOperations()).items[0]!;
    expect(op.can_repair).toBe(false);
    locked = false;
    await expect(h.client.resolveCredential(op.id, "repair", "orphan-secret")).rejects.toMatchObject({ status: 409 });
    expect(h.store.listCredentialOperations()).toHaveLength(1);
    expect(await keys.get(`${kind === "provider" ? "endpoint-api-key" : "mcp-auth"}:${entity.id}`)).toBe("old-secret");
    await h.client.resolveCredential(op.id, "cancel");
    expect(await keys.get(`${kind === "provider" ? "endpoint-api-key" : "mcp-auth"}:${entity.id}`)).toBeNull();
    expect(h.store.listCredentialOperations()).toHaveLength(0);
    expect(h.client.pendingRequests()).toHaveLength(0);
  });
}

for (const alias of [false, true]) {
  test(`round2 no-workspace attachment GET/reopen preserves inbox containment (alias=${alias})`, async () => {
    const h = await harness(memoryKeyStore(), {}, false);
    if (alias) { mkdirSync(join(h.root, "uploads")); symlinkSync("uploads", join(h.root, "inbox")); }
    const bot = h.store.createBot({ name: "upload", duties: "", boundaries: "" });
    const message = await h.client.postMessage(bot.direct_session.id, "file", { attachments: [new File(["bytes"], "file.txt")] });
    const attachment = message.attachments[0]!;
    expect(attachment.workspace_relpath).toBe(`${alias ? "uploads" : "inbox"}/file.txt`);
    expect(h.store.getAttachment(attachment.id).exists).toBe(true);
    expect(await (await h.client.getAttachmentBlob(attachment.id)).text()).toBe("bytes");
    const reopened = new Store({ filename: h.filename, endpointKey: memoryKeyStore() });
    expect(reopened.getAttachment(attachment.id).exists).toBe(true);
    expect(readFileSync(reopened.getAttachmentFilePath(attachment), "utf8")).toBe("bytes");
    const api = createLocalApi({ store: reopened, token: "fixture", schedule: false });
    const response = await api.dispatchBusiness(new Request(`http://fixture/v1/attachments/${attachment.id}/content`), { deviceId: "local", requestId: ulid() });
    expect(response.status).toBe(200); expect(await response.text()).toBe("bytes");
    expect(reopened.resolveAttachmentLocation("db.sqlite")).toBeNull();
    expect(reopened.resolveAttachmentLocation("../outside.txt")).toBeNull();
    symlinkSync(join(h.root, "db.sqlite"), join(h.root, "inbox", "leak.sqlite"));
    expect(reopened.resolveAttachmentLocation("inbox/leak.sqlite")).toBeNull();
    expect(() => reopened.getAttachmentFilePath({ ...attachment, workspace_relpath: "db.sqlite" })).toThrow();
    const denied = h.store.insertMessage({ sessionId: bot.direct_session.id, kind: "bot", author: bot.bot.id, body: "denied files", paths: ["db.sqlite", "inbox/leak.sqlite"] });
    for (const row of denied.attachments) await expect(h.client.getAttachmentBlob(row.id)).rejects.toMatchObject({ status: 404 });
    await api.engine.close(); reopened.close();
  });
}
