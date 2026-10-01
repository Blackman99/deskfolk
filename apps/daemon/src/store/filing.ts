/**
 * Where a line of yours belongs, read from the rows without a model call (ADR 0040 P4b, §8.2).
 * A dormant plan is never a candidate: clearing a conversation sets its plans aside, so a line
 * said afterwards lands on the job still being worked, not on the one the clear put to sleep.
 *
 * The signals used here, in order: a line that names one of a live job's parts; then the one live
 * job a Bot here has touched. Anything else is left to the organizer, which still files a line
 * until that call goes (23e).
 */
import type { StoreContext } from "./shared";

export type Filing = { taskId: string; ticketId: string | null };

const PART_WORD = /前\s*([一二三四五六七八九十\d]+)\s*镜|第\s*([一二三四五六七八九十\d]+)\s*镜|(?:shot|镜头?|c)\s*[ _-]?\s*0*(\d{1,3})/i;

const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** The part numbers a line names: 「前三镜」 is 1, 2 and 3; 「Shot 12」 and 「C07」 are that one. */
export function partNumbers(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(new RegExp(PART_WORD, "gi"))) {
    const leading = match[1];
    const single = match[2] ?? match[3];
    if (leading) {
      const count = numberOf(leading);
      for (let n = 1; n <= count; n += 1) found.add(n);
    } else if (single) {
      found.add(numberOf(single));
    }
  }
  return [...found];
}

function numberOf(text: string): number {
  const parsed = Number(text);
  if (Number.isFinite(parsed)) return parsed;
  return CN[text] ?? 0;
}

/**
 * Moves a line to another job (ADR 0040 §8.5). Inbox items already delivered for it, and the quote
 * kept from it, move with it.
 */
export function refileMessage(
  ctx: StoreContext,
  messageId: string,
  input: { taskId: string; ticketId?: string | null },
): { id: string; task_id: string | null; ticket_id: string | null } {
  const task = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE id = ?`).get(input.taskId);
  if (!task) throw new Error("no such plan");
  ctx.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [input.taskId, input.ticketId ?? null, messageId]);
  ctx.db.run(
    `UPDATE inbox_items SET task_id = ?, ticket_id = ? WHERE message_id = ? AND state IN ('queued', 'held', 'delivered')`,
    [input.taskId, input.ticketId ?? null, messageId],
  );
  ctx.db.run(`UPDATE user_quotes SET task_id = ? WHERE message_id = ?`, [input.taskId, messageId]);
  return ctx.db
    .query<{ id: string; task_id: string | null; ticket_id: string | null }, [string]>(`SELECT id, task_id, ticket_id FROM messages WHERE id = ?`)
    .get(messageId)!;
}

/**
 * The one job a line belongs to, when the rows say so. Null when they do not, and the organizer's
 * filing stands.
 */
export function fileLine(ctx: StoreContext, input: { sessionId: string; body: string }): Filing | null {
  const plans = livePlans(ctx, input.sessionId);
  const numbers = partNumbers(input.body);
  if (numbers.length > 0) {
    const hits = plans.flatMap((plan) => ticketsCovering(ctx, plan.id, numbers).map((ticketId) => ({ taskId: plan.id, ticketId })));
    const distinct = [...new Map(hits.map((hit) => [hit.taskId, hit])).values()];
    if (distinct.length === 1) return distinct[0]!;
  }
  return plans.length === 1 ? { taskId: plans[0]!.id, ticketId: null } : null;
}

/**
 * Plans a line said here can be about: the ones of the conversations the Bots here are also in,
 * that are not set aside. A direct shares its Bots' group, so a complaint there sees the group's
 * live job and not the one the group's clear put to sleep.
 */
function livePlans(ctx: StoreContext, sessionId: string): Array<{ id: string }> {
  return ctx.db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT t.id FROM tasks t
       JOIN session_participants there ON there.session_id = t.session_id AND there.left_at IS NULL
       JOIN session_participants here ON here.member = there.member AND here.session_id = ? AND here.left_at IS NULL
       WHERE t.dormant_since IS NULL AND t.closed_at IS NULL
         AND EXISTS (SELECT 1 FROM tickets k WHERE k.task_id = t.id AND k.status <> 'todo')
       ORDER BY t.created_at DESC`,
    )
    .all(sessionId);
}

/** The ticket of a plan whose title covers every part number the line names. */
function ticketsCovering(ctx: StoreContext, taskId: string, numbers: number[]): string[] {
  const tickets = ctx.db
    .query<{ id: string; title: string }, [string]>(`SELECT id, title FROM tickets WHERE task_id = ?`)
    .all(taskId);
  return tickets.filter((ticket) => covers(ticket.title, numbers)).map((ticket) => ticket.id);
}

/** 「Shot 01–03」 covers 1, 2 and 3; 「Shot 04–12」 does not. */
function covers(title: string, numbers: number[]): boolean {
  const span = title.match(/(\d+)\s*[–—-]\s*(\d+)/);
  if (!span) return false;
  const from = Number(span[1]);
  const to = Number(span[2]);
  return numbers.every((n) => n >= from && n <= to);
}
