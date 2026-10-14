import type { Database } from "bun:sqlite";

/** Additive only: `inbox_items.reply_in`, where a line of yours heard in another conversation is answered. */
export function migrateInboxReplyIn(db: Database): void {
  const names = db.query<{ name: string }, []>(`PRAGMA table_info(inbox_items)`).all().map((row) => row.name);
  if (names.length > 0 && !names.includes("reply_in")) db.run(`ALTER TABLE inbox_items ADD COLUMN reply_in TEXT`);
}
