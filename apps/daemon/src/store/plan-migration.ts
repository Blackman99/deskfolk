/** Schema catch-up for plans and tasks: briefs, plan columns, acceptance and derived checks, requirements, and tasks without a session. */
import type { Database } from "bun:sqlite";

/**
 * A job keeps the request that opened it, so every later turn — after a handoff, in another
 * session, forty lines on — can still read what was asked. Jobs from before the column carry the
 * body of the message that opened their first turn, which is the same text the runtime stores now.
 * Runs after the task backfill so the jobs that pass invents get one too.
 */
export function migrateTaskBriefs(db: Database): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((row) => row.name);
  if (!cols.includes("brief")) db.run(`ALTER TABLE tasks ADD COLUMN brief TEXT`);
  // Always, not only when the column was just added: a database from before work dirs gets its
  // `tasks` table from `SCHEMA_SQL` with the column already there, and its backfilled jobs empty.
  db.run(
    `UPDATE tasks SET brief = (
       SELECT m.body FROM turns t JOIN messages m ON m.id = t.trigger_message_id
       WHERE t.task_id = tasks.id ORDER BY t.created_at ASC, t.id ASC LIMIT 1
     ) WHERE brief IS NULL`,
  );
}

/**
 * A job became a plan: it carries a spec the organizer maintains, a kind, a status, and tickets
 * with their own folders. Old jobs keep their dated dirs and get no tickets; a closed one reads
 * as done, which a resume flips back to active. The columns and tables are added one by one so a
 * database that stopped halfway through catches up on the next open.
 */
