/** A ticket's stage (ADR 0046) and the plan stage it rolls up to. */
import type { Ticket, TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { derivedNotGate } from "./acceptance-checks";
import { emptyPlanSpec, parsePlanSpec } from "./plan-shape";
import type { StoreContext } from "./shared";
import { getTask, setTaskSpec } from "./tasks";
import { getTicket, toTicket, type TicketRow } from "./tickets";
import { recordWorkEvent } from "./work-events";

export type TicketStage = "todo" | "doing" | "submitted" | "in_review" | "rework" | "approved" | "dropped";
export const TICKET_STAGES: readonly TicketStage[] = ["todo", "doing", "submitted", "in_review", "rework", "approved", "dropped"];

/** The stage a ticket with no stage of its own reads as, from its old status. */
export const STAGE_OF_STATUS: Readonly<Record<TicketStatus, TicketStage>> = {
  todo: "todo", doing: "doing", review: "submitted", done: "approved", parked: "dropped",
};
/** The old status written beside each stage (§2.3), so the board and any reader of status stay right. */
export const STATUS_OF_STAGE: Readonly<Record<TicketStage, TicketStatus>> = {
  todo: "todo", doing: "doing", submitted: "review", in_review: "review", rework: "doing", approved: "done", dropped: "parked",
};
/** A ticket's stage in SQL, for a table aliased `alias`: its own, else what its status reads as. */
export const STAGE_SQL = (alias: string) => `COALESCE(${alias}.stage, CASE ${alias}.status WHEN 'todo' THEN 'todo' WHEN 'doing' THEN 'doing'
  WHEN 'review' THEN 'submitted' WHEN 'done' THEN 'approved' ELSE 'dropped' END)`;
export type StagedTicketRow = TicketRow & { stage: string | null; reviewer_bot_id: string | null };

/** A ticket's stage: its own, or the one its status reads as. */
export function ticketStage(ticket: { status: TicketStatus; stage?: string | null }): TicketStage {
  return ticket.stage && (TICKET_STAGES as readonly string[]).includes(ticket.stage) ? ticket.stage as TicketStage : STAGE_OF_STATUS[ticket.status];
}

export function stagedTicket(ctx: StoreContext, id: string): StagedTicketRow {
  const row = ctx.db.query<StagedTicketRow, [string]>("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "ticket not found");
  return row;
}

/**
 * Moves a ticket to `stage`, its old status beside it (§2.3), and logs the move as
 * `ticket.stage_changed` — the supervisor's progress. Only this module moves a stage (a submission's
 * checks, a review, the supervisor's approval); your board edits change the status, and the trigger
 * `tickets_stage_follows_status` brings the stage along.
 */
export function setTicketStage(ctx: StoreContext, input: {
  ticketId: string; stage: TicketStage; source: "submission" | "review" | "supervisor" | "user";
  botId?: string | null; turnId?: string | null; workItemId?: string | null; submissionId?: string | null; now?: string;
}): Ticket {
  const row = stagedTicket(ctx, input.ticketId);
  const before = ticketStage(row);
  if (before === input.stage && row.stage === input.stage) return toTicket(row);
  const now = input.now ?? isoNow();
  const status = STATUS_OF_STAGE[input.stage];
  const closing = status === "done" || status === "parked";
  ctx.db.run(`UPDATE tickets SET stage = ?, status = ?, updated_at = ?, closed_at = CASE WHEN ? THEN COALESCE(closed_at, ?) ELSE NULL END
    WHERE id = ?`, [input.stage, status, now, closing ? 1 : 0, now, row.id]);
  if (before !== input.stage) {
    recordWorkEvent(ctx, { kind: "ticket.stage_changed", actor: input.source === "user" ? "user" : "app", botId: input.botId ?? null, taskId: row.task_id,
      ticketId: row.id, turnId: input.turnId ?? null, payload: { work_item_id: input.workItemId ?? null, before, after: input.stage, source: input.source,
        submission_id: input.submissionId ?? null } });
  }
  if (before === "approved" && input.stage !== "approved" && input.stage !== "dropped") reopenDeliveredPlan(ctx, row.task_id, row.id, input.stage, now);
  return getTicket(ctx, row.id);
}

/**
 * A delivered job one of whose tickets takes new work — handed in again, sent back to rework — is
 * active again: delivered means every ticket approved (ADR 0046), and the supervisor chases only
 * active jobs. It stayed delivered, so a review of new work in it was never chased (2026-10-03, a
 * slogan replaced after delivery). It is delivered again once its tickets are through.
 */
function reopenDeliveredPlan(ctx: StoreContext, taskId: string, ticketId: string, stage: TicketStage, now: string): void {
  const plan = ctx.db.query<{ status: string; stage: string | null }, [string]>("SELECT status, stage FROM tasks WHERE id = ?").get(taskId);
  if (!plan || (plan.stage ?? (plan.status === "done" ? "delivered" : "active")) !== "delivered") return;
  const task = getTask(ctx, taskId);
  const spec = parsePlanSpec(task.spec);
  if (spec) setTaskSpec(ctx, taskId, { ...spec, status: "active" }, now);
  ctx.db.run("UPDATE tasks SET stage = 'active', status = 'active', delivered_at = NULL, closed_at = NULL, dormant_since = NULL WHERE id = ?", [taskId]);
  recordWorkEvent(ctx, { kind: "plan.reopened", actor: "app", taskId, ticketId, payload: { ticket: ticketId, after: stage } });
}

/**
 * A plan whose every ticket not dropped is approved, and whose plan-wide gates (checks on no ticket)
 * last passed, is delivered (§2.6 active → delivered), by the same path the plan's status always
 * takes (`setTaskSpec`: its spec says done, it closes as a done plan does, a stop over it still reads
 * parked).
 */
export function settlePlanStage(ctx: StoreContext, taskId: string, now: string = isoNow()): boolean {
  const plan = ctx.db.query<{ status: string; stage: string | null }, [string]>("SELECT status, stage FROM tasks WHERE id = ?").get(taskId);
  if (!plan || (plan.stage ?? (plan.status === "done" ? "delivered" : "active")) !== "active") return false;
  const stages = ctx.db.query<{ stage: string }, [string]>(`SELECT ${STAGE_SQL("t")} AS stage FROM tickets t WHERE t.task_id = ?`).all(taskId)
    .map((row) => row.stage).filter((stage) => stage !== "dropped");
  if (stages.length === 0 || stages.some((stage) => stage !== "approved")) return false;
  const gates = ctx.db.query<{ id: string; origin: string | null; bind_kind: string | null; derived_state: string | null }, [string]>(
    "SELECT id, origin, bind_kind, derived_state FROM acceptance_checks WHERE task_id = ? AND ticket_id IS NULL AND removed_at IS NULL").all(taskId)
    .filter((check) => !derivedNotGate(check));
  for (const gate of gates) {
    const last = ctx.db.query<{ outcome: string | null; judged_by: string | null }, [string]>(`SELECT outcome, judged_by FROM acceptance_check_runs
      WHERE check_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(gate.id);
    // A verdict of pictures is only a reference (ADR 0046): it neither holds the plan back nor lets it through.
    if (last?.judged_by === "vision") continue;
    if (last?.outcome !== "pass") return false;
  }
  const task = getTask(ctx, taskId);
  const spec = parsePlanSpec(task.spec) ?? emptyPlanSpec(task.brief ?? task.title);
  setTaskSpec(ctx, taskId, { ...spec, status: "done" }, now);
  ctx.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = ? WHERE id = ?", [now, taskId]);
  recordWorkEvent(ctx, { kind: "plan.delivered", actor: "app", taskId, payload: { tickets: stages.length } });
  return true;
}
