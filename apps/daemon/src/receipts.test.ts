import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalApi } from "./local-api";
import { Store, type EndpointKeyStore } from "./store";
import { memoryKeyStore } from "./secrets";
import { ulid } from "./ids";
import { canonicalJson, requestDigest } from "./request-digest";
import { runWorkspaceTool } from "./workspace-tools";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(keys: EndpointKeyStore = memoryKeyStore()) {
  const root = mkdtempSync(join(tmpdir(), "rc02-test-"));
  const filename = join(root, "test.sqlite");
  const store = new Store({ filename, endpointKey: keys });
  await store.patchSettings({ workspace_path: root });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  cleanups.push(async () => { await api.engine.close(); await server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (method: string, path: string, body?: unknown, id = ulid(), headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { Authorization: "Bearer fixture", "X-Request-Id": id, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...headers },
    body: method === "GET" ? undefined : body instanceof FormData ? body : JSON.stringify(body ?? {}),
  });
  return { root, filename, store, api, call };
}

test("RFC8785 fixed serialization, UTF-16 order, and invalid I-JSON", () => {
  expect(canonicalJson({ numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27], string: "€$\u000f\nA'B\"\\\"/", literals: [null, true, false] }))
    .toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}');
  expect(canonicalJson({ "דּ": 1, "😀": 2, "€": 3, "ö": 4, "\r": 5, "1": 6 })).toBe('{"\\r":5,"1":6,"ö":4,"€":3,"😀":2,"דּ":1}');
  expect(canonicalJson(-0)).toBe("0");
  for (const value of [NaN, Infinity, undefined, "\ud800"]) expect(() => canonicalJson(value)).toThrow();
});

test("multipart digest is order independent, binds bytes, type, filename, and If-Match", () => {
  const input = { method: "POST", path: "/v1/messages", body: { body: "hello" }, multipart: true, files: [{ filename: "ö", bytes: new Uint8Array([1]) }, { filename: "a", bytes: new Uint8Array([2]) }] };
  expect(requestDigest(input)).toBe(requestDigest({ ...input, files: [...input.files].reverse() }));
  expect(() => requestDigest({ ...input, multipart: false })).toThrow();
  expect(requestDigest(input)).not.toBe(requestDigest({ ...input, ifMatch: `"${"a".repeat(64)}"` }));
  expect(requestDigest(input)).not.toBe(requestDigest({ ...input, files: [{ filename: "a", bytes: new Uint8Array([1]) }] }));
});

test("same-key concurrent create commits once, replays bytes, conflicts, and tombstones survive reopen", async () => {
  const h = await fixture();
  const id = ulid();
  const body = { name: "one", duties: "write", boundaries: "stay" };
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.call("POST", "/v1/bots", body, id)));
  const texts = await Promise.all(responses.map((response) => response.text()));
  expect(responses.every((response) => response.status === 201)).toBe(true);
  expect(new Set(texts).size).toBe(1);
  expect(h.store.listBots()).toHaveLength(1);
  expect((await h.call("POST", "/v1/bots", { ...body, name: "two" }, id)).status).toBe(409);
  h.store.receipts.prune(Date.now(), 0);
  expect((await h.call("POST", "/v1/bots", body, id)).status).toBe(410);
  const reopened = new Store({ filename: h.filename });
  expect(reopened.receipts.lookup({ deviceId: "local", requestId: id })?.state).toBe("expired");
  reopened.close();
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM request_receipts WHERE body IS NOT NULL").get()).toEqual({ n: 0 });
});