export function migratePlans(db: Database): void {
  const cols = () =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
      .all()
      .map((row) => row.name);
  const before = cols();
  if (!before.includes("kind")) db.run(`ALTER TABLE tasks ADD COLUMN kind TEXT`);
  if (!before.includes("spec")) db.run(`ALTER TABLE tasks ADD COLUMN spec TEXT`);
  if (!before.includes("status")) db.run(`ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  // A plan closed before plans had a status — or one the work-dir backfill just closed on the
  // way here — reads as done. The runtime never leaves a closed plan active without a spec.
  db.run(`UPDATE tasks SET status = 'done' WHERE closed_at IS NOT NULL AND status = 'active' AND spec IS NULL`);
  if (!before.includes("spec_updated_at")) db.run(`ALTER TABLE tasks ADD COLUMN spec_updated_at TEXT`);
  if (!before.includes("routine_id")) {
    db.run(`ALTER TABLE tasks ADD COLUMN routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL`);
  }
  // ADR 0040 P3: a plan set aside rather than ended. Plans closed before it stay merely closed.
  if (!before.includes("dormant_since")) db.run(`ALTER TABLE tasks ADD COLUMN dormant_since TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS tasks_routine ON tasks (routine_id)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id),
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      dir TEXT NOT NULL UNIQUE,
      spec TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'review', 'done', 'parked')),
      worker TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (task_id, seq)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS tickets_task_status ON tickets (task_id, status, seq)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS task_spec_revisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id),
      revision INTEGER NOT NULL,
      spec TEXT NOT NULL,
      tickets_snapshot TEXT NOT NULL,
      source_message_id TEXT,
      source_turn_id TEXT,
      actor TEXT NOT NULL CHECK (actor IN ('app', 'user')),
      created_at TEXT NOT NULL,
      UNIQUE (task_id, revision)
    )
  `);
  // ADR 0040 P2: a version a hold wrote when it parked or restored the plan, which files nothing.
  const revisionCols = db.query<{ name: string }, []>(`PRAGMA table_info(task_spec_revisions)`).all().map((row) => row.name);
  if (!revisionCols.includes("cause")) db.run(`ALTER TABLE task_spec_revisions ADD COLUMN cause TEXT CHECK (cause IS NULL OR cause IN ('hold'))`);
  const turnCols = db.query<{ name: string }, []>(`PRAGMA table_info(turns)`).all().map((row) => row.name);
  if (!turnCols.includes("ticket_id")) db.run(`ALTER TABLE turns ADD COLUMN ticket_id TEXT REFERENCES tickets (id)`);
  db.run(`CREATE INDEX IF NOT EXISTS turns_ticket ON turns (ticket_id, last_activity_at)`);
  const messageCols = db.query<{ name: string }, []>(`PRAGMA table_info(messages)`).all().map((row) => row.name);
  if (!messageCols.includes("ticket_id")) db.run(`ALTER TABLE messages ADD COLUMN ticket_id TEXT REFERENCES tickets (id)`);
  db.run(`CREATE INDEX IF NOT EXISTS messages_ticket ON messages (ticket_id, created_at)`);
  // A database from before check-backs has no table yet; the schema creates it with the column.
  const checkBackCols = db.query<{ name: string }, []>(`PRAGMA table_info(check_backs)`).all().map((row) => row.name);
  if (checkBackCols.length > 0 && !checkBackCols.includes("ticket_id")) db.run(`ALTER TABLE check_backs ADD COLUMN ticket_id TEXT`);
  // The line a check-back woke its Bot with is hidden from the conversation by this column. Ones
  // already fired are found by what the line says: the Bot's own note, in that session, after it.
  if (checkBackCols.length > 0 && !checkBackCols.includes("message_id")) {
    db.run(`ALTER TABLE check_backs ADD COLUMN message_id TEXT`);
    db.run(
      `UPDATE check_backs SET message_id = (
         SELECT m.id FROM messages m
         WHERE m.session_id = check_backs.session_id AND m.author = check_backs.bot_id AND m.kind = 'system'
           AND m.body IN ('回看：' || check_backs.note, 'Check-back: ' || check_backs.note)
           AND m.created_at >= check_backs.created_at
         ORDER BY m.created_at ASC, m.id ASC LIMIT 1
       )
       WHERE fired_at IS NOT NULL`,
    );
  }
  if (checkBackCols.length > 0 && !checkBackCols.includes("kind")) db.run(`ALTER TABLE check_backs ADD COLUMN kind TEXT`);
  // The wait columns of ADR 0040 P2, all empty on the rows that predate them: a pending one keeps
  // its (Bot, session) replacement through bot_id and session_id, which is what dedupe_key says.
  for (const [column, type] of [
    ["cause", "TEXT"],
    ["wait_spec", "TEXT"],
    ["suspended_at", "TEXT"],
    ["dedupe_key", "TEXT"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (checkBackCols.length > 0 && !checkBackCols.includes(column)) db.run(`ALTER TABLE check_backs ADD COLUMN ${column} ${type}`);
  }
}

/**
 * `acceptance_checks.kind` gained `continuity` (a vision model comparing the frame before and
 * after every cut of a multi-shot video). Its CHECK is a fixed `IN (...)` list, which SQLite
 * cannot widen with `ALTER TABLE`, so the table is rebuilt following SQLite's own 12-step
 * procedure for changing a table's schema in ways `ALTER TABLE` cannot: foreign keys off before
 * the transaction (so dropping the old table does not cascade-delete `acceptance_check_runs`,
 * which references it `ON DELETE CASCADE`), copy every row into a same-named replacement inside
 * one transaction, recreate the index, `PRAGMA foreign_key_check` before committing, foreign keys
 * back on after. `acceptance_check_runs` itself is never touched — it is not part of what
 * changed, and it keeps referencing `acceptance_checks` by name across the rename.
 */
export function migrateAcceptanceCheckKinds(db: Database): void {
  const shape = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'acceptance_checks'`).get()?.sql ?? "";
  if (!shape || shape.includes("'continuity'")) return;
  db.run(`PRAGMA foreign_keys = OFF`);
  try {
    db.transaction(() => {
      db.run(`
        CREATE TABLE acceptance_checks_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
          ticket_id TEXT REFERENCES tickets (id) ON DELETE SET NULL,
          item TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('exists', 'contains', 'matches', 'command', 'continuity')),
          path TEXT,
          pattern TEXT,
          negate INTEGER NOT NULL DEFAULT 0,
          command TEXT,
          cwd TEXT,
          expect_exit INTEGER,
          expect_stdout TEXT,
          timeout_sec INTEGER,
          source TEXT NOT NULL CHECK (source IN ('organizer', 'user')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          defined_at TEXT NOT NULL,
          first_passed_at TEXT,
          removed_at TEXT
        )
      `);
      db.run(`
        INSERT INTO acceptance_checks_new (
          id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd,
          expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at,
          defined_at, first_passed_at, removed_at
        )
        SELECT
          id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd,
          expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at,
          defined_at, first_passed_at, removed_at
        FROM acceptance_checks
      `);
      db.run(`DROP TABLE acceptance_checks`);
      db.run(`ALTER TABLE acceptance_checks_new RENAME TO acceptance_checks`);
      db.run(`CREATE INDEX IF NOT EXISTS acceptance_checks_task ON acceptance_checks (task_id, removed_at, created_at)`);
      const violations = db.query<{ table: string }, []>(`PRAGMA foreign_key_check(acceptance_checks)`).all();
      if (violations.length > 0) throw new Error("acceptance_checks migration broke a foreign key");
    })();
  } finally {
    db.run(`PRAGMA foreign_keys = ON`);
  }
}

