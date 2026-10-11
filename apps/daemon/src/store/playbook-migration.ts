import type { Database } from "bun:sqlite";

/**
 * Engines (ADR 0085), additive only: a conversation names the engine it runs, and a call record
 * the engine it ran under. The engine tables themselves are in schema.ts.
 */
export function migratePlaybooks(db: Database): void {
  for (const [table, definitions] of [
    ["sessions", [["playbook_id", "TEXT"]]],
    ["call_runs", [["playbook_id", "TEXT"], ["playbook_revision", "INTEGER"]]],
  ] as const) {
    const names = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const [name, definition] of definitions) {
      if (!names.includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}
