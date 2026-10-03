/**
 * The escalation ladder (ADR 0049, engine level 7), kept deliberately short: a job whose hand-overs
 * fail twice in a row since its last step up runs one thinking level higher, up to the top its model
 * offers; the ticket's approval puts it back. Past the top it moves up the model ladder you ordered
 * (ADR 0054), never on its own guess of which model is stronger, and never moves a thinking level you
 * pinned. With no rung left, you are told once.
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
  // Counted since its last step from hand-overs: a step trouble inside a turn made does not start the count again.
  const since = ctx.db.query<{ at: string }, [string]>(`SELECT at FROM work_events WHERE kind IN ('model.escalated', 'model.escalation_reset')
    AND json_extract(payload, '$.work_item_id') = ? AND json_extract(payload, '$.reason') IS NULL ORDER BY seq DESC LIMIT 1`).get(workItemId)?.at ?? "";
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

/** Why a job stepped up from inside a turn (ADR 0054). */
export type TurnTrouble = "failure_shape" | "malformed_tool_json" | "tool_failures";

/**
 * Trouble inside a turn (ADR 0054): a reply that failed again after its retry, tool arguments that
 * were not JSON twice in a row, or the same tool called wrongly three times in a row. Its job steps up
 * one — at most once between two of its hand-overs, so trouble that keeps coming back cannot pile
 * steps up on its own; a thinking level you pinned is never moved, so nothing is stepped then.
 * True when it stepped.
 */
export function stepUpForTrouble(ctx: StoreContext, turnId: string, reason: TurnTrouble, now: string = isoNow()): boolean {
  if (!on(ctx)) return false;
  const turn = ctx.db.query<{ work_item_id: string | null; bot_id: string; task_id: string | null; ticket_id: string | null; pinned: string | null }, [string]>(
    `SELECT t.work_item_id, t.bot_id, t.task_id, t.ticket_id, b.thinking_level AS pinned FROM turns t JOIN bots b ON b.id = t.bot_id WHERE t.id = ?`).get(turnId);
  if (!turn?.work_item_id || turn.pinned) return false;
  const since = ctx.db.query<{ at: string | null }, [string, string]>(`SELECT MAX(at) AS at FROM (
      SELECT created_at AS at FROM submissions WHERE work_item_id = ? AND origin <> 'organizer'
      UNION ALL SELECT at FROM work_events WHERE kind = 'model.escalation_reset' AND json_extract(payload, '$.work_item_id') = ?)`)
    .get(turn.work_item_id, turn.work_item_id)?.at ?? "";
  if (ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'model.escalated' AND json_extract(payload, '$.work_item_id') = ?
    AND json_extract(payload, '$.reason') IS NOT NULL AND at > ?`).get(turn.work_item_id, since)) return false;
  const before = workEscalation(ctx, turn.work_item_id);
  ctx.db.run("UPDATE work_items SET escalation = ? WHERE id = ?", [before + 1, turn.work_item_id]);
  recordWorkEvent(ctx, { kind: "model.escalated", actor: "app", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId,
    payload: { work_item_id: turn.work_item_id, from: before, to: before + 1, reason, at: now } });
  return true;
}

/** Of a job's steps, those trouble inside its turns made (ADR 0054): they raise its thinking level but never switch its model. */
export function workTroubleSteps(ctx: StoreContext, workItemId: string): number {
  const since = ctx.db.query<{ at: string | null }, [string]>(`SELECT MAX(at) AS at FROM work_events WHERE kind = 'model.escalation_reset'
    AND json_extract(payload, '$.work_item_id') = ?`).get(workItemId)?.at ?? "";
  return ctx.db.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM work_events WHERE kind = 'model.escalated'
    AND json_extract(payload, '$.work_item_id') = ? AND json_extract(payload, '$.reason') IS NOT NULL AND at > ?`).get(workItemId, since)!.n;
}

/** The ticket's approval puts a job back on its own level. */
export function resetEscalation(ctx: StoreContext, workItemId: string | null): void {
  if (!workItemId || !on(ctx) || workEscalation(ctx, workItemId) === 0) return;
  ctx.db.run("UPDATE work_items SET escalation = 0 WHERE id = ?", [workItemId]);
  const row = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null }, [string]>("SELECT bot_id, task_id, ticket_id FROM work_items WHERE id = ?").get(workItemId);
  recordWorkEvent(ctx, { kind: "model.escalation_reset", actor: "app", botId: row?.bot_id ?? null, taskId: row?.task_id ?? null, ticketId: row?.ticket_id ?? null,
    payload: { work_item_id: workItemId } });
}
