import type { Database } from "bun:sqlite";

/**
 * The spend cap's stop (ADR 0088). A `holds` table made before it says in its definition that a
 * hold comes only from your line, your button, a legacy parked plan or a migration (`source`);
 * SQLite cannot widen a CHECK in place, so the table is made again the way `migrateAgentRunners`
 * rebuilds `bots`: the definition as it stands with `spend_cap` added to that CHECK, every row
 * copied, its own indexes and triggers made again, and no foreign key left dangling that was not
 * already. The `held_scopes` view reads the table by name and is left as it is. An older build
 * reading the table afterwards honours a `spend_cap` hold as any hold, and lists it nowhere.
 */
export function migrateHoldSources(db: Database): void {
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'holds'`).get()?.sql;
  if (!table || table.includes("'spend_cap'")) return;
  const widened = table.replace(
    /\bsource\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i,
    (_match, kinds: string) => `source TEXT NOT NULL CHECK (source IN (${kinds.trim()}, 'spend_cap'))`,
  );
  if (widened === table) throw new Error("holds has a source CHECK this migration does not know how to widen");
  // A table that was ever renamed is stored as CREATE TABLE "holds".
  const createNew = widened.replace(/^CREATE TABLE\s+(?:"holds"|holds\b)/i, "CREATE TABLE holds_new");
  if (createNew === widened) throw new Error("holds has a definition this migration does not know how to copy");
  const own = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'holds' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all();
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('holds')`)
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
      db.run(`INSERT INTO holds_new (${columns}) SELECT ${columns} FROM holds`);
      db.run(`DROP TABLE holds`);
      db.run(`ALTER TABLE holds_new RENAME TO holds`);
      for (const { sql } of own) db.run(sql);
      if (dangling() > before) throw new Error("holds rebuild broke a foreign key");
    })();
  } finally {
    db.run(`PRAGMA legacy_alter_table = OFF`);
    db.run(`PRAGMA foreign_keys = ON`);
  }
}
