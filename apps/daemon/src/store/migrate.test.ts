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
        // Acceptance checks: the two tables come up (fresh tables, so SCHEMA_SQL alone brings them),
        // and `turn_runs` — which already existed — picked up its new `cwd` column.
        const checkTables = reopened.db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('acceptance_checks', 'acceptance_check_runs') ORDER BY name")
          .all()
          .map((row) => row.name);
        expect(checkTables).toEqual(["acceptance_check_runs", "acceptance_checks"]);
        const turnRunCols = reopened.db.query<{ name: string }, []>("PRAGMA table_info(turn_runs)").all().map((row) => row.name);
        expect(turnRunCols).toContain("cwd");
        // `messages` picked up the 进度询问 status-line mark, defaulted to unhidden for every row
        // that predates it.
        const messageCols = reopened.db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
        expect(messageCols).toContain("hidden_from_bots");
        expect(
          reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE hidden_from_bots != 0").get()!.n,
        ).toBe(0);
        expect(reopened.listChecks(turn.task_id!)).toEqual([]);
        // Holds (ADR 0040 P2): a new table the schema brings up, and the wait columns on check_backs.
        const checkBackCols = reopened.db.query<{ name: string }, []>("PRAGMA table_info(check_backs)").all().map((row) => row.name);
        expect(checkBackCols).toEqual(expect.arrayContaining(["cause", "wait_spec", "suspended_at", "dedupe_key", "attempts"]));
        // A plan version a hold wrote says so, so the organizer reads past it.
        const revisionCols = reopened.db.query<{ name: string }, []>("PRAGMA table_info(task_spec_revisions)").all().map((row) => row.name);
        expect(revisionCols).toContain("cause");
        expect(reopened.listHolds()).toEqual([]);
        expect(reopened.db.query("SELECT * FROM held_scopes").all()).toEqual([]);
        // What the app made of your stops on a line; no line from before carries one.
        expect(messageCols).toContain("control");
        expect(reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE control IS NOT NULL").get()!.n).toBe(0);
        // The Bot-only mark (ADR 0041): none of the lines from before is a note for a Bot alone.
        expect(messageCols).toContain("bot_only");
        expect(reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE bot_only != 0").get()!.n).toBe(0);
        // The turn row's mode, and the triggers that read it (I2), which a trigger naming a column
        // the table lacks would break every turn written through; the work log, empty.
        const turnCols = reopened.db.query<{ name: string }, []>("PRAGMA table_info(turns)").all().map((row) => row.name);
        expect(turnCols).toContain("mode");
        const triggers = reopened.db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'turns' ORDER BY name")
          .all()
          .map((row) => row.name);
        expect(triggers).toEqual(["turns_held_insert", "turns_held_update"]);
        expect(reopened.listWorkEvents()).toEqual([]);
        // Opening an older database raises neither the engine level nor the floor by itself.
        expect(reopened.capabilities().engine_level).toBe(0);
        reopened.patchSettingsSync({ workspace_path: join(dir, "workspace") });
        const check = reopened.createCheckByUser(turn.task_id!, { item: "交出 report.md", kind: "exists", path: "report.md" });
        expect(reopened.listChecks(turn.task_id!)).toEqual([check]);
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

  test("the notes stopped work opened again on before the Bot-only mark leave the conversation, and nothing else does", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-migrate-"));
    const file = join(dir, "state.sqlite");
    try {
      const old = new Database(file, { create: true, strict: true });
      old.exec(readFileSync(join(FIXTURES, "schema-pre-bot-only-lines.sql"), "utf8"));
      const now = "2026-09-30T08:00:00.000Z";
      const botId = ulid();
      const sessionId = ulid();
      old.run(`INSERT INTO bots (id, name, duties, boundaries, created_at, updated_at) VALUES (?, 'Writer', 'write', 'none', ?, ?)`, [botId, now, now]);
      old.run(`INSERT INTO sessions (id, kind, name, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?)`, [sessionId, now, now]);
      old.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, 'user', ?, NULL), (?, ?, ?, NULL)`,
        [sessionId, now, sessionId, botId, now],
      );
      const lines = {
        zh: "（应用提示）用户叫停了这件工作，现在解除了（原话：「继续」）。\n叫停期间这里说过的话都在上面的转录里。",
        en: "(App note) The user had stopped this work and has now lifted the stop.\nWhat was said here while it was stopped is in the transcript above.",
        receipt: "已解除叫停：Writer 的全部工作。",
        quoted: "用户叫停了这件工作，现在解除了——这是我转述的",
      };
      const ids: Record<string, string> = {};
      for (const [name, body] of Object.entries(lines)) {
        ids[name] = ulid();
        const kind = name === "quoted" ? "bot" : "system";
        old.run(`INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [ids[name]!, sessionId, kind, botId, body, now]);
      }
      old.close();

      const store = new Store({ filename: file });
      const flagged = store.db
        .query<{ id: string }, []>("SELECT id FROM messages WHERE bot_only = 1 ORDER BY id")
        .all()
        .map((row) => row.id);
      expect(flagged).toEqual([ids.zh!, ids.en!].sort());
      expect(store.listMessages(sessionId).items.map((message) => message.id).sort()).toEqual([ids.receipt!, ids.quoted!].sort());
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test("acceptance_checks widens for 'continuity' without losing existing checks or their runs, and a continuity check then inserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-migrate-"));
    const file = join(dir, "state.sqlite");
    try {
      const old = new Database(file, { create: true, strict: true });
      old.exec(readFileSync(join(FIXTURES, "schema-pre-continuity-checks.sql"), "utf8"));
      const now = "2026-01-01T00:00:00.000Z";
      const botId = ulid();
      const sessionId = ulid();
      const messageId = ulid();
      const taskId = ulid();
      const checkId = ulid();
      const orphanCheckId = ulid();
      const runId = ulid();
      const openRunId = ulid();
      old.run(`INSERT INTO bots (id, name, duties, boundaries, created_at, updated_at) VALUES (?, 'Writer', 'write', 'none', ?, ?)`, [botId, now, now]);
      old.run(`INSERT INTO sessions (id, kind, name, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?)`, [sessionId, now, now]);
      old.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, 'user', ?, NULL), (?, ?, ?, NULL)`,
        [sessionId, now, sessionId, botId, now],
      );
      old.run(`INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES (?, ?, 'user', 'user', 'hello', ?)`, [messageId, sessionId, now]);
      old.run(`INSERT INTO tasks (id, session_id, title, dir, brief, status, created_at) VALUES (?, ?, '写周报', 'work/x', 'hello', 'active', ?)`, [
        taskId,
        sessionId,
        now,
      ]);
      old.run(
        `INSERT INTO acceptance_checks
           (id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd, expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at, defined_at, first_passed_at, removed_at)
         VALUES (?, ?, NULL, '交出 report.md', 'exists', 'report.md', NULL, 0, NULL, NULL, NULL, NULL, NULL, 'user', ?, ?, ?, ?, NULL)`,
        [checkId, taskId, now, now, now, now],
      );
      old.run(
        `INSERT INTO acceptance_check_runs (id, check_id, task_id, cause, started_at, finished_at, outcome, exit_code, detail, output)
         VALUES (?, ?, ?, 'user', ?, ?, 'pass', NULL, 'ok', NULL)`,
        [runId, checkId, taskId, now, now],
      );
      // A run still open when the old build stopped — the boot-time recovery sweep, not this
      // migration, is what closes these; the migration must still carry it across untouched.
      old.run(
        `INSERT INTO acceptance_check_runs (id, check_id, task_id, cause, started_at, finished_at, outcome, exit_code, detail, output)
         VALUES (?, ?, ?, 'settle', ?, NULL, NULL, NULL, '', NULL)`,
        [openRunId, checkId, taskId, now],
      );
      // A tombstoned check: gone from `listChecks`, but its own row and its run must still survive
      // the rebuild (the FK from acceptance_check_runs must not have cascaded on the DROP).
      const orphanRunId = ulid();
      old.run(
        `INSERT INTO acceptance_checks
           (id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd, expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at, defined_at, first_passed_at, removed_at)
         VALUES (?, ?, NULL, '以前的检查', 'command', NULL, NULL, 0, 'true', NULL, 0, NULL, NULL, 'user', ?, ?, ?, NULL, ?)`,
        [orphanCheckId, taskId, now, now, now, now],
      );
      old.run(
        `INSERT INTO acceptance_check_runs (id, check_id, task_id, cause, started_at, finished_at, outcome, exit_code, detail, output)
         VALUES (?, ?, ?, 'user', ?, ?, 'fail', 1, 'no', NULL)`,
        [orphanRunId, orphanCheckId, taskId, now, now],
      );
      const shape = old.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'acceptance_checks'`).get()!.sql;
      expect(shape).not.toContain("'continuity'");
      old.close();

      const store = new Store({ filename: file });
      const widened = store.db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'acceptance_checks'`).get()!.sql;
      expect(widened).toContain("'continuity'");
      // Every row and every run of both checks survived, untouched.
      expect(store.getCheck(checkId)).toMatchObject({ item: "交出 report.md", kind: "exists", last_run: { outcome: "pass" } });
      const runs = store.db.query<{ id: string }, [string]>(`SELECT id FROM acceptance_check_runs WHERE check_id = ? ORDER BY started_at, rowid`).all(checkId);
      expect(runs.map((row) => row.id)).toEqual([runId, openRunId]);
      const orphanRuns = store.db
        .query<{ id: string }, [string]>(`SELECT id FROM acceptance_check_runs WHERE check_id = ?`)
        .all(orphanCheckId);
      expect(orphanRuns.map((row) => row.id)).toEqual([orphanRunId]);
      // The FK is still live: deleting the plan still cascades to both checks and both their runs.
      store.db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
      expect(store.db.query(`SELECT id FROM acceptance_checks WHERE id = ?`).get(checkId)).toBeNull();
      expect(store.db.query(`SELECT id FROM acceptance_check_runs WHERE check_id = ?`).get(checkId)).toBeNull();
      store.close();

      // Reopening is idempotent: the widen guard reads "already has 'continuity'" and skips the rebuild.
      const reopened = new Store({ filename: file });
      reopened.patchSettingsSync({ workspace_path: join(dir, "workspace") });
      const plan = reopened.openTask({ sessionId, title: "新的一件事" });
      const continuityCheck = reopened.createCheckByUser(plan.id, { item: "镜头连贯", kind: "continuity", command: "true" });
      expect(continuityCheck.kind).toBe("continuity");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
