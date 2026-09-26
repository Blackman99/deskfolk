/**
 * Opening databases that earlier builds created.
 *
 * Every other store test opens `:memory:`, which is always a fresh database, so `migrate.ts` never
 * runs against real rows and `SCHEMA_SQL` is only ever executed on an empty file. That blind spot
 * shipped a daemon that could not start: an index over `task_id` sat in `SCHEMA_SQL`, which runs
 * before the migration adds that column. On a fresh database the column was already there from the
 * `CREATE TABLE`; on every existing one the `CREATE TABLE IF NOT EXISTS` was a no-op, the index
 * threw `no such column: task_id`, and the window said only that it could not reach the runtime.
 *
 * The rule that broke, stated so it can be checked: **on an existing database every
 * `CREATE TABLE IF NOT EXISTS` is a no-op while every other statement still runs**, so anything in
 * `SCHEMA_SQL` that is not a `CREATE TABLE` has to be valid against the oldest shape still out
 * there — not against the `CREATE TABLE` directly above it. An index over a column that
 * `migrate.ts` adds belongs in `migrate.ts`.
 *
 * Each fixture in `fixtures/` is a schema as it once shipped. Opening one has to come up and be
 * usable. When you add a column to a table that already shipped, drop the previous `SCHEMA_SQL`
 * in here as a new fixture — the same moment you write the migration.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from ".";
import { ulid } from "../ids";
import { migrateSchema } from "./migrate";

const FIXTURES = join(dirname(import.meta.path), "fixtures");

/**
 * One turn row whose route decision still exists, and one judgement row whose model was never
 * stored. The ledger migration has to keep both and fill only what the old tables can answer.
 */
