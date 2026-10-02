import type { Database } from "bun:sqlite";

/** The columns of `external_jobs` (ADR 0040 P4d) that this build's readers use, when the table exists. */
export const EXTERNAL_JOBS_READ_COLUMNS = ["id", "task_id", "state"] as const;

/** Whether `external_jobs` is there with every column a reader here needs (only a table, not its name, says so). */
export function externalJobsReadable(db: Database): boolean {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('external_jobs')").all().map((row) => row.name));
  return EXTERNAL_JOBS_READ_COLUMNS.every((column) => columns.has(column));
}

/**
 * No build creates `external_jobs` yet (P4d brings it), but an abandoned draft left one behind in at
 * least one database: `id, request_id, args_digest, status, created_at, updated_at`, without the
 * `task_id` and `state` that plan dormancy reads, so every line of yours filed at engine level 2 or
 * above failed on it. A table of that name without those columns is set aside before anything reads
 * it: dropped when it holds nothing, renamed `external_jobs_draft_<time>` when it holds rows, so
 * nothing in it is lost and the name is free for P4d's table.
 */
export function migrateStrayExternalJobs(db: Database, now: string = new Date().toISOString()): void {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_jobs'").get();
  if (!exists || externalJobsReadable(db)) return;
  const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM external_jobs").get()!.n;
  if (rows === 0) {
    db.run("DROP TABLE external_jobs");
    return;
  }
  const stamp = now.replace(/\D/g, "").slice(0, 14);
  let name = `external_jobs_draft_${stamp}`;
  for (let n = 2; db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name); n += 1) name = `external_jobs_draft_${stamp}_${n}`;
  db.run(`ALTER TABLE external_jobs RENAME TO "${name}"`);
}

/**
 * External jobs (ADR 0047, engine level 6): one row per render a media server accepted, polled by the
 * daemon for everyone waiting on it. Additive; made after a draft's table of the same name is set
 * aside, so it is always this build's. `task_id` and `state` are what plan dormancy reads.
 */
export const EXTERNAL_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS external_jobs (
  id TEXT PRIMARY KEY,
  -- The MCP server, and the model-facing names of its submit and check tools.
  server TEXT NOT NULL,
  submit_tool TEXT NOT NULL,
  check_tool TEXT NOT NULL,
  -- The check tool's argument the server's id goes in (job_id, request_id, …).
  id_param TEXT NOT NULL,
  request_id TEXT NOT NULL,
  -- What makes two submits the same job: server, tool and arguments.
  args_digest TEXT NOT NULL,
  task_id TEXT,
  ticket_id TEXT,
  -- The part (shot) number the submit was about, read from its prompt when it names exactly one.
  part_no INTEGER,
  bot_id TEXT NOT NULL,
  work_item_id TEXT,
  turn_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'lost')),
  status_text TEXT,
  result TEXT,
  -- Why a part that already had a job was submitted again.
  resubmit_reason TEXT,
  -- Who is woken when it is done (JSON [{bot_id, work_item_id, session_id}]): the submitter and anyone who checked on it.
  waiters TEXT NOT NULL DEFAULT '[]',
  polls INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT NOT NULL,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (server, request_id)
);
CREATE INDEX IF NOT EXISTS external_jobs_digest ON external_jobs (args_digest, created_at);
CREATE INDEX IF NOT EXISTS external_jobs_due ON external_jobs (state, next_poll_at);
CREATE INDEX IF NOT EXISTS external_jobs_part ON external_jobs (ticket_id, part_no, created_at);
`;

export function migrateExternalJobs(db: Database): void {
  db.exec(EXTERNAL_JOBS_SQL);
}