/**
 * A plan outlives its conversation: deleting a group keeps its plans and sets their `session_id`
 * to NULL (`deleteSession`), and `SCHEMA_SQL` has declared the column nullable since tasks began.
 * A database whose `tasks` table was made by a development build from before that still says
 * NOT NULL — `CREATE TABLE IF NOT EXISTS` never touches a table that is there — so deleting any
 * group that ever held a plan failed on the constraint, and the app said only "internal error".
 *
 * The table is rebuilt from its own current definition with that one NOT NULL dropped, so every
 * column added since comes along unchanged. As in `migrateAcceptanceCheckKinds`, by SQLite's
 * 12-step procedure: foreign keys off first (tickets, checks and spec revisions reference tasks,
 * some ON DELETE CASCADE, and the DROP must not reach them), every row copied in one transaction,
 * the table's own indexes and triggers made again. The rename runs with `legacy_alter_table` on, so
 * SQLite does not re-check the triggers on other tables that name `tasks` while it is briefly
 * gone; those are made again at the end of every open anyway. The foreign-key check compares
 * before and after, so a dangling row the database already had cannot stop the daemon starting.
 */
export function migrateNullableTaskSession(db: Database): void {
  const column = db
    .query<{ notnull: number }, []>(`SELECT "notnull" FROM pragma_table_info('tasks') WHERE name = 'session_id'`)
    .get();
  if (!column || column.notnull === 0) return;
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get()!.sql;
  const relaxed = table.replace(/\bsession_id\s+TEXT\s+NOT\s+NULL\b/i, "session_id TEXT");
  if (relaxed === table) throw new Error("tasks.session_id is NOT NULL but its definition does not say so in a known way");
  // A table that was ever renamed is stored as CREATE TABLE "tasks".
  const createNew = relaxed.replace(/^CREATE TABLE\s+(?:"tasks"|tasks\b)/i, "CREATE TABLE tasks_new");
  if (createNew === relaxed) throw new Error("tasks has a definition this migration does not know how to copy");
  const own = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all();
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('tasks')`)
    .all()
    .map((col) => `"${col.name}"`)
    .join(", ");
  const dangling = () => db.query(`PRAGMA foreign_key_check(tasks)`).all().length;
  db.run(`PRAGMA foreign_keys = OFF`);
  db.run(`PRAGMA legacy_alter_table = ON`);
  try {
    db.transaction(() => {
      const before = dangling();
      db.run(createNew);
      db.run(`INSERT INTO tasks_new (${columns}) SELECT ${columns} FROM tasks`);
      db.run(`DROP TABLE tasks`);
      db.run(`ALTER TABLE tasks_new RENAME TO tasks`);
      for (const { sql } of own) db.run(sql);
      if (dangling() > before) throw new Error("tasks rebuild broke a foreign key");
    })();
  } finally {
    db.run(`PRAGMA legacy_alter_table = OFF`);
    db.run(`PRAGMA foreign_keys = ON`);
  }
}

/**
 * Checks from your words (ADR 0040 P3) carry where they came from, what they measure, the words,
 * the file they are bound to and whether they are only offered or in force, all in new nullable
 * columns. After the kind rebuild above, which
 * copies only the columns it knows.
 */
export function migrateDerivedChecks(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(acceptance_checks)").all().map((row) => row.name);
  for (const column of ["origin", "measure", "quote_id", "bind_kind", "bind_glob", "derived_state"]) {
    if (!cols.includes(column)) db.run(`ALTER TABLE acceptance_checks ADD COLUMN ${column} TEXT`);
  }
}

/**
 * The ledger's number (R-N) and the plan an entry's words were said about (ADR 0040 P3), for
 * entries written before either: numbered in the order they were written, and the plan read from
 * the words they stand on, else from where they hold.
 */
export function migrateRequirements(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirements)").all().map((row) => row.name);
  if (!cols.includes("seq")) db.run("ALTER TABLE requirements ADD COLUMN seq INTEGER");
  if (!cols.includes("origin_task_id")) db.run("ALTER TABLE requirements ADD COLUMN origin_task_id TEXT");
  if (!cols.includes("nature")) db.run("ALTER TABLE requirements ADD COLUMN nature TEXT");
  const unnumbered = db
    .query<{ id: string }, []>("SELECT id FROM requirements WHERE seq IS NULL ORDER BY created_at ASC, rowid ASC")
    .all();
  if (unnumbered.length > 0) {
    db.transaction(() => {
      let next = (db.query<{ n: number | null }, []>("SELECT MAX(seq) AS n FROM requirements").get()?.n ?? 0) + 1;
      for (const row of unnumbered) db.run("UPDATE requirements SET seq = ? WHERE id = ?", [next++, row.id]);
    })();
  }
  db.run(
    `UPDATE requirements SET origin_task_id = COALESCE(
       (SELECT task_id FROM user_quotes WHERE id = requirements.source_quote_id),
       CASE WHEN scope = 'plan' THEN scope_id END,
       CASE WHEN scope = 'ticket' THEN (SELECT task_id FROM tickets WHERE id = requirements.scope_id) END)
     WHERE origin_task_id IS NULL`,
  );
}