function seedLegacySpend(db: Database): void {
  const now = "2026-01-01T00:00:00.000Z";
  const botId = ulid();
  const sessionId = ulid();
  const messageId = ulid();
  const turnId = ulid();
  const judgementId = ulid();
  const providerId = ulid();
  db.run(
    `INSERT INTO providers (id, name, base_url, models, default_model, created_at, updated_at) VALUES (?, 'Legacy', 'https://legacy.invalid', '[]', NULL, ?, ?)`,
    [providerId, now, now],
  );
  db.run(
    `INSERT INTO bots (id, name, duties, boundaries, created_at, updated_at) VALUES (?, 'Ledger', 'write', 'none', ?, ?)`,
    [botId, now, now],
  );
  db.run(
    `INSERT INTO sessions (id, kind, name, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?)`,
    [sessionId, now, now],
  );
  db.run(
    `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, 'user', ?, NULL), (?, ?, ?, NULL)`,
    [sessionId, now, sessionId, botId, now],
  );
  db.run(
    `INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES (?, ?, 'user', 'user', 'hello', ?)`,
    [messageId, sessionId, now],
  );
  db.run(
    `INSERT INTO turns (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?)`,
    [turnId, sessionId, botId, messageId, now, now, now],
  );
  db.run(
    `INSERT INTO turn_route_decisions (turn_id, session_id, trigger_message_id, model, thinking_level, signature, created_at) VALUES (?, ?, ?, 'legacy-model', 'low', 'general', ?)`,
    [turnId, sessionId, messageId, now],
  );
  db.run(`UPDATE turn_route_decisions SET provider_id = ? WHERE turn_id = ?`, [providerId, turnId]);
  db.run(
    `INSERT INTO judgements (id, session_id, message_id, bot_id, decision, created_at) VALUES (?, ?, ?, ?, 'pass', ?)`,
    [judgementId, sessionId, messageId, botId, now],
  );
  // A shape from after the ledger already carries the kind and the names; the pre-ledger shape
  // has the migration fill them in from the decision and the session.
  const ledger = db
    .query<{ name: string }, []>("PRAGMA table_info(spend)")
    .all()
    .some((column) => column.name === "kind");
  if (ledger) {
    db.run(
      `INSERT INTO spend (id, session_id, session_name, bot_id, bot_name, turn_id, judgement_id, kind, provider_id, provider_name, model, thinking_level, input_tokens, output_tokens, total_tokens, created_at)
       VALUES (?, ?, 'Ledger', ?, 'Ledger', ?, NULL, 'turn', ?, 'Legacy', 'legacy-model', 'low', 3, 1, 4, ?)`,
      [ulid(), sessionId, botId, turnId, providerId, now],
    );
    db.run(
      `INSERT INTO spend (id, session_id, session_name, bot_id, bot_name, turn_id, judgement_id, kind, created_at)
       VALUES (?, ?, 'Ledger', ?, 'Ledger', NULL, ?, 'judgement', ?)`,
      [ulid(), sessionId, botId, judgementId, now],
    );
    return;
  }
  db.run(
    `INSERT INTO spend (id, session_id, bot_id, turn_id, judgement_id, input_tokens, output_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, NULL, 3, 1, 4, ?)`,
    [ulid(), sessionId, botId, turnId, now],
  );
  db.run(
    `INSERT INTO spend (id, session_id, bot_id, turn_id, judgement_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    [ulid(), sessionId, botId, judgementId, now],
  );
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

describe("a database an earlier build created", () => {
  test("there is at least one shipped shape to open", () => {
    // Without this, deleting the fixtures would turn the suite below into a silent no-op.
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames()) {
    test(`${name} opens, catches up, and still runs a turn`, () => {
      const dir = mkdtempSync(join(tmpdir(), "real-bot-migrate-"));
      const file = join(dir, "state.sqlite");
      try {
        const old = new Database(file, { create: true, strict: true });
        old.exec(readFileSync(join(FIXTURES, name), "utf8"));
        seedLegacySpend(old);
        old.close();

        // The failure this guards against is the constructor throwing, which is what stops the
        // daemon from starting. Everything below only matters once it does not.
        const store = new Store({ filename: file });

        // The seeded turn's job — backfilled or already there — learns what it was asked for.
        expect(store.db.query<{ brief: string | null }, []>("SELECT brief FROM tasks").all()).toEqual([
          { brief: "hello" },
        ]);

        const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
        const trigger = store.postMessage(writer.direct_session.id, { body: "导出季度报表" });
        const turn = store.createTurn({
          sessionId: writer.direct_session.id,
          botId: writer.bot.id,
          triggerMessageId: trigger.id,
        });
        expect(store.getTask(turn.task_id!).dir.startsWith("work/")).toBe(true);

        // Reopening is its own risk: a migration that is not idempotent passes the first time.
        store.close();
        const reopened = new Store({ filename: file });
        expect(reopened.getTurn(turn.id).task_id).toBe(turn.task_id!);
        const ledger = reopened.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'spend'").get()!.sql;
        expect(ledger).toContain("kind TEXT NOT NULL");
        expect(ledger).toContain("'organize'");
        expect(ledger).not.toContain("REFERENCES");
        // The plan columns and the ticket tables are there, and a plan that was closed before
        // plans had a status reads as done.
        const planTables = reopened.db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tickets', 'task_spec_revisions') ORDER BY name")
          .all()
          .map((row) => row.name);
        expect(planTables).toEqual(["task_spec_revisions", "tickets"]);
        expect(reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE closed_at IS NOT NULL AND status != 'done'").get()!.n).toBe(0);
        expect(reopened.getTask(turn.task_id!)).toMatchObject({ status: "active", spec: null, routine_id: null });
        const ticket = reopened.createTicket({ taskId: turn.task_id!, title: "初稿", spec: "", status: "todo", worker: null });
        expect(reopened.listTickets(turn.task_id!).map((row) => row.id)).toEqual([ticket.id]);
        const kept = reopened.listSpend({});
        expect(kept).toHaveLength(2);
        const turnRow = kept.find((row) => row.turn_id !== null)!;
        const judgementRow = kept.find((row) => row.judgement_id !== null)!;
        expect(turnRow.kind).toBe("turn");
        expect(turnRow.model).toBe("legacy-model");
        expect(turnRow.thinking_level).toBe("low");
        expect(turnRow.provider_id).toBeTruthy();
        expect(turnRow.session_name).toBe("Ledger");
        expect(turnRow.bot_name).toBe("Ledger");
        expect(judgementRow.kind).toBe("judgement");
        expect(judgementRow.model).toBeNull();
        expect(judgementRow.provider_id).toBeNull();
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("a failed spend rebuild rolls back and the next open still copies the old rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-migrate-"));
    const file = join(dir, "state.sqlite");
    try {
      const old = new Database(file, { create: true, strict: true });
      old.exec(readFileSync(join(FIXTURES, "schema-pre-spend-ledger.sql"), "utf8"));
      seedLegacySpend(old);
      const before = old.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spend").get()!.n;
      expect(before).toBe(2);
      const renamed = old.run.bind(old);
      let dropped = false;
      old.run = ((sql: string, ...bindings: Parameters<Database["run"]> extends [string, ...infer R] ? R : never) => {
        if (sql.startsWith("DROP TABLE spend")) {
          dropped = true;
          throw new Error("interrupted after the copy");
        }
        return renamed(sql, ...bindings);
      }) as Database["run"];
      expect(() => migrateSchema(old)).toThrow("interrupted after the copy");
      expect(dropped).toBe(true);
      const stranded = old
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('spend', 'spend_ledger')")
        .all()
        .map((row) => row.name);
      expect(stranded).toEqual(["spend"]);
      expect(old.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spend").get()!.n).toBe(before);
      old.close();

      const reopened = new Store({ filename: file });
      expect(reopened.listSpend({})).toHaveLength(before);
      const tables = reopened.db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('spend', 'spend_ledger')")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(["spend"]);
      expect(reopened.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'spend'").get()!.sql).toContain("kind TEXT NOT NULL");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
