import type { Database } from "bun:sqlite";

/**
 * The built-in calls' own models (ADR 0077), once: the organizing model you chose (ADR 0075) ran the
 * organizer, the scribe and the picture checks, which now each have a choice of their own. The
 * scribe and the picture checks start on that same model, so nothing runs elsewhere than before.
 */
export function migrateBuiltinModels(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM settings WHERE key = 'builtin_models_split'").get()) return;
    for (const role of ["scribe", "judge"]) {
      for (const field of ["provider_id", "model"]) {
        db.run(
          `INSERT OR IGNORE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = ? AND value <> ''`,
          [`${role}_${field}`, `organizer_${field}`],
        );
      }
    }
    db.run("INSERT INTO settings (key, value) VALUES ('builtin_models_split', '1')");
  })();
}
