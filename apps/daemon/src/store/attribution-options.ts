/** Manual repair choices are not a Bot's fixed candidate snapshot and may include dormant work. */
import { HttpError } from "../errors";
import type { StoreContext } from "./shared";
import { STAGE_SQL } from "./submissions";

export function attributionOptions(ctx: Pick<StoreContext, "db">, messageId: string): {
  items: Array<{ id: string; title: string; tickets: Array<{ id: string; title: string }> }>;
} {
  if (!ctx.db.query("SELECT 1 FROM messages WHERE id = ?").get(messageId)) throw new HttpError(404, "not_found", "message not found");
  const plans = ctx.db.query<{ id: string; title: string; routine_id: string | null }, []>(
    // The authenticated local person (and their paired phone) owns this whole workspace. This
    // list is explicit/manual only: looking at it does not lift a hold or resume a dormant plan.
    // A routine's standing plan is in it too: what you say about this morning's run is filed
    // there (rule 9), and its tag has to name it, not 「一件事」.
    "SELECT id, title, routine_id FROM tasks ORDER BY created_at DESC, id DESC",
  ).all();
  // A dropped ticket (作废) is no place to file a line, unless the line is filed there now: the
  // job's opening ticket, folded once the lead laid the job out, was offered beside the real ones.
  const filed = new Set(ctx.db.query<{ ticket_id: string }, [string]>(
    "SELECT ticket_id FROM message_filings WHERE message_id = ? AND ticket_id IS NOT NULL").all(messageId).map((row) => row.ticket_id));
  const tickets = ctx.db.query<{ id: string; title: string; task_id: string; stage: string }, []>(
    `SELECT t.id, t.title, t.task_id, ${STAGE_SQL("t")} AS stage FROM tickets t ORDER BY t.task_id, t.seq, t.id`,
  ).all().filter((ticket) => ticket.stage !== "dropped" || filed.has(ticket.id));
  return {
    items: plans.map(({ routine_id, ...plan }) => {
      const own = tickets.filter((ticket) => ticket.task_id === plan.id).map(({ id, title }) => ({ id, title }));
      // A routine opens a ticket per run: the latest run, the one you mean, comes first.
      return { ...plan, tickets: routine_id ? own.reverse() : own };
    }),
  };
}
