import type { Database } from "bun:sqlite";

/**
 * Local agents besides Claude Code (ADR 0079). A `bots` table made between ADR 0061 and this one
 * says in its definition that only `claude_code` may run a Bot (`runner`) and only Claude Code's
 * efforts may be asked for (`agent_effort`); SQLite cannot drop a CHECK in place, so the table is
 * made again without the two, the way `migrateNullableTaskSession` rebuilds `tasks`: the definition
 * as it stands less the two CHECKs, every row copied, its own indexes and triggers made again, and
 * no foreign key left dangling that was not already. The store checks both values from then on,
 * against the runner a value is for. An older build reading the table afterwards treats a runner
 * it does not know as none, and runs that Bot on its endpoint (`toBot`).
 */
export function migrateAgentRunners(db: Database): void {
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bots'`).get()?.sql;
  if (!table) return;
  const relaxed = table
    .replace(/\brunner\s+TEXT\s+CHECK\s*\(\s*runner\s+IS\s+NULL\s+OR\s+runner\s+IN\s*\([^)]*\)\s*\)/i, "runner TEXT")
    .replace(/\bagent_effort\s+TEXT\s+CHECK\s*\(\s*agent_effort\s+IS\s+NULL\s+OR\s+agent_effort\s+IN\s*\([^)]*\)\s*\)/i, "agent_effort TEXT");
  if (relaxed === table) return;
  if (/\bCHECK\s*\(\s*(?:runner|agent_effort)\b/i.test(relaxed)) throw new Error("bots has a runner CHECK this migration does not know how to drop");
  // A table that was ever renamed is stored as CREATE TABLE "bots".
  const createNew = relaxed.replace(/^CREATE TABLE\s+(?:"bots"|bots\b)/i, "CREATE TABLE bots_new");
  if (createNew === relaxed) throw new Error("bots has a definition this migration does not know how to copy");
  const own = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'bots' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all();
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('bots')`)
    .all()
    .map((col) => `"${col.name}"`)
    .join(", ");
  const dangling = () => db.query(`PRAGMA foreign_key_check`).all().length;
  db.run(`PRAGMA foreign_keys = OFF`);
  db.run(`PRAGMA legacy_alter_table = ON`);
  try {
    db.transaction(() => {
      const before = dangling();
      db.run(createNew);
      db.run(`INSERT INTO bots_new (${columns}) SELECT ${columns} FROM bots`);
      db.run(`DROP TABLE bots`);
      db.run(`ALTER TABLE bots_new RENAME TO bots`);
      for (const { sql } of own) db.run(sql);
      if (dangling() > before) throw new Error("bots rebuild broke a foreign key");
    })();
  } finally {
    db.run(`PRAGMA legacy_alter_table = OFF`);
    db.run(`PRAGMA foreign_keys = ON`);
  }
}
