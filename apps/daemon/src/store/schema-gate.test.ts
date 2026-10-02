/**
 * The version gate: a database a newer build already raised the floor on refuses to open under an
 * older one, `engine_level` defaults to 0 until the boot raises it — and only while no installed
 * app sharing the database predates the gate, unless a developer accepted one — taking the floor
 * up with it and never going down again, and the shutdown flag starts optimistic (nothing to blame
 * on a first-ever boot) and turns pessimistic the moment a database is opened, waiting for
 * `recordCleanShutdown` to prove the run that follows was orderly.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";
import { acceptOlderApp, ENGINE_LEVEL, ENGINE_LEVELS, ENGINE_LEVEL_BY_DEFAULT, LAST_RELEASE_WITHOUT_GATE, raiseEngineLevel, readEngineGateOptIn, readEngineLevel, SCHEMA_LEVEL, SchemaTooNewError } from "./schema-gate";

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

  test("the engine level goes up, floor and all, when no installed app shares the database — but only to the default ceiling without an opt-in", () => {
    const file = tempFile();
    const store = new Store({ filename: file });
    // ENGINE_LEVEL_BY_DEFAULT: a level above it is experimental and never turns on
    // by itself, installed app or not — including a source run on a data folder of its own.
    expect(store.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL_BY_DEFAULT, raised: true, refused: null, accepted: null });
    expect(store.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL_BY_DEFAULT, features: ["holds", "work_items", "delegation", "supervision"] });
    // Already there: nothing to do, and the gate settings stay out of the change journal.
    const events: string[] = [];
    store.onCommit((event) => events.push(event.event));
    expect(store.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL_BY_DEFAULT, raised: false, refused: null, accepted: null });
    store.transaction(() => {});
    expect(events).toEqual([]);
    store.close();
    const floor = new Database(file, { readonly: true });
    expect(floor.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe(String(ENGINE_LEVEL_BY_DEFAULT));
    floor.close();
  });

  test("an opt-in raises the ceiling past the default even with no installed app sharing the database", () => {
    const store = new Store();
    const optIn = store.transaction(() => store.acceptOlderApp("api"));
    expect(optIn.level).toBe(ENGINE_LEVEL);
    expect(store.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL, raised: true, refused: null, accepted: null });
    expect(store.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing"] });
    store.close();
  });

  test("a stale or low opt-in never pulls the ceiling below the default, with no installed app sharing the database", () => {
    // An opt-in recorded by an earlier build, back when ENGINE_LEVEL was lower than today's
    // default: it must not hold a fresh database below ENGINE_LEVEL_BY_DEFAULT.
    const low = new Store();
    low.db.run("INSERT INTO settings (key, value) VALUES ('engine_gate_optin', ?)", [JSON.stringify({ at: "2026-09-29T00:00:00Z", by: "script", level: 2 })]);
    expect(low.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL_BY_DEFAULT, raised: true, refused: null, accepted: null });
    low.close();

    // An opt-in with no `level` field at all (reads as 1 via `readEngineGateOptIn`): the same.
    const noLevel = new Store();
    noLevel.db.run("INSERT INTO settings (key, value) VALUES ('engine_gate_optin', ?)", [JSON.stringify({ at: "2026-09-29T00:00:00Z", by: "script" })]);
    expect(noLevel.engineGateOptIn()?.level).toBe(1);
    expect(noLevel.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL_BY_DEFAULT, raised: true, refused: null, accepted: null });
    noLevel.close();

    // A database already at a level below the default, with an old opt-in for that same level:
    // it still goes up to the default, not just stay where the stale opt-in once left it.
    const file = tempFile();
    const seed = new Store({ filename: file });
    seed.db.run("INSERT INTO settings (key, value) VALUES ('engine_level', '3'), ('schema_min_compatible', '3'), ('engine_gate_optin', ?)",
      [JSON.stringify({ at: "2026-09-29T00:00:00Z", by: "script", level: 3 })]);
    seed.close();
    const reopened = new Store({ filename: file });
    expect(reopened.raiseEngineLevel(null)).toEqual({ level: ENGINE_LEVEL_BY_DEFAULT, raised: true, refused: null, accepted: null });
    reopened.close();
  });

  test("an installed app from before the gate, or one whose version cannot be read, holds the level where it is", () => {
    const store = new Store();
    for (const version of ["0.1.0-rc.11", LAST_RELEASE_WITHOUT_GATE, "", "not a version"]) {
      const raise = store.raiseEngineLevel({ version });
      expect(raise).toMatchObject({ level: 0, raised: false });
      expect(raise.refused).toContain("update it");
    }
    // Where there is no telling what is installed, the log says that rather than blame an app.
    const unseen = store.raiseEngineLevel({ unseen: "a source run cannot tell which app is installed on win32" });
    expect(unseen).toMatchObject({ level: 0, raised: false });
    expect(unseen.refused).toContain("cannot tell which app is installed on win32");
    expect(unseen.refused).toContain("REAL_BOT_DATA_DIR");
    expect(unseen.refused).not.toContain("update it");
    expect(store.db.query("SELECT 1 FROM settings WHERE key IN ('engine_level', 'schema_min_compatible')").all()).toEqual([]);
    // One that reads the gate refuses the raised floor itself, and says to update — but even so,
    // with no opt-in this build still stops itself at the default ceiling, not at ENGINE_LEVEL.
    expect(store.raiseEngineLevel({ version: "0.1.0-rc.13" })).toMatchObject({ level: ENGINE_LEVEL_BY_DEFAULT, raised: true });
    store.close();
  });

  test("the refusal names the developer's way past it", () => {
    const store = new Store();
    expect(store.raiseEngineLevel({ version: "0.1.0-rc.11" }).refused).toContain("scripts/engine-level.ts --accept-older-app");
    expect(store.raiseEngineLevel({ unseen: "a source run cannot tell which app is installed on win32" }).refused).toContain("--accept-older-app");
    store.close();
  });

  test("a developer's opt-in lets the level past an older installed app, and the log says so", () => {
    for (const installed of [{ version: "0.1.0-rc.11" }, { version: "" }, { unseen: "a source run cannot tell which app is installed on win32" }]) {
      const store = new Store();
      const events: string[] = [];
      store.onCommit((event) => events.push(event.event));
      const optIn = store.transaction(() => store.acceptOlderApp("script"));
      // A word about the database, not a setting anyone edits: no settings.changed goes out.
      expect(events).toEqual([]);
      expect(store.engineGateOptIn()).toEqual(optIn);
      expect(optIn.by).toBe("script");
      expect(optIn.level).toBe(ENGINE_LEVEL);
      const raise = store.raiseEngineLevel(installed);
      expect(raise).toMatchObject({ level: ENGINE_LEVEL, raised: true, refused: null });
      expect(raise.accepted).toContain(`engine level 0 → ${ENGINE_LEVEL}`);
      expect(raise.accepted).toContain(`script, ${optIn.at}`);
      expect(raise.accepted).toContain("would not honor holds");
      if ("version" in installed) expect(raise.accepted).toContain(`the installed app (${installed.version || "version unreadable"})`);
      else expect(raise.accepted).toContain(installed.unseen);
      expect(store.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing"] });
      store.close();
    }
  });

  test("with no older app in the way the opt-in is not what let the level up, and the log says nothing of it", () => {
    const store = new Store();
    store.acceptOlderApp("api");
    expect(store.raiseEngineLevel({ version: "0.1.0-rc.13" })).toEqual({ level: ENGINE_LEVEL, raised: true, refused: null, accepted: null });
    store.close();
  });

  test("an opt-in that does not read as one counts as none", () => {
    const store = new Store();
    store.db.run("INSERT INTO settings (key, value) VALUES ('engine_gate_optin', 'yes please')");
    expect(store.engineGateOptIn()).toBeNull();
    expect(store.raiseEngineLevel({ version: "0.1.0-rc.11" })).toMatchObject({ level: 0, raised: false });
    store.close();
  });

  test("taking the opt-in back never lowers the level, even with the older app still there", () => {
    const file = tempFile();
    const first = new Store({ filename: file });
    first.acceptOlderApp("api");
    expect(first.raiseEngineLevel({ version: "0.1.0-rc.11" })).toMatchObject({ level: ENGINE_LEVEL, raised: true });
    first.withdrawOlderAppOptIn();
    expect(first.engineGateOptIn()).toBeNull();
    expect(first.capabilities().engine_level).toBe(ENGINE_LEVEL);
    first.close();

    // The next boot finds the older app installed and no opt-in: the level is already there, so
    // there is nothing to refuse and nothing to take back.
    const next = new Store({ filename: file });
    expect(next.raiseEngineLevel({ version: "0.1.0-rc.11" })).toEqual({ level: ENGINE_LEVEL, raised: false, refused: null, accepted: null });
    expect(next.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing"] });
    expect(next.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe(String(SCHEMA_LEVEL));
    next.close();
  });
});

test("a developer's opt-in lets the level past an older app only up to the level it accepted", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const old = { version: LAST_RELEASE_WITHOUT_GATE };
  expect(raiseEngineLevel(db, old).raised).toBe(false);
  // An opt-in recorded for a lower level than this build brings does not cover this one.
  db.run("INSERT INTO settings (key, value) VALUES ('engine_gate_optin', ?)", [JSON.stringify({ at: "2026-09-30T00:00:00.000Z", by: "api", level: 0 })]);
  const stale = raiseEngineLevel(db, old);
  expect(stale.raised).toBe(false);
  expect(stale.refused).toContain("accept again");
  acceptOlderApp(db, "api");
  expect(readEngineGateOptIn(db)?.level).toBe(ENGINE_LEVEL);
  const raised = raiseEngineLevel(db, old);
  expect(raised).toMatchObject({ level: ENGINE_LEVEL, raised: true, refused: null });
  expect(readEngineLevel(db)).toBe(ENGINE_LEVEL);
  db.close();
});

test("an opt-in accepted for the delegation level does not carry the database into the supervisor's level", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // Where an earlier build left a developer's database: at delegation, floor 3, the opt-in it accepted.
  db.run("INSERT INTO settings (key, value) VALUES ('engine_level', '3'), ('schema_min_compatible', '3'), ('engine_gate_optin', ?)",
    [JSON.stringify({ at: "2026-09-30T00:00:00.000Z", by: "script", level: 3 })]);
  const old = { version: "0.1.0-rc.11" };
  const refused = raiseEngineLevel(db, old);
  expect(refused).toMatchObject({ level: 3, raised: false, accepted: null });
  expect(refused.refused).toContain("covers level 3");
  expect(refused.refused).toContain(`this build brings ${ENGINE_LEVEL}`);
  expect(readEngineLevel(db)).toBe(3);
  expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe("3");
  acceptOlderApp(db, "script");
  expect(raiseEngineLevel(db, old)).toMatchObject({ level: ENGINE_LEVEL, raised: true, refused: null });
  expect(readEngineLevel(db)).toBe(ENGINE_LEVEL);
  expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe(String(SCHEMA_LEVEL));
  db.close();
});

/**
 * Below the work items' level a plan a new one displaced was parked; from it everything not
 * delivered reads as active (ADR 0040 P4b), so without this every old parked plan would be a place
 * your next line could be filed, and a desk segment with more than one would refuse to act.
 */
