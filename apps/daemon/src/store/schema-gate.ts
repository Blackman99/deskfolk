/**
 * The version gate (ADR 0040): an old binary must never guess at a database a newer one wrote in
 * ways this one does not understand. `SCHEMA_LEVEL` is this build's own rung on that ladder;
 * `schema_min_compatible` is the floor a database requires, raised with the engine level that
 * starts writing what an older binary would misread (ADR 0040's class B semantics; see
 * {@link raiseEngineLevel}), not by the migration that adds the columns. The gate has to run
 * *before* `SCHEMA_SQL` touches the database, not after: `SCHEMA_SQL` does more than add tables and
 * columns (it also creates indexes and seeds rows against tables it assumes still have today's
 * shape), and a database whose floor this build cannot meet may already have dropped a column or
 * table one of those statements depends on — running it first can both write to a database the gate
 * says not to open, and fail with a raw SQLite error instead of the refusal a user is supposed to
 * see. A brand new database has no `settings` table yet, so there is nothing yet to gate on; the
 * caller (`Store`) checks for that table's existence in `sqlite_master` before calling in.
 *
 * `engine_level` and `last_shutdown` live in the same flat `settings` table for the same reason
 * `schema_min_compatible` does: they are read once, at boot, before anything else touches the
 * database.
 */
import type { Database } from "bun:sqlite";
import type { CapabilitiesResponse } from "@real-bot/protocol";

/**
 * Bumped with each engine level that raises the floor, to that floor: what a database at that
 * level holds is what a build below it would misread.
 * - 0: ADR 0040 P0, the gate read alone.
 * - 1: ADR 0040 P2's holds (叫停). A database at engine level 1 can hold a stop that a build
 *   without holds would not honor — it would wake a held Bot, and put a plan the hold parked back
 *   in progress — and check-backs set aside under one, which such a build reads as cancelled and
 *   never brings back. The new check_backs columns and the holds table itself, empty, are nothing
 *   an older build misreads, so the floor goes up with the engine level that starts writing holds
 *   ({@link raiseEngineLevel}), not with the migration that adds them.
 * - 2: ADR 0040 P4b's work items. A database at engine level 2 keeps one live turn per Bot per
 *   plan, which a build without work items would not: it would open a second turn on the same job.
 * - 3: P4c's event waits and explicit delegations. Old binaries treat thread chatter as a wake,
 *   replace waits by conversation, and cannot satisfy the durable end contract safely.
 * - 4: P4c's supervisor (ADR 0045). A database at engine level 4 keeps its call-backs, retries and
 *   restart resumes as supervisor records, a blocked job's question as a durable card waiting on
 *   your answer, and side-effect evidence in `tool_executions`. A level-3 build would run the
 *   retired plan call-back and report-back timers on top of those records (two wakes for one
 *   stall), leave a blocked job with nothing to answer, and resume work without checking whether
 *   its last external call went through.
 * - 5: P4e's submissions and reviews (ADR 0046). A database at engine level 5 keeps each ticket's
 *   stage beside its status, moved only by a submission's checks, a review or the supervisor's
 *   no-reviewer approval, and work handed over waits as a submission for its reviewer. A level-4
 *   build would move the status alone on any file a turn cites (leaving the stage behind it, so
 *   the board and the end contract disagree with what was checked), pass a ticket to review
 *   without running its checks, and never ask the reviewer or approve what nobody reviews.
 */
export const SCHEMA_LEVEL = 5;

/**
 * The engine levels this build runs, in the only order they turn on (ADR 0040: one integer for the
 * whole rollout instead of a switch per feature). `holds`: ADR 0040 P2's control plane;
 * `work_items`: P4b; `delegation`: P4c's delegations and end contract (ADR 0044); `supervision`:
 * P4c's supervisor, durable blocked questions and the effect ledger (ADR 0045); `submissions`:
 * P4e's ticket stages, submissions and reviews (ADR 0046).
 */
export const ENGINE_LEVELS = { holds: 1, work_items: 2, delegation: 3, supervision: 4, submissions: 5 } as const;
export const ENGINE_LEVEL = ENGINE_LEVELS.submissions;

/**
 * The highest level a build raises on its own, with no developer opt-in: `ENGINE_LEVEL` may sit
 * above this while a level is still being shaken out live (ADR 0046's submissions — not yet
 * audited running real jobs). A level above this one is experimental and goes up only through a
 * developer's explicit opt-in for that level ({@link acceptOlderApp}, {@link raiseEngineLevel}),
 * whether or not an older installed app shares the database — a packaged build and a source run on
 * a data folder of its own (`installed === null`) are not exempt.
 */
