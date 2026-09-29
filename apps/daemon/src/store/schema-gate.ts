/**
 * The version gate (ADR 0040): an old binary must never guess at a database a newer one wrote in
 * ways this one does not understand. `SCHEMA_LEVEL` is this build's own rung on that ladder;
 * `schema_min_compatible`, raised only by a migration whose new semantics an older binary would
 * misread (ADR 0040's class B migrations), is the floor a database requires. The gate has to run
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

/** Bumped only alongside a migration that a database written under it would misread. Still 0: ADR 0040 P0 only ships the gate read. */
export const SCHEMA_LEVEL = 0;

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

/** 0 until a later ADR 0040 phase's rollout raises it (only forward, only in order). */
export function readEngineLevel(db: Database): number {
  const raw = readSetting(db, "engine_level");
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
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