test("going up to the work items' level puts old parked plans nobody is on to sleep, and no others", () => {
  const store = new Store();
  try {
    store.db.run("INSERT INTO settings (key, value) VALUES ('engine_level', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const dm = writer.direct_session.id;
    const [old, spoken, working, current] = ["旧片", "刚说过", "还在跑", "当前"].map((title) => store.openTask({ sessionId: dm, title }));
    const long = "2026-01-01T00:00:00.000Z";
    store.db.run("UPDATE tasks SET status = 'parked', closed_at = ? WHERE id IN (?, ?, ?)", [long, old!.id, spoken!.id, working!.id]);
    store.db.run(`INSERT INTO user_quotes (id, session_id, task_id, via, body, created_at) VALUES ('just-now', ?, ?, 'message', '再看看', ?)`,
      [dm, spoken!.id, new Date().toISOString()]);
    const line = store.postMessage(dm, { body: "接着跑" });
    const live = store.createTurn({ sessionId: dm, botId: writer.bot.id, triggerMessageId: line.id, taskId: working!.id });
    expect(store.getTurn(live.id).status).toBe("running");

    raiseEngineLevel(store.db, null);

    expect([old, spoken, working, current].map((plan) => store.getTask(plan!.id).dormant_since !== null)).toEqual([true, false, false, false]);
    expect(store.listWorkEvents({ kind: "plan.dormant" }).map((event) => [event.task_id, event.payload.cause])).toEqual([[old!.id, "legacy_parked"]]);
    // Asleep, it is no candidate for a line; your line filed there wakes it.
    expect(store.planCandidates({ sessionId: dm, botId: writer.bot.id }).map((plan) => plan.id)).not.toContain(old!.id);
    const back = store.postMessage(dm, { body: "旧片也接着做" });
    store.fileMessage(back.id, { explicit: [{ taskId: old!.id }] });
    expect(store.getTask(old!.id).dormant_since).toBeNull();
  } finally {
    store.close();
  }
});

test("an opt-in may stop short of this build's top level: level 5 without level 6's jobs", () => {
  const store = new Store();
  const optIn = store.transaction(() => store.acceptOlderApp("script", ENGINE_LEVELS.submissions));
  expect(optIn.level).toBe(ENGINE_LEVELS.submissions);
  expect(store.raiseEngineLevel(null)).toMatchObject({ level: ENGINE_LEVELS.submissions, raised: true });
  expect(store.capabilities().features).not.toContain("jobs");
  // Asked for past the top, it stops at the top.
  expect(store.transaction(() => store.acceptOlderApp("api", 99)).level).toBe(ENGINE_LEVEL);
  store.close();
});
