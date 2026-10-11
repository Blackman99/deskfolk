/**
 * How a ticket reads wherever it is shown — its card on the board, its row on the rail, the
 * inspector — so a stage, a dropped ticket or who has the ball is said the same everywhere.
 */
import type { TaskDetail, TicketWithArtifacts } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { TICKET_STATUS_ORDER, ticketTag } from "./plan-board.ts";

/** Dropped by its lead (作废): parked with a reason. A ticket you set aside on the board has none and stays 搁置. */
export function isDropped(ticket: TicketWithArtifacts): boolean {
  return ticket.status === "parked" && ticket.dropped_why != null;
}

/** A stage the status alone does not say (ADR 0046) shows in its place: 审查中, 返工, 已交付, 已通过, 作废. */
export function stageLabel(ticket: TicketWithArtifacts, t: Copy): string {
  if (isDropped(ticket)) return t.plan.ticketDropped;
  const stage = ticket.stage;
  if (stage === "submitted" || stage === "in_review" || stage === "rework" || stage === "approved") return t.plan.ticketStage[stage];
  return t.plan.ticketStatus[ticket.status];
}

/**
 * The status menu, its current entry named as the row reads (a stage in its place: 审查中, 返工), so
 * the menu's face is the one label the row has.
 */
export function statusOptionsFor(ticket: TicketWithArtifacts, t: Copy): Array<{ value: string; label: string }> {
  const current = stageLabel(ticket, t);
  return TICKET_STATUS_ORDER.map((status) => ({ value: status, label: status === ticket.status ? current : t.plan.ticketStatus[status] }));
}

/** Who an open ticket waits on (ADR 0045, from level 4), in the board's words. `nameOf` names a Bot. */
export function ballLabel(
  ticket: TicketWithArtifacts,
  detail: Pick<TaskDetail, "tickets" | "submissions_on">,
  t: Copy,
  nameOf: (id: string) => string,
): string | null {
  const ball = ticket.ball;
  if (!ball) return null;
  // Waiting for another ticket (ADR 0060): which one, and whether it is the sample you approve.
  if (ball.kind === "app" && ball.reason === "waits" && ball.waits_for) {
    const other = detail.tickets.find((row) => row.id === ball.waits_for);
    return other ? t.plan.ballWaits(`#${ticketTag(other.seq)}`, Boolean(other.sample)) : null;
  }
  // Below level 5 a ticket waiting on you is one to mark done on the board, not an approval card.
  const key = ball.kind === "user" && ball.reason === "review" && !detail.submissions_on ? "acceptance"
    : ball.kind === "app" || ball.kind === "user" ? (ball.reason ?? "") : ball.kind;
  const label = t.plan.ball[key];
  if (typeof label === "function") return label(nameOf(ball.bot_id ?? ""));
  return label ?? null;
}

/**
 * Making this ticket the job's sample (ADR 0060) is offered where a sample matters — a large job, or
 * one that has one — on a ticket still being made: not the sample already, not through, not parked.
 */
export function canMakeSample(ticket: TicketWithArtifacts, detail: Pick<TaskDetail, "tickets" | "scale">): boolean {
  if (ticket.sample || ticket.status === "done" || ticket.status === "parked" || ticket.stage === "approved") return false;
  return detail.scale?.value === "large" || detail.tickets.some((row) => row.sample);
}
