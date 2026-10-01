import type { Database } from "bun:sqlite";

/**
 * The supervisor's columns on tickets (ADR 0045), additive: `owner_bot_id`, who the supervisor
 * calls back to a ticket, written alongside `worker` from now on; and `depends_on`, the tickets of
 * the same plan it waits for (a JSON list, empty by default). Once, for tickets from before them:
 * the owner is the worker when that Bot can still take work in the plan, else the Bot with the most
 * turns on the ticket that can (§5.3 「迁移时的持球者」); with neither it stays empty and the ball
 * falls to the plan's lead, which the supervisor reads rather than stores (store/supervisor.ts).
 */
export function migrateSupervisor(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (!columns.includes("owner_bot_id")) db.run("ALTER TABLE tickets ADD COLUMN owner_bot_id TEXT");
  if (!columns.includes("depends_on")) db.run("ALTER TABLE tickets ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
  db.transaction(() => {
    if (db.query("SELECT 1 FROM settings WHERE key = 'supervisor_owners_imported'").get()) return;
    const eligible = (bot: string) => `EXISTS (SELECT 1 FROM bots b WHERE b.id = ${bot} AND b.archived_at IS NULL AND b.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM session_participants p JOIN tasks plan ON plan.session_id = p.session_id
        WHERE plan.id = tickets.task_id AND p.member = ${bot} AND p.left_at IS NULL)`;
    db.run(`UPDATE tickets SET owner_bot_id = COALESCE(
      CASE WHEN ${eligible("tickets.worker")} THEN worker END,
      (SELECT t.bot_id FROM turns t WHERE t.ticket_id = tickets.id AND t.task_id = tickets.task_id AND IFNULL(t.mode, 'work') <> 'readonly'
        AND ${eligible("t.bot_id")} GROUP BY t.bot_id ORDER BY COUNT(*) DESC, MIN(t.created_at), t.bot_id LIMIT 1))
      WHERE owner_bot_id IS NULL`);
    db.run("INSERT INTO settings (key, value) VALUES ('supervisor_owners_imported', '1')");
  })();
}