export const ENGINE_LEVEL_BY_DEFAULT = ENGINE_LEVELS.supervision;

/** The floor a database needs once it runs at each engine level: whatever an older build would misread there. */
const FLOOR_AT_LEVEL: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };

/**
 * The last release without the gate read. A copy of it (or of anything before it) opens any
 * database whatever its floor says, so no level that raises a floor may turn on while one shares
 * this database.
 */
export const LAST_RELEASE_WITHOUT_GATE = "0.1.0-rc.12";

export class SchemaTooNewError extends Error {
  constructor(readonly required: number | "unreadable", readonly supported: number) {
    super(
      required === "unreadable"
        ? `database's schema_min_compatible is not a number this build can read — update the app`
        : `database requires schema level ${required}, this build only supports ${supported} — update the app`,
    );
  }
}

/**
 * The gate's own `settings` rows. They are bookkeeping about the database, not settings anyone
 * edits, so the change journal (`events.ts`) leaves them out: `markCleanShutdown` writes one at the
 * top of every stop, and journalling it would make the next transaction publish a
 * `settings.changed` that changes nothing to every client, in the middle of shutting down.
 * `engine_gate_optin` is a developer's word about the database ({@link acceptOlderApp}), no more a
 * setting than the level it lets go up.
 */
export const GATE_SETTING_KEYS = ["schema_min_compatible", "engine_level", "last_shutdown", "engine_gate_optin"] as const;

