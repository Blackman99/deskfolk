import type { Database } from "bun:sqlite";
import { ENGINE_LEVELS } from "./schema-gate";

export const END_REASON_REQUIRED = "end_reason_required";
const BACKFILLED_KEY = "end_reasons_backfilled";
const TERMINAL = "('completed', 'stopped', 'interrupted', 'redirected')";
const BLANK = "length(trim(COALESCE(NEW.end_reason, ''), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) = 0";

/** I5 is an engine-3 invariant; old writers below that floor keep their existing terminal contract. */
export function migrateEndReasons(db: Database): void {
  db.transaction(() => {
    // Terminal rows already written by an earlier build have no contract to recover beyond status.
    // Import once, never manufacture reasons for subsequent invalid terminal writes on reopen.
    if (!db.query("SELECT 1 FROM settings WHERE key = ?").get(BACKFILLED_KEY)) {
      db.run(`UPDATE turns SET end_reason = status WHERE work_item_id IS NOT NULL AND status IN ${TERMINAL}
        AND length(trim(COALESCE(end_reason, ''), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) = 0`);
      db.run("INSERT INTO settings (key, value) VALUES (?, '1')", [BACKFILLED_KEY]);
    }
    for (const event of ["INSERT", "UPDATE"] as const) {
      const name = `turns_end_reason_${event.toLowerCase()}`;
      db.run(`DROP TRIGGER IF EXISTS ${name}`);
      db.run(`CREATE TRIGGER ${name} BEFORE ${event} ON turns
        WHEN NEW.work_item_id IS NOT NULL AND NEW.status IN ${TERMINAL} AND ${BLANK}
          AND CAST(COALESCE((SELECT value FROM settings WHERE key = 'engine_level'), '0') AS INTEGER) >= ${ENGINE_LEVELS.delegation}
        BEGIN SELECT RAISE(ABORT, '${END_REASON_REQUIRED}'); END`);
    }
  })();
}