test("business rollback and initial 409 replay are durable", async () => {
  const h = await fixture();
  const before = await h.store.settings();
  const id = ulid();
  const failed = await h.call("PATCH", "/v1/settings", { theme: "dark", locale: "bad" }, id);
  expect(failed.status).toBe(422);
  expect((await h.store.settings()).theme).toBe(before.theme);
  expect((await h.store.settings()).settings_rev).toBe(before.settings_rev);
  const bot = h.store.createBot({ name: "bot", duties: "", boundaries: "" });
  const msg = h.store.postMessage(bot.direct_session.id, { body: "go" });
  const turn = h.store.createTurn({ sessionId: msg.session_id, botId: bot.bot.id, triggerMessageId: msg.id });
  const approval = h.store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-write", summary: "fixture", target: "/tmp/fixture" });
  const path = `/v1/approvals/${approval.id}/resolve`;
  const race = await Promise.all([h.call("POST", path, { action: "deny" }), h.call("POST", path, { action: "allow_once" })]);
  expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
  const conflictId = ulid();
  const conflict = await h.call("POST", path, { action: "deny" }, conflictId);
  const original = await conflict.text();
  h.store.db.run("UPDATE approvals SET status = 'pending' WHERE id = ?", [approval.id]);
  const replay = await h.call("POST", path, { action: "deny" }, conflictId);
  expect(replay.status).toBe(409);
  expect(await replay.text()).toBe(original);
  expect(h.store.getApproval(approval.id).status).toBe("pending");
});

test("Keychain failure keeps one pending entity, hides keys, resumes same request without an open transaction", async () => {
  let fail = true;
  let h: Awaited<ReturnType<typeof fixture>>;
  const keys = memoryKeyStore();
  const safeKeys: EndpointKeyStore = {
    get: (name) => keys.get(name), delete: (name) => keys.delete(name),
    async set(value, name) {
      expect(h.store.db.inTransaction).toBe(false);
      await Bun.sleep(5);
      if (fail) throw new Error("locked");
      await keys.set(value, name);
    },
  };
  h = await fixture(safeKeys);
  const id = ulid();
  const body = { name: "fixture", base_url: "https://example.invalid", api_key: "private-fixture-value" };
  expect((await h.call("POST", "/v1/providers", body, id)).status).toBe(503);
  expect(await h.store.listProviders()).toHaveLength(1);
  expect((await h.store.listProviders())[0]!.key_set).toBe(false);
  const stored = h.store.db.query<{ body: string; key_ops: string }, []>("SELECT body, key_ops FROM request_receipts").all();
  expect(JSON.stringify(stored)).not.toContain(body.api_key);
  fail = false;
  const retry = await h.call("POST", "/v1/providers", body, id);
  expect(retry.status).toBe(201);
  expect((await retry.json() as { key_set: boolean }).key_set).toBe(true);
  expect(await h.store.listProviders()).toHaveLength(1);
  expect((await h.store.listProviders())[0]!.key_set).toBe(true);
  const secondId = ulid();
  fail = true;
  expect((await h.call("POST", "/v1/providers", { ...body, name: "restart" }, secondId)).status).toBe(503);
  const restarted = new Store({ filename: h.filename, endpointKey: keys });
  const api = createLocalApi({ store: restarted, token: "fixture", schedule: false });
  expect(restarted.receipts.read({ deviceId: "local", requestId: secondId }).status).toBe(503);
  const resumed = await api.dispatchBusiness(new Request("http://fixture/v1/providers", { method: "POST", body: JSON.stringify({ ...body, name: "restart" }) }), { deviceId: "local", requestId: secondId });
  expect(resumed.status).toBe(201);
  expect((await restarted.listProviders()).filter((provider) => provider.name === "restart")).toHaveLength(1);
  await api.engine.close();
  restarted.close();
});

