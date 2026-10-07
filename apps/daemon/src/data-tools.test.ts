/**
 * A Bot reading this machine's records (ADR 0065), through the tools and the child process they run
 * in: what it may read, what it may not, and that a query running away is killed.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { queryRecords } from "./data-query/runner";
import { redactSecrets } from "./data-tools";
import { Store } from "./store";

const dir = mkdtempSync(join(tmpdir(), "records-tools-"));
const store = new Store({ filename: join(dir, "state.sqlite") });
const { bot, direct_session } = store.createBot({ name: "Analyst", duties: "look into how work went", boundaries: "read only" });
const line = store.postMessage(direct_session.id, { body: "上周哪类活返工最多？" });
const turn = store.createTurn({ sessionId: direct_session.id, botId: bot.id, triggerMessageId: line.id });
const ctx: ToolCtx = { store, botId: bot.id, sessionId: direct_session.id, turnId: turn.id, parentId: null };
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("describe_data lists the tables Bots may read, with a line on the main ones, and none they may not", async () => {
  const all = await runCollabTool(ctx, "describe_data", {});
  expect(all.ok).toBe(true);
  const tables = all.data!.tables as Array<{ name: string; about?: string; rows: number | null; columns?: unknown }>;
  // Names, notes and row counts only: every table's columns at once would not stay in context.
  expect(tables.some((table) => "columns" in table)).toBe(false);
  expect(JSON.stringify(all.data).length).toBeLessThan(8000);
  const names = tables.map((table) => table.name);
  expect(names).toContain("messages");
  expect(names).toContain("work_events");
  expect(names).toContain("prompt_revisions");
  for (const denied of ["terminals", "pending_keys", "request_receipts", "notification_push_config", "notification_devices"]) expect(names).not.toContain(denied);
  expect(names.some((name) => name.startsWith("remote_") || name.startsWith("sqlite_"))).toBe(false);
  expect(tables.find((table) => table.name === "messages")).toMatchObject({ about: expect.stringContaining("消息"), rows: 1 });
  const one = await runCollabTool(ctx, "describe_data", { table: "turns" });
  expect((one.data!.tables as Array<{ columns: Array<{ name: string; type: string }> }>)[0]!.columns).toContainEqual({ name: "status", type: "TEXT" });
  expect((await runCollabTool(ctx, "describe_data", { table: "terminals" })).error?.code).toBe("not_found");
});

test("query_data reads what is there, only reads, and never a denied table", async () => {
  const read = await runCollabTool(ctx, "query_data", { sql: "SELECT body FROM messages WHERE session_id = ?", params: [direct_session.id] });
  expect(read).toMatchObject({ ok: true, data: { columns: ["body"], rows: [["上周哪类活返工最多？"]], row_count: 1, truncated: false } });
  const counted = await runCollabTool(ctx, "query_data", { sql: "SELECT kind, COUNT(*) AS n FROM sessions GROUP BY kind" });
  expect(counted.ok).toBe(true);
  for (const sql of ["DELETE FROM messages", "WITH x AS (SELECT 1) DELETE FROM messages", "SELECT * FROM terminals", "SELECT * FROM remote_devices", "ATTACH 'x' AS y", "SELECT 1; SELECT 2"]) {
    const refused = await runCollabTool(ctx, "query_data", { sql });
    expect(refused.ok).toBe(false);
  }
  expect((await runCollabTool(ctx, "query_data", { sql: "SELECT * FROM terminals" })).error?.message).toBe("no such table: terminals");
  expect((await runCollabTool(ctx, "query_data", { sql: "SELECT 1", params: [{}] })).error?.code).toBe("invalid_args");
  // A column guessed wrong comes back with the columns of the tables the query named.
  const guessed = await runCollabTool(ctx, "query_data", { sql: "SELECT e.created_at FROM work_events e JOIN turns t ON t.id = e.turn_id" });
  expect(guessed.error?.message).toStartWith("no such column: e.created_at. Columns: turns(id, session_id, bot_id, status");
  expect(guessed.error?.message).toContain("work_events(seq, at, kind");
  expect(store.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
});

test("a query that runs away is killed at its deadline", async () => {
  const started = Date.now();
  const answer = await queryRecords(store.filename!, "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT MAX(x) FROM r", [], 10, 1500);
  expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("was stopped") });
  expect(Date.now() - started).toBeLessThan(10_000);
  // Two at once is the most; a third waits for neither and is turned away.
  const slow = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT MAX(x) FROM r";
  const results = await Promise.all([queryRecords(store.filename!, slow, [], 10, 1500), queryRecords(store.filename!, slow, [], 10, 1500), queryRecords(store.filename!, "SELECT 1", [], 10, 1500)]);
  expect(results[2]).toMatchObject({ ok: false, error: expect.stringContaining("already running") });
}, 20_000);

test("read_data_log reads only the daemon's logs, never through a link, with keys blanked out", async () => {
  writeFileSync(join(dir, "daemon.log"), [
    "booted",
    "provider call failed: Authorization: Bearer sk-live-abcdefghijklmnop",
    "retry with api_key=supersecretvalue1 ok",
    "organizer: unparseable",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "local-api.json"), JSON.stringify({ token: "local-token-canary" }));
  symlinkSync(join(dir, "local-api.json"), join(dir, "daemon-dev.stderr.log"));
  const read = await runCollabTool(ctx, "read_data_log", {});
  expect(read.ok).toBe(true);
  const lines = read.data!.lines as string[];
  expect(lines[0]).toBe("booted");
  expect(lines.join("\n")).not.toContain("sk-live");
  expect(lines.join("\n")).not.toContain("supersecretvalue1");
  const grep = await runCollabTool(ctx, "read_data_log", { grep: "ORGANIZER", tail_lines: 5 });
  expect(grep.data!.lines).toEqual(["organizer: unparseable"]);
  // A grep for part of a key finds nothing: it would otherwise tell, a character at a time, what the key is.
  for (const probe of ["sk-live", "Bearer sk", "supersecret"]) expect((await runCollabTool(ctx, "read_data_log", { grep: probe })).data!.lines).toEqual([]);
  expect((await runCollabTool(ctx, "read_data_log", { name: "local-api.json" })).error?.code).toBe("invalid_args");
  expect((await runCollabTool(ctx, "read_data_log", { name: "daemon-dev.stderr.log" })).error?.code).toBe("not_found");
  expect(redactSecrets("token=abcd1234 and password: hunter22")).toBe("token=[redacted] and password: [redacted]");
});

test("an in-memory store has no records to read", async () => {
  const memory = new Store();
  const made = memory.createBot({ name: "Memo", duties: "x", boundaries: "y" });
  const said = memory.postMessage(made.direct_session.id, { body: "hi" });
  const t = memory.createTurn({ sessionId: made.direct_session.id, botId: made.bot.id, triggerMessageId: said.id });
  const result = await runCollabTool({ store: memory, botId: made.bot.id, sessionId: made.direct_session.id, turnId: t.id, parentId: null }, "query_data", { sql: "SELECT 1" });
  expect(result.error?.code).toBe("unavailable");
  memory.close();
});

test("a key given on an approval card never lands in a table Bots may read", async () => {
  const canaryDir = mkdtempSync(join(tmpdir(), "records-canary-"));
  const { memoryKeyStore } = await import("./secrets");
  const keyed = new Store({ filename: join(canaryDir, "state.sqlite"), endpointKey: memoryKeyStore() });
  try {
    const made = keyed.createBot({ name: "Admin", duties: "set things up", boundaries: "none" });
    const said = keyed.postMessage(made.direct_session.id, { body: "add the endpoint and the MCP server" });
    const t = keyed.createTurn({ sessionId: made.direct_session.id, botId: made.bot.id, triggerMessageId: said.id });
    const base: ToolCtx = { store: keyed, botId: made.bot.id, sessionId: made.direct_session.id, turnId: t.id, parentId: null };
    // The way a Bot adds them: the card waits, and you paste the key on it.
    const endpoint = await runCollabTool(base, "add_endpoint", { name: "Canary", base_url: "https://unused.invalid/v1", models: ["m"] });
    expect(endpoint.waitApproval?.requiresApiKey).toBe(true);
    expect((await endpoint.waitApproval!.run({ api_key: "sk-canary-endpoint-0123456789" })).ok).toBe(true);
    const server = await runCollabTool(base, "add_mcp_server", { name: "canary-mcp", url: "https://unused.invalid/mcp", headers: [{ name: "X-Team", value: "visible" }] });
    expect((await server.waitApproval!.run({ api_key: "Bearer canary-mcp-auth-0123456789" })).ok).toBe(true);
    // Every text column of every table a Bot may read holds neither key.
    const { deniedTable } = await import("./data-query/guard");
    const tables = keyed.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name).filter((name) => !deniedTable(name));
    expect(tables.length).toBeGreaterThan(40);
    const scan = (): string[] => {
      const leaks: string[] = [];
      for (const table of tables) {
        const columns = keyed.db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((col) => col.name);
        for (const column of columns) {
          const value = `CAST("${column}" AS TEXT)`;
          const hit = keyed.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}" WHERE (${value} LIKE '%canary-%' AND ${value} NOT LIKE '%canary-mcp%') OR ${value} LIKE '%0123456789%'`).get()!.n;
          if (hit > 0) leaks.push(`${table}.${column}`);
        }
      }
      return leaks;
    };
    expect(scan()).toEqual([]);
    // The scan finds a key where one is: a line that quotes it is a leak it reports.
    keyed.postMessage(made.direct_session.id, { body: "my key is sk-canary-endpoint-0123456789" });
    expect(scan()).toContain("messages.body");
  } finally {
    keyed.close();
    rmSync(canaryDir, { recursive: true, force: true });
  }
});
