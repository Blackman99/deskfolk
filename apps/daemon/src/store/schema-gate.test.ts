/**
 * The version gate: a database a newer build already raised the floor on refuses to open under an
 * older one, `engine_level` defaults to 0 until some future phase raises it, and the shutdown flag
 * starts optimistic (nothing to blame on a first-ever boot) and turns pessimistic the moment a
 * database is opened, waiting for `recordCleanShutdown` to prove the run that follows was orderly.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";
import { SCHEMA_LEVEL, SchemaTooNewError } from "./schema-gate";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-schema-gate-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

describe("schema gate", () => {
  test("a fresh database opens at engine level 0 with no floor set", () => {
    const store = new Store();
    expect(store.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: 0, features: [] });
    store.close();
  });

  test("refuses to open a database whose floor is above what this build supports", () => {
    const file = tempFile();
    const seed = new Store({ filename: file });
    seed.db.run("INSERT INTO settings (key, value) VALUES ('schema_min_compatible', ?)", [String(SCHEMA_LEVEL + 1)]);
    seed.close();

    let thrown: unknown;
    try {
      new Store({ filename: file });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect((thrown as SchemaTooNewError).message).toContain(String(SCHEMA_LEVEL + 1));

    // The constructor closed its own handle before throwing. A readonly open, or even a plain
    // BEGIN EXCLUSIVE, would succeed with the refused handle still open: in WAL mode neither waits
    // on an idle connection. An exclusive-locking-mode transaction does — a WAL connection holds a
    // shared lock on the file for as long as it stays open — so this fails with "database is
    // locked" if the refused attempt leaked its handle.
    const check = new Database(file, { strict: true });
    try {
      check.run("PRAGMA locking_mode = EXCLUSIVE");
      expect(() => check.run("BEGIN EXCLUSIVE")).not.toThrow();
      check.run("ROLLBACK");
    } finally {
      check.close();
    }
  });

  test("refuses to open even when SCHEMA_SQL cannot run against the database (a dropped indexed column)", () => {
    const file = tempFile();
    const seed = new Store({ filename: file });
    // `remote_replays_expiry` indexes `remote_replays.expires_ms` (schema.ts). Drop the column a
    // later build's own migration might have dropped, so SCHEMA_SQL's `CREATE INDEX IF NOT EXISTS`
    // — the table already exists, so only the index statement runs — would fail with a raw
    // "no such column" if it ran at all. It must never get the chance to.
    seed.db.run("DROP INDEX remote_replays_expiry");
    seed.db.run("ALTER TABLE remote_replays DROP COLUMN expires_ms");
    seed.db.run("INSERT INTO settings (key, value) VALUES ('schema_min_compatible', ?)", [String(SCHEMA_LEVEL + 1)]);
    seed.close();

    let thrown: unknown;
    try {
      new Store({ filename: file });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaTooNewError);

    // sqlite_master is untouched: the gate ran before SCHEMA_SQL ever reached the index statement.
    const check = new Database(file, { readonly: true });
    const columns = check.query<{ name: string }, []>("PRAGMA table_info(remote_replays)").all().map((row) => row.name);
    expect(columns).not.toContain("expires_ms");
    const index = check.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'remote_replays_expiry'",
    ).get();
    expect(index).toBeNull();
    check.close();
  });

  test("a floor that is not a number refuses to open too, rather than fail open", () => {
    const file = tempFile();
    const seed = new Store({ filename: file });
    seed.db.run("INSERT INTO settings (key, value) VALUES ('schema_min_compatible', 'not-a-number')");
    seed.close();

    let thrown: unknown;
    try {
      new Store({ filename: file });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
  });

  test("a floor at or below this build's level opens normally", () => {
    const file = tempFile();
    const seed = new Store({ filename: file });
    seed.db.run("INSERT INTO settings (key, value) VALUES ('schema_min_compatible', ?)", [String(SCHEMA_LEVEL)]);
    seed.close();
    const reopened = new Store({ filename: file });
    expect(reopened.capabilities().schema_level).toBe(SCHEMA_LEVEL);
    reopened.close();
  });

  test("engine_level reads back whatever the settings row holds", () => {
    const file = tempFile();
    const seed = new Store({ filename: file });
    seed.db.run("INSERT INTO settings (key, value) VALUES ('engine_level', '3')");
    seed.close();
    const reopened = new Store({ filename: file });
    expect(reopened.capabilities().engine_level).toBe(3);
    reopened.close();
  });

  test("a first-ever boot reads previousShutdown as clean; every boot after resets the flag to crash", () => {
    const file = tempFile();
    const first = new Store({ filename: file });
    expect(first.previousShutdown).toBe("clean");
    first.close();

    // Nothing recorded a clean exit for the first run, so the second boot inherits crash.
    const second = new Store({ filename: file });
    expect(second.previousShutdown).toBe("crash");
    second.close();
  });

  test("the gate's own rows stay out of the change journal: recording a clean shutdown publishes nothing", () => {
    const store = new Store();
    const events: string[] = [];
    store.onCommit((event) => events.push(event.event));
    store.recordCleanShutdown();
    // Any later commit flushes whatever the journal picked up since the last one.
    store.transaction(() => {});
    expect(events).toEqual([]);

    // A settings row someone does edit still reaches clients, through the same flush.
    store.db.run("INSERT INTO settings (key, value) VALUES ('locale', 'en') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    store.transaction(() => {});
    expect(events).toEqual(["settings.changed"]);
    store.close();
  });

  test("recordCleanShutdown is what the next boot reads back as clean", () => {
    const file = tempFile();
    const first = new Store({ filename: file });
    first.recordCleanShutdown();
    first.close();

    const second = new Store({ filename: file });
    expect(second.previousShutdown).toBe("clean");
    // This run's own flag is already reset to crash, in case it never gets to record its own exit.
    expect(second.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'last_shutdown'").get()?.value).toBe("crash");
    second.close();
  });
});