test("file GET ETag guards against Bot and external writes, local compatibility and 1MB limit", async () => {
  const h = await fixture();
  writeFileSync(join(h.root, "file.txt"), "old");
  const get = await h.call("GET", "/v1/workspace/file?path=file.txt");
  const etag = get.headers.get("ETag")!;
  expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  await runWorkspaceTool({ store: h.store, signal: new AbortController().signal }, "write_file", { path: "file.txt", content: "bot" });
  expect((await h.call("PUT", "/v1/workspace/file", { path: "file.txt", content: "mine" }, ulid(), { "If-Match": etag })).status).toBe(409);
  const current = (await h.call("GET", "/v1/workspace/file?path=file.txt")).headers.get("ETag")!;
  writeFileSync(join(h.root, "file.txt"), "external");
  expect((await h.call("PUT", "/v1/workspace/file", { path: "file.txt", content: "mine" }, ulid(), { "If-Match": current })).status).toBe(409);
  expect(readFileSync(join(h.root, "file.txt"), "utf8")).toBe("external");
  const put = await h.call("PUT", "/v1/workspace/file", { path: "file.txt", content: "local" });
  expect(put.status).toBe(204);
  expect(put.headers.get("ETag")).not.toBe(etag);
  expect((await h.call("PUT", "/v1/workspace/file", { path: "file.txt", content: "x".repeat(1_000_001) })).status).toBe(422);
});

test("attachment replay, duplicate filenames and crash recovery before/after TX and rename", async () => {
  const h = await fixture();
  const bot = h.store.createBot({ name: "bot", duties: "", boundaries: "" });
  const id = ulid();
  const form = () => { const data = new FormData(); data.set("body", "hello"); data.append("files", new File(["a"], "same.txt")); data.append("files", new File(["b"], "same.txt")); return data; };
  const first = await h.call("POST", `/v1/sessions/${bot.direct_session.id}/messages`, form(), id);
  const message = await first.json() as { attachments: Array<{ workspace_relpath: string }> };
  expect(first.status).toBe(201);
  for (const attachment of message.attachments) expect(existsSync(join(h.root, attachment.workspace_relpath))).toBe(true);
  expect((await h.call("POST", `/v1/sessions/${bot.direct_session.id}/messages`, form(), id)).status).toBe(201);
  expect(h.store.listMessages(bot.direct_session.id).items.filter((row) => row.kind === "user")).toHaveLength(1);
  const staged = h.store.prepareFile(h.root, join(h.root, "orphan.txt"), "orphan");
  const reopened = new Store({ filename: h.filename });
  expect(existsSync(join(h.root, staged.temp_rel))).toBe(false);
  reopened.close();
  for (const afterRename of [false, true]) {
    const row = h.store.prepareFile(h.root, join(h.root, `committed-${afterRename}.txt`), "safe");
    h.store.db.transaction(() => {
      h.store.db.run("INSERT INTO file_commits SELECT * FROM file_stages WHERE id = ?", [row.id]);
      h.store.db.run("DELETE FROM file_stages WHERE id = ?", [row.id]);
    })();
    if (afterRename) renameSync(join(h.root, row.temp_rel), join(h.root, row.final_rel));
    const recovered = new Store({ filename: h.filename });
    expect(readFileSync(join(h.root, row.final_rel), "utf8")).toBe("safe");
    expect(recovered.db.query("SELECT * FROM file_commits").all()).toHaveLength(0);
    recovered.close();
  }
});

