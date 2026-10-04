import type { Database } from "bun:sqlite";

/**
 * Large jobs (大活, ADR 0060), additive: on a plan, whether it is one to lay out before making
 * anything (`scale` 'large', or 'single' once you said it is not) with who said so (`scale_by`:
 * reader, signal, user), when, the words or facts it stands on (`scale_why`) and what one unit of it
 * is (`scale_unit`, 「一场」「一章」); on a ticket, whether it is the job's sample (`sample`), the one
 * made first to the full standard, which the rest wait for; on a check, the sample ticket a
 * standard check (照样片) compares the ticket's hand-over with (`standard_of`). An older build never
 * reads them: a large job is an ordinary plan there, a sample an ordinary ticket, and a standard
 * check a seams check with no deliverable named, which reads as not run and holds nothing.
 */
export function migrateLargeJobs(db: Database): void {
  const taskColumns = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all().map((column) => column.name);
  if (!taskColumns.includes("scale")) db.run("ALTER TABLE tasks ADD COLUMN scale TEXT CHECK (scale IS NULL OR scale IN ('large', 'single'))");
  for (const column of ["scale_by", "scale_at", "scale_why", "scale_unit"]) {
    if (!taskColumns.includes(column)) db.run(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
  }
  const ticketColumns = db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (!ticketColumns.includes("sample")) db.run("ALTER TABLE tickets ADD COLUMN sample INTEGER NOT NULL DEFAULT 0");
  const checkColumns = db.query<{ name: string }, []>("PRAGMA table_info(acceptance_checks)").all().map((column) => column.name);
  if (!checkColumns.includes("standard_of")) db.run("ALTER TABLE acceptance_checks ADD COLUMN standard_of TEXT");
}
