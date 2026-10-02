/**
 * The escalation ladder (ADR 0049, engine level 7), kept deliberately short: a job whose hand-overs
 * fail twice in a row since its last step up runs one thinking level higher, up to the top its model
 * offers; the ticket's approval puts it back. It never switches the model on its own — with no reference price
 * set on the models there is no telling which is stronger — and never moves a thinking level you
 * pinned. Switching models stays yours: at the top, you are told once.
 */
import { isoNow } from "../ids";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** Failed hand-overs in a row, since the last step up, that take a job one level higher. */
export const ESCALATE_AFTER_FAILURES = 2;

function on(ctx: StoreContext): boolean {
  try {
    return readEngineLevel(ctx.db) >= ENGINE_LEVELS.routing;
  } catch {
    return false;
  }
}

export function workEscalation(ctx: StoreContext, workItemId: string): number {
  return ctx.db.query<{ escalation: number }, [string]>("SELECT escalation FROM work_items WHERE id = ?").get(workItemId)?.escalation ?? 0;
}

/** After a hand-over of `workItemId` failed (its checks, a review's reject, your send-back): one step up once enough failed in a row. */
export function noteHandOverFailed(ctx: StoreContext, workItemId: string | null, now: string = isoNow()): void {
  if (!workItemId || !on(ctx)) return;
  const since = ctx.db.query<{ at: string }, [string]>(`SELECT at FROM work_events WHERE kind IN ('model.escalated', 'model.escalation_reset')
    AND json_extract(payload, '$.work_item_id') = ? ORDER BY seq DESC LIMIT 1`).get(workItemId)?.at ?? "";
  // The organizer's reading is not the producer's hand-over: your send-back of it says nothing about the model.
  const states = ctx.db.query<{ state: string }, [string, string]>(`SELECT state FROM submissions WHERE work_item_id = ? AND created_at > ?
    AND origin <> 'organizer' AND state IN ('checks_failed', 'rejected', 'approved') ORDER BY created_at DESC, rowid DESC`).all(workItemId, since).map((row) => row.state);
  let failed = 0;
  for (const state of states) {
    if (state === "approved") break;
    failed += 1;
  }
  if (failed < ESCALATE_AFTER_FAILURES) return;
  const before = workEscalation(ctx, workItemId);
  ctx.db.run("UPDATE work_items SET escalation = ? WHERE id = ?", [before + 1, workItemId]);
  const row = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null }, [string]>("SELECT bot_id, task_id, ticket_id FROM work_items WHERE id = ?").get(workItemId);
  recordWorkEvent(ctx, { kind: "model.escalated", actor: "app", botId: row?.bot_id ?? null, taskId: row?.task_id ?? null, ticketId: row?.ticket_id ?? null,
    payload: { work_item_id: workItemId, from: before, to: before + 1, failed, at: now } });
}

/** The ticket's approval puts a job back on its own level. */
export function resetEscalation(ctx: StoreContext, workItemId: string | null): void {
  if (!workItemId || !on(ctx) || workEscalation(ctx, workItemId) === 0) return;
  ctx.db.run("UPDATE work_items SET escalation = 0 WHERE id = ?", [workItemId]);
  const row = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null }, [string]>("SELECT bot_id, task_id, ticket_id FROM work_items WHERE id = ?").get(workItemId);
  recordWorkEvent(ctx, { kind: "model.escalation_reset", actor: "app", botId: row?.bot_id ?? null, taskId: row?.task_id ?? null, ticketId: row?.ticket_id ?? null,
    payload: { work_item_id: workItemId } });
}
