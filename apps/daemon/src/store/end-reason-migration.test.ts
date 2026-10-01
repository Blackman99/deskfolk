import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSchema } from "./migrate";
import { SCHEMA_SQL } from "../schema";
import { migrateEndReasons } from "./end-reason-migration";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(level = 3, filename = ":memory:") {
  const db = new Database(filename, { create: true });
  databases.push(db);
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const at = "2026-09-29T08:00:00.000Z";
  db.run("INSERT INTO bots (id, name, duties, boundaries, created_at, updated_at) VALUES ('bot', 'Writer', '', '', ?, ?)", [at, at]);
  db.run("INSERT INTO sessions (id, kind, created_at, updated_at) VALUES ('session', 'direct', ?, ?)", [at, at]);
  db.run("INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES ('trigger', 'session', 'user', 'user', 'work', ?)", [at]);
  db.run("INSERT INTO work_items (id, bot_id, home_session_id, state, created_at, updated_at) VALUES ('work', 'bot', 'session', 'running', ?, ?)", [at, at]);
  db.run(`INSERT INTO turns (id, session_id, bot_id, trigger_message_id, status, work_item_id, last_activity_at, created_at, updated_at)
    VALUES ('turn', 'session', 'bot', 'trigger', 'running', 'work', ?, ?, ?)`, [at, at, at]);
  return db;
}

test("engine 3 refuses every terminal bound status without a nonblank end reason", () => {
  const db = fixture();
  for (const status of ["completed", "stopped", "interrupted", "redirected"]) {
    for (const reason of [null, "", " \t\n\r "]) {
      expect(() => db.run("UPDATE turns SET status = ?, end_reason = ? WHERE id = 'turn'", [status, reason])).toThrow("end_reason_required");
      expect(db.query("SELECT status, end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ status: "running", end_reason: null });
    }
  }
});

test("terminal inserts require a reason only for bound work and preserve unrestricted valid reasons", () => {
  const db = fixture();
  const insert = (id: string, workId: string | null, reason: string | null) => db.run(`INSERT INTO turns
    (id, session_id, bot_id, trigger_message_id, status, work_item_id, end_reason, last_activity_at, created_at, updated_at)
    VALUES (?, 'session', 'bot', 'trigger', 'completed', ?, ?, '2026-09-29', '2026-09-29', '2026-09-29')`, [id, workId, reason]);
  expect(() => insert("missing-reason", "work", null)).toThrow("end_reason_required");
  expect(() => insert("blank-reason", "work", " \t\n ")).toThrow("end_reason_required");
  insert("legacy-unbound", null, null);
  insert("future-reason", "work", "render_completed:v2");
  expect(db.query("SELECT end_reason FROM turns WHERE id = 'legacy-unbound'").get()).toEqual({ end_reason: null });
  expect(db.query("SELECT end_reason FROM turns WHERE id = 'future-reason'").get()).toEqual({ end_reason: "render_completed:v2" });
  expect(() => db.run("UPDATE turns SET end_reason = '' WHERE id = 'future-reason'")).toThrow("end_reason_required");
  expect(() => db.run("UPDATE turns SET work_item_id = 'work' WHERE id = 'legacy-unbound'")).toThrow("end_reason_required");
});

test("levels 0–2 preserve legacy bound writes and raising to 3 enforces future mutations dynamically", () => {
  for (const level of [0, 1, 2]) {
    const db = fixture(level);
    db.run("UPDATE turns SET status = 'stopped' WHERE id = 'turn'");
    expect(db.query("SELECT status, end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ status: "stopped", end_reason: null });
    db.run("UPDATE settings SET value = '3' WHERE key = 'engine_level'");
    expect(() => db.run("UPDATE turns SET updated_at = '2026-09-30' WHERE id = 'turn'")).toThrow("end_reason_required");
    db.run("UPDATE turns SET end_reason = 'legacy_stop_import' WHERE id = 'turn'");
    expect(db.query("SELECT end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ end_reason: "legacy_stop_import" });
  }
});

test("historical terminal backfill runs once, preserves explicit reasons, and reinstalls guards on reopen", () => {
  const db = fixture(2);
  db.run("DELETE FROM settings WHERE key = 'end_reasons_backfilled'");
  db.run("UPDATE turns SET status = 'interrupted' WHERE id = 'turn'");
  db.run(`INSERT INTO turns (id, session_id, bot_id, trigger_message_id, status, work_item_id, end_reason, last_activity_at, created_at, updated_at)
    VALUES ('explicit', 'session', 'bot', 'trigger', 'completed', 'work', 'answered', '2026-09-29', '2026-09-29', '2026-09-29')`);
  migrateEndReasons(db);
  expect(db.query("SELECT end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ end_reason: "interrupted" });
  expect(db.query("SELECT end_reason FROM turns WHERE id = 'explicit'").get()).toEqual({ end_reason: "answered" });
  db.run("UPDATE turns SET end_reason = NULL WHERE id = 'turn'");
  migrateEndReasons(db);
  expect(db.query("SELECT end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ end_reason: null });
  db.run("UPDATE settings SET value = '3' WHERE key = 'engine_level'");
  expect(() => db.run("UPDATE turns SET status = 'completed' WHERE id = 'turn'")).toThrow("end_reason_required");
  expect(db.query("SELECT status FROM turns WHERE id = 'turn'").get()).toEqual({ status: "interrupted" });
});

test("a real database reopen keeps the once-only import and engine-3 trigger contract", () => {
  const root = mkdtempSync(join(tmpdir(), "end-reason-migration-"));
  const filename = join(root, "state.sqlite");
  try {
    const original = fixture(2, filename);
    original.run("DELETE FROM settings WHERE key = 'end_reasons_backfilled'");
    original.run("UPDATE turns SET status = 'redirected' WHERE id = 'turn'");
    original.close();
    databases.splice(databases.indexOf(original), 1);
    const reopened = new Database(filename);
    databases.push(reopened);
    migrateSchema(reopened);
    expect(reopened.query("SELECT end_reason FROM turns WHERE id = 'turn'").get()).toEqual({ end_reason: "redirected" });
    reopened.run("UPDATE settings SET value = '3' WHERE key = 'engine_level'");
    expect(() => reopened.run("UPDATE turns SET end_reason = NULL WHERE id = 'turn'")).toThrow("end_reason_required");
    expect(reopened.query("SELECT value FROM settings WHERE key = 'end_reasons_backfilled'").get()).toEqual({ value: "1" });
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    for (const db of databases.splice(0)) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
