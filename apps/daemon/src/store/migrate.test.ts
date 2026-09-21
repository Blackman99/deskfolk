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

const FIXTURES = join(dirname(import.meta.path), "fixtures");

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
        old.close();

        // The failure this guards against is the constructor throwing, which is what stops the
        // daemon from starting. Everything below only matters once it does not.
        const store = new Store({ filename: file });

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
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
