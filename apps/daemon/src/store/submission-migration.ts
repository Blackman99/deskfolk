import type { Database } from "bun:sqlite";

/**
 * Submissions (ADR 0046): one row per hand-over of a ticket's work, explicit (`submit`) or implicit
 * (cited new files at a segment's end), with the artifacts by content hash, the checks the app ran
 * on it and the reviews it got. Additive: an older build neither reads nor writes it.
 */
export const SUBMISSIONS_SQL = `
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  task_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  part_keys TEXT NOT NULL DEFAULT '[]',
  bot_id TEXT NOT NULL,
  -- The model the producing segment ran on, kept here so a review's "same model" survives a cleared transcript.
  model TEXT,
  turn_id TEXT,
  -- 'submit' / 'implicit': files; 'answer': words handed over in place of a file (a ticket whose work is
  -- an answer); 'organizer': the organizer read a ticket nothing was ever handed over on as done.
  origin TEXT NOT NULL CHECK (origin IN ('submit', 'implicit', 'answer', 'organizer')),
  artifacts TEXT NOT NULL,
  -- The words handed over, for an 'answer'.
  content TEXT,
  claims TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  state TEXT NOT NULL CHECK (state IN ('checking', 'checks_failed', 'submitted', 'in_review', 'approved', 'rejected', 'superseded')),
  checks TEXT NOT NULL DEFAULT '[]',
  reviews TEXT NOT NULL DEFAULT '[]',
  -- An approval waiting on you (JSON: the required items nothing backs, the card asking you, the review it would complete); null otherwise.
  awaiting TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_ticket ON submissions (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS submissions_open ON submissions (task_id, state);
`;

/**
 * A ticket's stage follows your board edit of its status: the stage that status reads as. Only a
 * ticket that has a stage (from engine level 5 on) is touched; a write that sets both, as every
 * stage move does, already agrees and fires nothing. From level 5 the organizer no longer writes the
 * status of a ticket it did not just open, so your edits are the one writer this serves.
 */
export const SUBMISSION_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "tickets_stage_follows_status",
    sql: `CREATE TRIGGER tickets_stage_follows_status AFTER UPDATE OF status ON tickets
      WHEN NEW.stage IS NOT NULL AND NEW.status IS NOT (CASE NEW.stage WHEN 'todo' THEN 'todo' WHEN 'doing' THEN 'doing'
        WHEN 'submitted' THEN 'review' WHEN 'in_review' THEN 'review' WHEN 'rework' THEN 'doing' WHEN 'approved' THEN 'done'
        ELSE 'parked' END)
      BEGIN UPDATE tickets SET stage = CASE NEW.status WHEN 'todo' THEN 'todo' WHEN 'doing' THEN 'doing' WHEN 'review' THEN 'submitted'
        WHEN 'done' THEN 'approved' ELSE 'dropped' END WHERE id = NEW.id; END`,
  },
];

/**
 * The ticket's stage beside its old status (§2.3: the old column is still written, mapped), and the
 * Bot that reviews it. Both nullable: a null stage reads as the one its status maps to.
 */
export function migrateSubmissions(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (!columns.includes("stage")) {
    db.run(`ALTER TABLE tickets ADD COLUMN stage TEXT CHECK (stage IS NULL OR stage IN
      ('todo', 'doing', 'submitted', 'in_review', 'rework', 'approved', 'dropped'))`);
  }
  if (!columns.includes("reviewer_bot_id")) db.run("ALTER TABLE tickets ADD COLUMN reviewer_bot_id TEXT");
  db.exec(SUBMISSIONS_SQL);
  const kept = db.query<{ name: string }, []>("PRAGMA table_info(submissions)").all().map((column) => column.name);
  if (!kept.includes("awaiting")) db.run("ALTER TABLE submissions ADD COLUMN awaiting TEXT");
  if (!kept.includes("content")) db.run("ALTER TABLE submissions ADD COLUMN content TEXT");
}
