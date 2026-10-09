/**
 * How a plan's hand-overs came out, as the organizer reads them: each ticket's newest hand-over and
 * who decided it, and the decisions since a moment. The organizer used to see a ticket's status and
 * nothing else, so a version you had just sent back read as "对照样片通过" in the job's progress four
 * times running (IG MV, 2026-10-09): your 退回 lives in `work_events`, and its notice is a bot-only line.
 *
 * Who decided: your 退回 is `review.recorded` by you; your 放行 is `submission.approved` by you
 * (since 2026-10-10 — before that every press was logged `by: no_reviewer`, so an approval whose card
 * your press marked is read as yours too); a reviewer's is its `review.recorded`; the rest is the app.
 */
import { USER_MEMBER } from "@real-bot/protocol";
import type { StoreContext } from "./shared";
import type { SubmissionState } from "./submission-rows";

export type HandOverDecider = "user" | "reviewer" | "app";

/** A ticket's newest hand-over (a superseded one never came out at all). */
export type HandOverOutcome = {
  state: SubmissionState;
  at: string;
  /** Null while nobody has decided it. */
  decided_by: HandOverDecider | null;
  /** What you said with your 退回, in your words. */
  user_note?: string;
  /** Its card is out, waiting on your 放行 or 退回. */
  waiting_on_user?: true;
};

/** One decision on a hand-over: approved, sent back, or put back to rework by a line of yours. */
export type HandOverDecision = {
  ticket_id: string | null;
  outcome: "approve" | "reject" | "rework";
  by: HandOverDecider;
  note?: string;
  at: string;
};

type SubmissionRow = { id: string; ticket_id: string; state: SubmissionState; updated_at: string; awaiting: string | null; reviews: string };
type EventRow = { seq: number; at: string; kind: string; actor: string; ticket_id: string | null; payload: string };

/** The submissions of this plan whose card your press marked 放行. */
function pressedApprove(ctx: StoreContext, taskId: string): Set<string> {
  const rows = ctx.db.query<{ submission_id: string | null }, [string]>(
    `SELECT json_extract(control, '$.submission_id') AS submission_id FROM messages
     WHERE kind = 'system' AND json_valid(control) AND json_extract(control, '$.kind') = 'review_item'
       AND json_extract(control, '$.task_id') = ?
       AND EXISTS (SELECT 1 FROM json_each(json_extract(control, '$.acted')) WHERE value = 'approve')`,
  ).all(taskId);
  return new Set(rows.map((row) => row.submission_id).filter((id): id is string => typeof id === "string"));
}

function parse(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Who an approval event says let it through. */
function approver(event: EventRow, payload: Record<string, unknown>, pressed: ReadonlySet<string>): HandOverDecider {
  const id = typeof payload.submission_id === "string" ? payload.submission_id : null;
  // A reviewer's approve that put it on your card, then your 放行: yours.
  if (payload.by === "user" || event.actor === USER_MEMBER || (id !== null && pressed.has(id))) return "user";
  return event.kind === "review.recorded" ? "reviewer" : "app";
}

/** Each ticket's newest hand-over that was not superseded, and how it came out. */
export function ticketHandOvers(ctx: StoreContext, taskId: string): Map<string, HandOverOutcome> {
  const newest = new Map<string, SubmissionRow>();
  for (const row of ctx.db.query<SubmissionRow, [string]>(
    `SELECT id, ticket_id, state, updated_at, awaiting, reviews FROM submissions
     WHERE task_id = ? AND state <> 'superseded' ORDER BY created_at DESC, rowid DESC`,
  ).all(taskId)) {
    if (!newest.has(row.ticket_id)) newest.set(row.ticket_id, row);
  }
  const out = new Map<string, HandOverOutcome>();
  if (newest.size === 0) return out;
  const pressed = pressedApprove(ctx, taskId);
  const decided = new Map<string, EventRow>();
  for (const event of ctx.db.query<EventRow, [string]>(
    `SELECT seq, at, kind, actor, ticket_id, payload FROM work_events
     WHERE task_id = ? AND kind IN ('review.recorded', 'submission.approved') ORDER BY seq ASC`,
  ).all(taskId)) {
    const id = parse(event.payload).submission_id;
    if (typeof id === "string") decided.set(id, event);
  }
  for (const [ticketId, row] of newest) {
    const outcome: HandOverOutcome = { state: row.state, at: row.updated_at, decided_by: null };
    const event = decided.get(row.id);
    if (row.state === "approved") {
      outcome.decided_by = event ? approver(event, parse(event.payload), pressed) : pressed.has(row.id) ? "user" : "app";
    } else if (row.state === "rejected") {
      const payload = event ? parse(event.payload) : {};
      if (event?.actor === USER_MEMBER) {
        outcome.decided_by = "user";
        const note = text(payload.note);
        if (note) outcome.user_note = note;
      } else {
        outcome.decided_by = "reviewer";
      }
    } else if (row.state === "checks_failed") {
      outcome.decided_by = "app";
    } else if ((row.state === "submitted" || row.state === "in_review") && row.awaiting) {
      const awaiting = parse(row.awaiting);
      if (typeof awaiting.message_id === "string") outcome.waiting_on_user = true;
    }
    out.set(ticketId, outcome);
  }
  return out;
}

/**
 * The decisions on this plan's hand-overs after `since`, oldest first, at most `limit`: approvals,
 * send-backs (yours with what you said), and lines of yours read as putting a ticket back to rework
 * (with the line), leaving out a rework you undid.
 */
export function handOverDecisionsSince(ctx: StoreContext, taskId: string, since: string, limit = 12): HandOverDecision[] {
  const events = ctx.db.query<EventRow, [string, string]>(
    `SELECT seq, at, kind, actor, ticket_id, payload FROM work_events
     WHERE task_id = ? AND at > ? AND kind IN ('review.recorded', 'submission.approved', 'complaint.rework', 'complaint.rework_undone')
     ORDER BY at ASC, seq ASC`,
  ).all(taskId, since);
  if (events.length === 0) return [];
  const undone = new Set(events.filter((event) => event.kind === "complaint.rework_undone")
    .map((event) => parse(event.payload).card_id).filter((id): id is string => typeof id === "string"));
  const pressed = pressedApprove(ctx, taskId);
  const out: HandOverDecision[] = [];
  for (const event of events) {
    const payload = parse(event.payload);
    if (event.kind === "complaint.rework") {
      if (typeof payload.card_id === "string" && undone.has(payload.card_id)) continue;
      const line = typeof payload.message_id === "string"
        ? ctx.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(payload.message_id)?.body
        : undefined;
      const note = text(line);
      out.push({ ticket_id: event.ticket_id, outcome: "rework", by: "user", ...(note ? { note } : {}), at: event.at });
    } else if (event.kind === "complaint.rework_undone") {
      continue;
    } else if (event.kind === "submission.approved" || payload.outcome === "approve") {
      out.push({ ticket_id: event.ticket_id, outcome: "approve", by: approver(event, payload, pressed), at: event.at });
    } else {
      const by: HandOverDecider = event.actor === USER_MEMBER ? "user" : "reviewer";
      const note = by === "user" ? text(payload.note) : undefined;
      out.push({ ticket_id: event.ticket_id, outcome: "reject", by, ...(note ? { note } : {}), at: event.at });
    }
  }
  return out.slice(-limit);
}
