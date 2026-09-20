import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApi, type LocalApiOptions } from "./local-api";
import { Store, type EndpointKeyStore } from "./store";
import { memoryKeyStore } from "./secrets";
import { ulid } from "./ids";
// The real browser client is loaded at runtime across the packages' different TS library targets.
const clientModule = new URL("../../messenger/src/lib/api.ts", import.meta.url).href;
const { LocalApi: Client, ApiError } = await import(clientModule);
import type { ClientEvent } from "@real-bot/protocol";
import { listWorkspaceDir } from "./workspace-browse";
import { canonicalJson, requestDigest, requestPreimage, normalizeFiles } from "./request-digest";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function harness(keys: EndpointKeyStore = memoryKeyStore(), extra: Partial<LocalApiOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rc02-review-test-")));
  const filename = join(root, "db.sqlite");
  const store = new Store({ filename, endpointKey: keys });
  await store.patchSettings({ workspace_path: root });
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
