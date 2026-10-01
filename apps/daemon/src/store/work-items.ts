/**
 * A piece of work a Bot has on (ADR 0040 P4b): one Bot on one plan, or, with no plan, one Bot in
 * one conversation. A turn binds to one when it opens, and the live-turn indexes then keep a Bot
 * to one live turn per plan.
 */
import { isoNow, ulid } from "../ids";
import type { StoreContext } from "./shared";

export type WorkItem = {
  id: string;
  bot_id: string;
  task_id: string | null;
  ticket_id: string | null;
  home_session_id: string;
  state: string;
};

/**
 * The open work item for this Bot on this plan (or, with no plan, in this conversation), made when
 * there is none. A ticket only narrows one that already names a plan.
 */
export function findOrCreateWorkItem(
  ctx: StoreContext,
  input: { botId: string; sessionId: string; taskId: string | null; ticketId: string | null },
): WorkItem {
  const existing = input.taskId
    ? ctx.db
        .query<WorkItem, [string, string]>(
          `SELECT * FROM work_items WHERE bot_id = ? AND task_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`,
        )
        .get(input.botId, input.taskId)
    : ctx.db
        .query<WorkItem, [string, string]>(
          `SELECT * FROM work_items WHERE bot_id = ? AND task_id IS NULL AND home_session_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`,
        )
        .get(input.botId, input.sessionId);
  if (existing) return existing;
  const now = isoNow();
  return ctx.db
    .query<WorkItem, Array<string | null>>(
      `INSERT INTO work_items (id, bot_id, task_id, ticket_id, home_session_id, role, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'own', 'running', ?, ?) RETURNING *`,
    )
    .get(ulid(Date.parse(now)), input.botId, input.taskId, input.ticketId, input.sessionId, now, now)!;
}

/** How many jobs one Bot works at once before the next one waits (ADR 0040 P4b). A desk turn is extra. */
export const PARALLEL_LIMIT = 2;

/**
 * Where a new turn for this Bot would stand in line: how many of its turns are already working on
 * other jobs. A turn on the same plan is not a queue, it is heard by that turn. Null when it can
 * start now.
 */
export function queuePlace(
  ctx: StoreContext,
  input: { botId: string; taskId: string | null },
): number | null {
  const working = ctx.db
    .query<{ task_id: string | null }, [string]>(
      `SELECT task_id FROM turns
       WHERE bot_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')
         AND IFNULL(mode, 'work') NOT IN ('readonly', 'desk')`,
    )
    .all(input.botId);
  if (working.some((row) => row.task_id === input.taskId)) return null;
  return working.length >= PARALLEL_LIMIT ? working.length - PARALLEL_LIMIT + 1 : null;
}

/** Marks a work item closed once no live turn still runs it. */
export function closeWorkItemIfIdle(ctx: StoreContext, id: string | null): void {
  if (!id) return;
  const live = ctx.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM turns WHERE work_item_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')`,
    )
    .get(id)!.n;
  if (live > 0) return;
  ctx.db.run(`UPDATE work_items SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND state <> 'closed'`, [isoNow(), isoNow(), id]);
}
