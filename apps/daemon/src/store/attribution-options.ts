/** Manual repair choices are not a Bot's fixed candidate snapshot and may include dormant work. */
import { HttpError } from "../errors";
import type { StoreContext } from "./shared";

export function attributionOptions(ctx: Pick<StoreContext, "db">, messageId: string): {
  items: Array<{ id: string; title: string; tickets: Array<{ id: string; title: string }> }>;
} {
  if (!ctx.db.query("SELECT 1 FROM messages WHERE id = ?").get(messageId)) throw new HttpError(404, "not_found", "message not found");
  const plans = ctx.db.query<{ id: string; title: string }, []>(
    // The authenticated local person (and their paired phone) owns this whole workspace. This
    // list is explicit/manual only: looking at it does not lift a hold or resume a dormant plan.
    "SELECT id, title FROM tasks WHERE routine_id IS NULL ORDER BY created_at DESC, id DESC",
  ).all();
  const tickets = ctx.db.query<{ id: string; title: string; task_id: string }, []>(
    "SELECT id, title, task_id FROM tickets ORDER BY task_id, seq, id",
  ).all();
  return { items: plans.map((plan) => ({ ...plan, tickets: tickets.filter((ticket) => ticket.task_id === plan.id).map(({ id, title }) => ({ id, title })) })) };
}