test("all CRUD mutation families use stable receipts", async () => {
  const h = await fixture();
  async function replay(method: string, path: string, body: unknown = {}) {
    const id = ulid();
    const first = await h.call(method, path, body, id);
    const text = await first.text();
    expect(first.status).toBeLessThan(400);
    const second = await h.call(method, path, body, id);
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(text);
    expect(h.store.receipts.read({ deviceId: "local", requestId: id }).body).toBe(text || null);
    return text ? JSON.parse(text) : null;
  }
  const created = await replay("POST", "/v1/bots", { name: "matrix", duties: "", boundaries: "" });
  const bot = created.bot.id;
  await replay("PATCH", `/v1/bots/${bot}`, { duties: "updated" });
  await replay("POST", `/v1/bots/${bot}/archive`);
  await replay("POST", `/v1/bots/${bot}/restore`);
  const others = ["second", "third"].map((name) => h.store.createBot({ name, duties: "", boundaries: "" }).bot.id);
  const group = await replay("POST", "/v1/sessions", { name: "group", members: [bot, ...others] });
  await replay("PATCH", `/v1/sessions/${group.id}`, { name: "renamed" });
  await replay("POST", `/v1/sessions/${group.id}/read`);
  await replay("POST", `/v1/sessions/${group.id}/archive`);
  await replay("POST", `/v1/sessions/${group.id}/restore`);
  await replay("DELETE", `/v1/sessions/${group.id}/members`, { bot_id: bot });
  await replay("POST", `/v1/sessions/${group.id}/members`, { bot_id: bot });
  const skill = await replay("POST", "/v1/skills", { bot_id: bot, name: "skill", description: "test", body: "test" });
  await replay("PATCH", `/v1/skills/${skill.id}`, { body: "changed" });
  await replay("DELETE", `/v1/skills/${skill.id}`);
  const routine = await replay("POST", "/v1/routines", { bot_id: bot, title: "test", instruction: "test", schedule: { kind: "daily", time: "09:00" }, enabled: false });
  await replay("PATCH", `/v1/routines/${routine.id}`, { title: "changed" });
  await replay("DELETE", `/v1/routines/${routine.id}`);
  const rule = await replay("POST", "/v1/allow-rules", { kind_key: "outside-read", scope: "/fixture" });
  await replay("DELETE", `/v1/allow-rules/${rule.id}`);
  const provider = await replay("POST", "/v1/providers", { name: "fixture", base_url: "https://example.invalid", api_key: "fake" });
  await replay("PATCH", `/v1/providers/${provider.id}`, { name: "changed", api_key: "new-fake" });
  await replay("DELETE", `/v1/providers/${provider.id}`);
  const mcp = await replay("POST", "/v1/mcp-servers", { name: "fixture", command: "never-run", enabled: false, auth: "fake" });
  await replay("PATCH", `/v1/mcp-servers/${mcp.id}`, { usage_note: "changed", auth: "new-fake" });
  await replay("DELETE", `/v1/mcp-servers/${mcp.id}`);
  await replay("POST", `/v1/sessions/${group.id}/clear`);
  await replay("DELETE", `/v1/sessions/${group.id}`);
  await replay("DELETE", `/v1/bots/${bot}`);
});

test("missing committed bytes fail closed and rollbacks remove staged files", async () => {
  const h = await fixture();
  const row = h.store.prepareFile(h.root, join(h.root, "rollback.txt"), "discard");
  expect(() => h.store.transaction(() => { h.store.commitPreparedFile(row); throw new Error("rollback"); })).toThrow();
  expect(existsSync(join(h.root, row.temp_rel))).toBe(false);
  expect(existsSync(join(h.root, row.final_rel))).toBe(false);
  const missing = h.store.prepareFile(h.root, join(h.root, "missing.txt"), "required");
  h.store.db.run("INSERT INTO file_commits SELECT * FROM file_stages WHERE id = ?", [missing.id]);
  rmSync(join(missing.root, missing.temp_rel));
  expect(() => h.store.recoverFiles()).toThrow("missing or changed");
  h.store.db.run("DELETE FROM file_commits WHERE id = ?", [missing.id]);
});

test("injected scope binds devices, requires revisions, and exposes no runtime HTTP routes", async () => {
  const h = await fixture();
  const request = (body: unknown) => new Request("http://fixture/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
  const scope = { deviceId: "paired-device", requestId: ulid(), requireRevision: true };
  const stale = await h.api.dispatchBusiness(request({ theme: "dark", if_revision: -1 }), scope);
  expect(stale.status).toBe(409);
  const fresh = await h.api.dispatchBusiness(request({ theme: "dark", if_revision: h.store.settingsCached().settings_rev }), { ...scope, requestId: ulid() });
  expect(fresh.status).toBe(200);
  expect((await h.call("POST", "/remote/runtime/stop")).status).toBe(404);
  await expect(h.api.dispatchBusiness(new Request("http://fixture/v1/runtime/quit", { method: "POST" }), scope)).rejects.toThrow();
  expect(() => h.store.transaction(() => Promise.resolve())).toThrow("synchronous");
  expect(h.store.db.inTransaction).toBe(false);
});
