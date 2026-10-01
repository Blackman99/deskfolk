import type { Database } from "bun:sqlite";

/** Durable hand-offs outlive transcript clearing; their identities deliberately have no cascading FKs. */
export const DELEGATIONS_SQL = `
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  ticket_id TEXT,
  part_keys TEXT NOT NULL DEFAULT '[]',
  from_work_item_id TEXT NOT NULL,
  from_turn_id TEXT,
  to_bot_id TEXT NOT NULL,
  to_work_item_id TEXT NOT NULL,
  thread_session_id TEXT NOT NULL,
  ask TEXT NOT NULL,
  expects TEXT NOT NULL CHECK (expects IN ('deliverable', 'review', 'answer')),
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'cancelled')),
  reply_ref TEXT,
  request_inbox_seq INTEGER,
  result_inbox_seq INTEGER,
  due_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delegations_from_work ON delegations (from_work_item_id, status);
CREATE INDEX IF NOT EXISTS delegations_to_work ON delegations (to_work_item_id, status);
CREATE INDEX IF NOT EXISTS delegations_thread ON delegations (thread_session_id, created_at);
`;

/** Additive only: neither session types nor existing kind/state CHECKs are rebuilt. */
export function migrateDelegations(db: Database): void {
  for (const [table, definitions] of [
    ["sessions", [["thread_task_id", "TEXT"]]],
    ["work_items", [["waiting_on", "TEXT"], ["delegated_by", "TEXT"]]],
    ["check_backs", [["work_item_id", "TEXT"]]],
    ["inbox_items", [["source_turn_id", "TEXT"]]],
  ] as const) {
    const names = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const [name, definition] of definitions) {
      if (!names.includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(DELEGATIONS_SQL);
  const delegationColumns = db.query<{ name: string }, []>("PRAGMA table_info(delegations)").all().map((row) => row.name);
  if (!delegationColumns.includes("request_inbox_seq")) db.run("ALTER TABLE delegations ADD COLUMN request_inbox_seq INTEGER");
  if (!delegationColumns.includes("from_turn_id")) db.run("ALTER TABLE delegations ADD COLUMN from_turn_id TEXT");
  db.run("CREATE INDEX IF NOT EXISTS sessions_thread_task ON sessions (thread_task_id) WHERE thread_task_id IS NOT NULL");
  // Legacy clock claimers cannot consume a real event wait, even if they are handed its id.
  // The reply/cancel writer satisfies it by setting voided_at, never by claiming a timer.
  db.run(`CREATE TRIGGER IF NOT EXISTS delegation_wait_not_a_timer BEFORE UPDATE OF fired_at ON check_backs
    WHEN OLD.kind = 'delegation_wait' AND OLD.fired_at IS NULL AND NEW.fired_at IS NOT NULL
    BEGIN SELECT RAISE(IGNORE); END`);
}
