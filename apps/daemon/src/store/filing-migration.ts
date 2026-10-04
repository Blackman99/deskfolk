import type { Database } from "bun:sqlite";
import { isoNow } from "../ids";

/** Only nullable/new columns: old CHECKs and ordinary field mappings remain unchanged (ADR 0040). */
export function migrateFiling(db: Database, now: string = isoNow()): void {
  const add = (table: string, definitions: Array<[string, string]>) => {
    const names = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const [name, definition] of definitions) {
      if (!names.includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  add("messages", [
    ["filing_state", "TEXT CHECK (filing_state IS NULL OR filing_state IN ('filed', 'undetermined', 'none'))"],
    ["filing_candidates", "TEXT"],
    ["filing_reading", "TEXT"],
  ]);
  add("tasks", [
    ["stage", "TEXT CHECK (stage IS NULL OR stage IN ('active', 'delivered', 'accepted', 'abandoned'))"],
    ["delivered_at", "TEXT"],
    ["lead_bot_id", "TEXT"],
  ]);
  add("bots", [["parallel_limit", "INTEGER DEFAULT 2"]]);
  add("work_items", [["thread_session_id", "TEXT"]]);
  add("turns", [["filing_candidates", "TEXT"], ["filing_bounces", "INTEGER NOT NULL DEFAULT 0"], ["work_dir_changes", "INTEGER NOT NULL DEFAULT 0"], ["end_reason", "TEXT"]]);
  db.run('CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id)');
  db.run('CREATE INDEX IF NOT EXISTS attachments_path_message ON attachments (workspace_relpath, message_id)');
  db.run('CREATE INDEX IF NOT EXISTS ticket_parts_artifact ON ticket_parts (ticket_id, current_artifact)');
  db.run('CREATE INDEX IF NOT EXISTS work_events_task_at ON work_events (task_id, at)');
  db.run('CREATE INDEX IF NOT EXISTS turns_bot_recent ON turns (bot_id, last_activity_at, task_id)');
  db.run('CREATE INDEX IF NOT EXISTS work_items_bot_state ON work_items (bot_id, state, task_id)');
  db.run('CREATE INDEX IF NOT EXISTS work_items_task_state ON work_items (task_id, state)');
  db.run('CREATE INDEX IF NOT EXISTS session_participants_member ON session_participants (member, left_at, session_id)');
  // SCHEMA_SQL creates message_filings before this catches up old columns. Import each legacy
  // message only once; a deliberately undetermined new filing must not regain its old default.
  db.transaction(() => {
    db.run(`INSERT OR IGNORE INTO message_filings (message_id, task_id, ticket_id, part_key, filed_by, strength, is_primary, created_at)
      SELECT id, task_id, ticket_id, NULL, 'legacy', 'default', 1, created_at FROM messages
      WHERE filing_state IS NULL AND task_id IS NOT NULL`);
    db.run(`UPDATE messages SET filing_state = CASE WHEN task_id IS NOT NULL THEN 'filed'
      WHEN kind = 'user' THEN 'undetermined' ELSE 'none' END WHERE filing_state IS NULL`);
    db.run(`INSERT OR IGNORE INTO user_quote_filings (quote_id, task_id, ticket_id, part_key)
      SELECT q.id, f.task_id, f.ticket_id, f.part_key FROM message_filings f JOIN user_quotes q ON q.message_id = f.message_id`);
    db.run(`INSERT OR IGNORE INTO user_quote_filings (quote_id, task_id, ticket_id, part_key)
      SELECT id, task_id, ticket_id, part_key FROM user_quotes WHERE task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_quote_filings f WHERE f.quote_id = user_quotes.id)`);
    const cutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    // Only the old done rows, once. This does not reinterpret active/parked or their old CHECKs.
    db.run(`UPDATE tasks SET stage = 'delivered', delivered_at = COALESCE(delivered_at, closed_at, spec_updated_at, created_at),
      dormant_since = CASE WHEN COALESCE((SELECT MAX(created_at) FROM user_quotes WHERE task_id = tasks.id), tasks.created_at) <= ?1
        THEN COALESCE(dormant_since, ?2) ELSE dormant_since END,
      closed_at = CASE WHEN COALESCE((SELECT MAX(created_at) FROM user_quotes WHERE task_id = tasks.id), tasks.created_at) <= ?1
        THEN COALESCE(closed_at, ?2) ELSE closed_at END
      WHERE status = 'done' AND stage IS NULL AND routine_id IS NULL`, [cutoff, now]);
  })();
}
