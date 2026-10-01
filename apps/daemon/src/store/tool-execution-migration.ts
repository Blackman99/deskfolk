import type { Database } from "bun:sqlite";

/** Additive, durable effect evidence. Clearing a transcript must not erase an uncertain call. */
export const TOOL_EXECUTIONS_SQL = `
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  task_id TEXT,
  ticket_id TEXT,
  bot_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  side_effect INTEGER NOT NULL CHECK (side_effect IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IN ('succeeded', 'refused', 'failed', 'unknown')),
  error_code TEXT,
  UNIQUE (turn_id, tool_call_id),
  CHECK ((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tool_executions_work ON tool_executions (work_item_id, started_at);
CREATE INDEX IF NOT EXISTS tool_executions_pending ON tool_executions (turn_id) WHERE finished_at IS NULL;
`;

export function migrateToolExecutions(db: Database): void {
  db.exec(TOOL_EXECUTIONS_SQL);
}