function readSetting(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

function writeSetting(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/**
 * Refuses to go on when a newer build already raised the floor past what this one supports. A
 * floor that does not even parse as a number is refused too: a value this build cannot read is a
 * value it does not understand either, and guessing that is safe is exactly the mistake the gate
 * exists to rule out.
 */
export function assertSchemaGate(db: Database): void {
  const raw = readSetting(db, "schema_min_compatible");
  if (raw === null) return;
  const required = Number(raw);
  if (!Number.isFinite(required)) throw new SchemaTooNewError("unreadable", SCHEMA_LEVEL);
  if (required > SCHEMA_LEVEL) throw new SchemaTooNewError(required, SCHEMA_LEVEL);
}

/** 0 until {@link raiseEngineLevel} raises it (only forward, only in order). */
export function readEngineLevel(db: Database): number {
  const raw = readSetting(db, "engine_level");
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

/** `GET /v1/capabilities`: this build's rung, the database's engine level, and the features that level has on. */
export function capabilitiesOf(db: Database): CapabilitiesResponse {
  const level = readEngineLevel(db);
  return {
    schema_level: SCHEMA_LEVEL,
    engine_level: level,
    features: (Object.keys(ENGINE_LEVELS) as Array<keyof typeof ENGINE_LEVELS>).filter((feature) => level >= ENGINE_LEVELS[feature]),
  };
}

/**
 * A developer's word that this database may go up past an installed app older than the gate
 * (ADR 0041): when, and whether it came through the local API (`POST /v1/capabilities/raise`) or
 * `scripts/engine-level.ts` writing it with no daemon running.
 */
export type EngineGateOptIn = {
  at: string;
  by: "api" | "script";
  /** The engine level the developer accepted, which is all it lets past an older app: a later level asks again. */
  level: number;
};

/** The standing opt-in, or null when there is none (or it does not read as one, which counts the same). */
export function readEngineGateOptIn(db: Database): EngineGateOptIn | null {
  const raw = readSetting(db, "engine_gate_optin");
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EngineGateOptIn>;
    if (typeof parsed.at !== "string" || (parsed.by !== "api" && parsed.by !== "script")) return null;
    return { at: parsed.at, by: parsed.by, level: typeof parsed.level === "number" && Number.isInteger(parsed.level) ? parsed.level : 1 };
  } catch {
    return null;
  }
}

/**
 * Records that the engine level may go up although an installed app that shares this data folder
 * predates the gate, or its version cannot be read: on a developer's own machine, running a source
 * build on the data folder they use every day, holds (and the levels after them) would otherwise
 * stay off until a release with the gate is installed. The cost is theirs to accept: that app, opened
 * without this daemon running, would not honor a hold. It only lets {@link raiseEngineLevel} past
 * that app; it raises nothing itself.
 */
export function acceptOlderApp(db: Database, by: EngineGateOptIn["by"], at: string = new Date().toISOString()): EngineGateOptIn {
  const optIn = { at, by, level: ENGINE_LEVEL };
  writeSetting(db, "engine_gate_optin", JSON.stringify(optIn));
  return optIn;
}

/**
 * Takes the opt-in back. The level stays where it is — it only ever goes forward, and a database
 * already written at a level is read at that level whatever lets the next one go up — so this only
 * means an older installed app holds back the next level a later build brings.
 */
export function withdrawOlderAppOptIn(db: Database): void {
  db.run("DELETE FROM settings WHERE key = 'engine_gate_optin'");
}

/**
 * An installed app that shares this database, as far as the daemon can tell: the version its
 * bundle gives (empty when that could not be read), or, where there is no telling what is
 * installed, why not — for the log.
 */
export type SharedInstall = { version: string } | { unseen: string };

export type EngineLevelRaise = {
  /** Where the database stands afterwards. */
  level: number;
  raised: boolean;
  /** Why it stayed below {@link ENGINE_LEVEL}: an older app that shares this database. Null when nothing held it back. */
  refused: string | null;
  /** What let it past such an app: the developer's opt-in ({@link acceptOlderApp}), for the log. Null when it was not needed. */
  accepted: string | null;
};

/** How a developer lets the level past an older installed app, named in the refusal so the log says what to do. */
const ACCEPT_HINT = "or, developing on this data folder, accept that with `bun apps/daemon/scripts/engine-level.ts --accept-older-app`";

/**
 * Takes the database up to this build's engine level, a level at a time, raising the floor each
 * level needs in the same write. It turns a level on only when nothing that could open this
 * database afterwards would misread it (ADR 0040's two conditions): this build reads the gate, so
 * the one thing left to rule out is an installed app that does not, or does but predates the
 * level, and would open the same data folder — the app and a source run share it. `installed` is
 * that app: null when no installed app shares the database (a packaged daemon is the installed
 * app; a source run on a data folder of its own has none). One whose version could not be read,
 * or that there is no telling about, counts as too old. An app that has the gate but not the level
 * refuses the database once the floor goes up and says to update, which is the gate doing its
 * job; one from before the gate would not, so that is the case refused here — unless a developer
 * accepted that for this database ({@link acceptOlderApp}, ADR 0041).
 *
 * Above {@link ENGINE_LEVEL_BY_DEFAULT}, a level is experimental and never turns on by itself: with
 * no compatibility concern (no installed app, or one that reads the gate itself) the ceiling is
 * `min(ENGINE_LEVEL, max(ENGINE_LEVEL_BY_DEFAULT, optIn?.level ?? 0))` — an opt-in only ever raises
 * that ceiling, never pulls it below the default, so a stale or low opt-in left over from an
 * earlier build (back when `ENGINE_LEVEL` was lower, or an opt-in with no `level` at all) cannot
 * hold a fresh database below where it would otherwise land. `acceptOlderApp` always records the
 * opt-in for this build's own `ENGINE_LEVEL`, so accepting on this build reaches it exactly. On the
 * one path where an installed app actually predates the gate, the ceiling is `min(ENGINE_LEVEL,
 * optIn.level)` instead — exactly the level a developer accepted past that specific app, since
 * nothing says a higher one would be safe past it too.
 */
export function raiseEngineLevel(db: Database, installed: SharedInstall | null): EngineLevelRaise {
  const from = readEngineLevel(db);
  if (from >= ENGINE_LEVEL) return { level: from, raised: false, refused: null, accepted: null };
  const optIn = readEngineGateOptIn(db);
  let accepted: string | null = null;
  let target: number = Math.min(ENGINE_LEVEL, Math.max(ENGINE_LEVEL_BY_DEFAULT, optIn?.level ?? 0));
  if (installed !== null && !("version" in installed && newerThan(installed.version, LAST_RELEASE_WITHOUT_GATE))) {
    if (optIn === null) {
      const why =
        "version" in installed
          ? `the installed app (${installed.version || "version unreadable"}) does not read the version gate — update it to a release after ${LAST_RELEASE_WITHOUT_GATE} first, ${ACCEPT_HINT}`
          : `${installed.unseen}, and one from before the version gate would open this data folder anyway — set REAL_BOT_DATA_DIR to a folder of its own to let it go up, ${ACCEPT_HINT}`;
      return { level: from, raised: false, refused: `engine level stays at ${from}: ${why}`, accepted: null };
    }
    if (optIn.level <= from) {
      return {
        level: from,
        raised: false,
        refused: `engine level stays at ${from}: the developer's opt-in past an older installed app covers level ${optIn.level}, and this build brings ${ENGINE_LEVEL} — accept again for it, ${ACCEPT_HINT.replace(/^or, /, "")}`,
        accepted: null,
      };
    }
    target = Math.min(ENGINE_LEVEL, optIn.level);
    const past =
      "version" in installed
        ? `the installed app (${installed.version || "version unreadable"}), which does not read the version gate`
        : `whatever app is installed (${installed.unseen})`;
    accepted = `engine level ${from} → ${target} past ${past}: a developer accepted that for this data folder (${optIn.by}, ${optIn.at}); an app from before the gate, opened without this daemon running, would not honor holds`;
  }
  if (target <= from) return { level: from, raised: false, refused: null, accepted: null };
  db.transaction(() => {
    let floor = Number(readSetting(db, "schema_min_compatible") ?? 0);
    for (let level = from + 1; level <= target; level += 1) {
      floor = Math.max(Number.isFinite(floor) ? floor : 0, FLOOR_AT_LEVEL[level] ?? 0);
      writeSetting(db, "engine_level", String(level));
    }
    if (floor > 0) writeSetting(db, "schema_min_compatible", String(floor));
    const at = new Date().toISOString();
    if (from < ENGINE_LEVELS.work_items && target >= ENGINE_LEVELS.work_items) sleepLegacyParkedPlans(db, at);
    // When it went up, in the work log: the supervisor watches work from its own level's raise on,
    // and leaves what was already quiet before it (ADR 0045). A bare settings table has no log.
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_events'").get()) {
      db.run("INSERT INTO work_events (at, kind, actor, payload) VALUES (?, 'engine.level_raised', 'app', ?)",
        [at, JSON.stringify({ from, to: target })]);
    }
  })();
  return { level: target, raised: true, refused: null, accepted };
}

/**
 * Below the work items' level a conversation had one current plan, and the one a new plan displaced
 * was parked (`status = 'parked'`). From it every plan not delivered reads as active (ADR 0040 P4b),
 * so those old parked plans would all become places a line of yours is filed, and a desk segment
 * with more than one to choose from refuses to act. Going up to it, a parked plan nobody is working
 * on and you have not spoken about for two hours goes dormant (§2.6), as it would have had dormancy
 * existed when it was parked; your next line filed there, or its Continue, wakes it.
 */
function sleepLegacyParkedPlans(db: Database, at: string): void {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')").all().map((row) => row.name));
  if (!["status", "stage", "dormant_since", "routine_id", "closed_at"].every((column) => columns.has(column))) return;
  const quotes = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_quotes'").get() !== null;
  const recent = new Date(Date.parse(at) - 2 * 60 * 60 * 1000).toISOString();
  const asleep = db.query<{ id: string; session_id: string | null }, [string, string]>(`UPDATE tasks SET dormant_since = ?1, closed_at = COALESCE(closed_at, ?1)
    WHERE status = 'parked' AND stage IS NULL AND dormant_since IS NULL AND routine_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.task_id = tasks.id AND t.status IN ('running', 'waiting_approval', 'waiting_ask'))
      ${quotes ? "AND NOT EXISTS (SELECT 1 FROM user_quotes q WHERE q.task_id = tasks.id AND q.created_at > ?2)" : "AND ?2 IS NOT NULL"}
    RETURNING id, session_id`).all(at, recent);
  if (asleep.length === 0 || !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_events'").get()) return;
  for (const plan of asleep) {
    db.run("INSERT INTO work_events (at, kind, actor, task_id, session_id, payload) VALUES (?, 'plan.dormant', 'app', ?, ?, ?)",
      [at, plan.id, plan.session_id, JSON.stringify({ cause: "legacy_parked" })]);
  }
}

function newerThan(version: string, than: string): boolean {
  try {
    return Bun.semver.order(version, than) > 0;
  } catch {
    // Not a version this build can compare: assume the worst, as the gate does with an unreadable floor.
    return false;
  }
}

/**
 * Reads how the previous run ended, then overwrites the flag to `crash` for this one: every boot
 * assumes the worst until `markCleanShutdown` proves otherwise before exiting. A database that has
 * never recorded a shutdown — the very first boot — reads as `clean`, since there is nothing yet
 * to blame it for.
 */
export function readAndResetShutdownFlag(db: Database): "clean" | "crash" {
  const previous = readSetting(db, "last_shutdown");
  writeSetting(db, "last_shutdown", "crash");
  return previous === "crash" ? "crash" : "clean";
}

/**
 * Called once, on the way out of a deliberate stop (quit, remote stop/restart, SIGINT/SIGTERM) —
 * never on a crash. "Clean" names *why* the process is ending, not *how far* it got: an ordinary
 * quit still aborts whatever turns were running before this is reached ("stopped after the
 * running work drained" is a different, stronger condition this flag does not claim). A reader that
 * needs to know whether work was actually drained, not just deliberately stopped — to decide how to
 * resume after a restart, say — needs a different signal.
 */
export function markCleanShutdown(db: Database): void {
  writeSetting(db, "last_shutdown", "clean");
}
