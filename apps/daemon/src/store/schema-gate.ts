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
 */
export const SCHEMA_LEVEL = 1;

/**
 * The engine levels this build runs, in the only order they turn on (ADR 0040: one integer for the
 * whole rollout instead of a switch per feature). `holds`: ADR 0040 P2's control plane.
 */
export const ENGINE_LEVELS = { holds: 1 } as const;
export const ENGINE_LEVEL = ENGINE_LEVELS.holds;

/** The floor a database needs once it runs at each engine level: whatever an older build would misread there. */
const FLOOR_AT_LEVEL: Readonly<Record<number, number>> = { 1: 1 };

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
 */
export const GATE_SETTING_KEYS = ["schema_min_compatible", "engine_level", "last_shutdown"] as const;

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
};

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
 * job; one from before the gate would not, so that is the case refused here.
 */
export function raiseEngineLevel(db: Database, installed: SharedInstall | null): EngineLevelRaise {
  const from = readEngineLevel(db);
  if (from >= ENGINE_LEVEL) return { level: from, raised: false, refused: null };
  if (installed !== null && !("version" in installed && newerThan(installed.version, LAST_RELEASE_WITHOUT_GATE))) {
    const why =
      "version" in installed
        ? `the installed app (${installed.version || "version unreadable"}) does not read the version gate — update it to a release after ${LAST_RELEASE_WITHOUT_GATE} first`
        : `${installed.unseen}, and one from before the version gate would open this data folder anyway — set REAL_BOT_DATA_DIR to a folder of its own to let it go up`;
    return { level: from, raised: false, refused: `engine level stays at ${from}: ${why}` };
  }
  db.transaction(() => {
    let floor = Number(readSetting(db, "schema_min_compatible") ?? 0);
    for (let level = from + 1; level <= ENGINE_LEVEL; level += 1) {
      floor = Math.max(Number.isFinite(floor) ? floor : 0, FLOOR_AT_LEVEL[level] ?? 0);
      writeSetting(db, "engine_level", String(level));
    }
    if (floor > 0) writeSetting(db, "schema_min_compatible", String(floor));
  })();
  return { level: ENGINE_LEVEL, raised: true, refused: null };
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
