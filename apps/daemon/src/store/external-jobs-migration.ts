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
