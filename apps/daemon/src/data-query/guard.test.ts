import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as describeRecords, runQuery } from "./child";
import { checkPlan, deniedTable, scanSql } from "./guard";

const dir = mkdtempSync(join(tmpdir(), "records-guard-"));
const path = join(dir, "state.sqlite");
{
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT, raw BLOB)");
  db.run("CREATE TABLE remote_push_subs (device_id TEXT, auth TEXT)");
  db.run("CREATE INDEX remote_push_subs_auth ON remote_push_subs(auth)");
  db.run("CREATE TABLE terminals (id TEXT, scrollback TEXT)");
  db.run("CREATE VIEW leak AS SELECT auth FROM remote_push_subs");
  db.run("INSERT INTO messages VALUES ('m1', 'hello', x'00010203'), ('m2', 'world', NULL), ('m3', 'again', NULL)");
  db.run("INSERT INTO remote_push_subs VALUES ('d1', 'push-secret-canary')");
  db.run("INSERT INTO terminals VALUES ('t1', 'export TOKEN=terminal-canary')");
  db.close();
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const query = (sql: string, params: Array<string | number | null> = [], maxRows = 100) => runQuery({ mode: "query", db: path, sql, params, maxRows });

test("only one statement that reads gets through the words", () => {
  expect(scanSql("SELECT 1")).toEqual({ ok: true });
  expect(scanSql("  with x as (select 1) select * from x ;  ")).toEqual({ ok: true });
  expect(scanSql("VALUES (1)")).toEqual({ ok: true });
  expect(scanSql("SELECT 1; SELECT 2")).toMatchObject({ ok: false, reason: "one statement at a time" });
  // A semicolon inside a string or a comment is not a second statement.
  expect(scanSql("SELECT ';' -- ; DROP TABLE x\n")).toEqual({ ok: true });
  expect(scanSql("SELECT 1 /* ; */")).toEqual({ ok: true });
  for (const sql of ["DELETE FROM messages", "WITH x AS (SELECT 1) DELETE FROM messages", "ATTACH 'other.db' AS o", "PRAGMA table_info(messages)", "SELECT load_extension('x')", "SELECT * FROM pragma_table_info('messages')", "SELECT * FROM dbstat", "SELECT * FROM sqlite_dbpage"]) {
    expect(scanSql(sql).ok).toBe(false);
  }
});

test("a table Bots may not read is no such table, however it is quoted", () => {
  for (const name of ["terminals", '"terminals"', "[terminals]", "`terminals`", "Remote_Push_Subs", "pending_keys", "request_receipts", "sqlite_master", "sqlite_schema"]) {
    const result = scanSql(`SELECT * FROM ${name}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no such table");
  }
  expect(deniedTable("remote_anything")).toBe(true);
  expect(deniedTable("messages")).toBe(false);
});

test("a query reads rows, cuts at its limit, and shows a blob by its size", () => {
  expect(query("SELECT id, body, raw FROM messages ORDER BY id", [], 2)).toMatchObject({
    ok: true, columns: ["id", "body", "raw"], rows: [["m1", "hello", { blob_bytes: 4 }], ["m2", "world", null]], truncated: true,
  });
  expect(query("SELECT body FROM messages WHERE id = ?", ["m3"])).toMatchObject({ ok: true, rows: [["again"]], truncated: false });
  expect(query("SELECT value FROM json_each('[1,2]')")).toMatchObject({ ok: true, rows: [[1], [2]] });
  // A recursive CTE, DISTINCT and a sort write only their own ephemeral tables: still a read.
  expect(query("WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 3) SELECT x FROM r")).toMatchObject({ ok: true, rows: [[1], [2], [3]] });
  expect(query("SELECT DISTINCT substr(body, 1, 1) AS c FROM messages ORDER BY c")).toMatchObject({ ok: true, rows: [["a"], ["h"], ["w"]] });
});

test("the query plan refuses what the words do not show: a view over a denied table, writes on a read-only connection", () => {
  const view = query("SELECT * FROM leak");
  expect(view.ok).toBe(false);
  if (!view.ok) expect(view.error).toBe("no such table: remote_push_subs");
  expect(query("SELECT 1 FROM messages WHERE body = (SELECT 'x')").ok).toBe(true);
  expect(query("SELECT * FROM nowhere").ok).toBe(false);
  // SQLite reads a quoted string as a table's name where only a name fits; the words miss it, the plan does not.
  expect(scanSql("SELECT * FROM 'terminals'")).toEqual({ ok: true });
  expect(query("SELECT * FROM 'terminals'")).toEqual({ ok: false, error: "no such table: terminals" });
});

test("of the virtual tables only json_each and json_tree are read, whatever the query calls them", () => {
  expect(query("SELECT j.value FROM messages, json_each('[1]') AS j WHERE messages.id = 'm1'")).toMatchObject({ ok: true, rows: [[1]] });
  expect(query("SELECT COUNT(*) FROM json_tree('{\"a\":[1,2]}')")).toMatchObject({ ok: true });
  // A table-valued function the word list does not name is refused by the plan.
  const json = new Set(["vtab:json"]);
  const plan = (p4: string) => [{ opcode: "VOpen", p1: 0, p2: 0, p3: 0, p4, p5: 0 }];
  expect(checkPlan(plan("vtab:json"), new Map(), json)).toEqual({ ok: true });
  expect(checkPlan(plan("vtab:other"), new Map(), json).ok).toBe(false);
  expect(scanSql("SELECT * FROM bytecode('SELECT * FROM terminals')").ok).toBe(false);
  // carray is in some SQLite builds and on no word list: the plan refuses it, even called json_each.
  const probe = new Database(":memory:");
  const hasCarray = (() => {
    try { probe.query("SELECT * FROM carray(1, 1)").all(); return true; } catch { return false; } finally { probe.close(); }
  })();
  if (hasCarray) {
    expect(scanSql("SELECT * FROM carray(1, 1) AS json_each")).toEqual({ ok: true });
    expect(query("SELECT * FROM carray(1, 1) AS json_each")).toEqual({ ok: false, error: "only the records, json_each and json_tree can be read" });
  }
});

test("describe lists what Bots may read, never a denied table", () => {
  const all = describeRecords({ mode: "describe", db: path, table: null, budgetMs: 2000 });
  expect(all.ok).toBe(true);
  if (!all.ok) return;
  expect(all.tables.map((table) => table.name)).toEqual(["leak", "messages"]);
  expect(all.tables.find((table) => table.name === "messages")).toMatchObject({ kind: "table", rows: 3 });
  expect(describeRecords({ mode: "describe", db: path, table: "terminals", budgetMs: 2000 })).toEqual({ ok: false, error: "no such table: terminals" });
});
