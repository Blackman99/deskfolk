/**
 * End-of-segment facts (ADR 0040 §5.2). The engine consumes this result and only then makes the
 * turn terminal, after recording tool results. No model calls or async transactions live here.
 */
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { holdsCovering } from "./holds";
import { requireNonEmpty, type StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";
import { disposeInboxItems, inboxLabel, turnInbox } from "./inbox";
import { listDelegations, replyDelegation } from "./delegations";
import { isReservedTaskPath } from "./tasks";
import { settingsCached } from "./settings";
import { noProgressNoticeBody } from "../prompts/control-copy";
import { supervisorJobLabel } from "../prompts/transcript-copy";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { STAGE_SQL } from "./submissions";

export type EndReason = "done" | "answered" | "nothing_new" | "blocked" | "gave_up";
export type FinishWorkInput = {
  turnId: string;
  reason: unknown;
  note?: unknown;
  needsFromUser?: unknown;
  answer?: unknown;
  inbox?: unknown;
};
export type FinishWorkOptions = {
  /** Pure text uses the same facts but does not require an explicit end_turn call. */
  pureText?: boolean;
  /** Total contract bounces already consumed by the parent engine, across all contracts. */
  contractBounces?: number;
};
export type EndObligations = {
  tickets: Array<{ id: string; status: string }>;
  outgoingDelegations: string[];
  incomingDelegations: string[];
  waits: string[];
};
export type ImplicitSubmissionCandidates = {
  implemented: false;
  candidates: Array<{ path: string; messageId: string; attachmentId: string }>;
  requires: readonly ["exists", "new_content_hash", "bound_checks", "stored_submission"];
};
export type FinishWorkResult = {
  ended: boolean;
  workItemId: string | null;
  obligations: EndObligations;
  dispositions: ReturnType<typeof disposeInboxItems>;
  unacknowledgedInbox: string[];
  replies: Array<ReturnType<typeof replyDelegation>>;
  /** Internal engine/P4e seam only, not a claim of a submitted product or a Bot-facing tool field. */
  implicitSubmission: ImplicitSubmissionCandidates;
  bounce?: string;
  code?: string;
  state?: "idle" | "closed" | "waiting" | "blocked" | "needs_attention";
  endReason?: EndReason | "needs_attention";
  /** The engine creates the visible question/notification after this transaction commits. */
  ask?: { body: string };
  notice?: { code: "gave_up" | "no_progress"; body: string };
  noProgressCount?: number;
};
type Actor = {
  id: string; status: string; bot_id: string; session_id: string; task_id: string | null;
  ticket_id: string | null; work_item_id: string | null; mode: "work" | "desk" | "readonly" | null;
};
type Item = {
  bot_id: string; task_id: string | null; ticket_id: string | null; state: string; waiting_on: string | null; home_session_id: string;
};

function optionalText(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", `${field} must be a string`);
  return value.trim();
}

function actor(ctx: StoreContext, turnId: string, reason: EndReason, replay = false): { turn: Actor; item: Item | null } {
  const turn = ctx.db.query<Actor, [string]>("SELECT * FROM turns WHERE id = ?").get(turnId);
  if (!turn) throw new HttpError(404, "not_found", "turn not found");
  if (turn.status !== "running") throw new HttpError(409, "turn_ended", "this segment is no longer running");
  if (turn.mode === "readonly") {
    if (reason !== "answered" || turn.work_item_id || turn.task_id || turn.ticket_id) {
      throw new HttpError(409, "readonly", "a read-only segment can only end its unbound answer");
    }
    return { turn, item: null };
  }
  const item = turn.work_item_id ? ctx.db.query<Item, [string]>("SELECT * FROM work_items WHERE id = ?").get(turn.work_item_id) : null;
  if (!item || (!replay && item.state === "closed") || item.bot_id !== turn.bot_id || item.task_id !== turn.task_id || item.ticket_id !== turn.ticket_id
    || (turn.mode === "desk" && turn.task_id !== null) || (turn.task_id === null && (turn.ticket_id !== null || item.home_session_id !== turn.session_id))) {
    throw new HttpError(422, "invalid_args", "ending needs a running, exactly bound work or desk segment");
  }
  if (turn.ticket_id && !ctx.db.query("SELECT 1 FROM tickets WHERE id = ? AND task_id = ?").get(turn.ticket_id, turn.task_id)) {
    throw new HttpError(422, "invalid_args", "the bound ticket must belong to this plan");
  }
  if (holdsCovering(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId }).length) {
    throw new HttpError(409, "held", "this work is held");
  }
  return { turn, item };
}

/**
 * What the segment's work still owes. Its tickets not closed — from engine level 5 by stage: one
 * handed over (submitted, in review) is the reviewer's or the app's to move, so only todo, doing and
 * rework are still the producer's (ADR 0046) — its open requests either way, and its waits.
 */
function obligations(ctx: StoreContext, turn: Actor): EndObligations {
  const tickets = readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions
    ? ctx.db.query<{ id: string; status: string }, [string | null, string | null]>(`SELECT t.id, ${STAGE_SQL("t")} AS status FROM tickets t
      WHERE t.task_id = ?1 AND (?2 IS NULL OR t.id = ?2) AND ${STAGE_SQL("t")} IN ('todo','doing','rework') ORDER BY t.seq`).all(turn.task_id, turn.ticket_id)
    : ctx.db.query<{ id: string; status: string }, [string | null, string | null]>(
      "SELECT id, status FROM tickets WHERE task_id = ?1 AND (?2 IS NULL OR id = ?2) AND status IN ('todo','doing','review') ORDER BY seq"
    ).all(turn.task_id, turn.ticket_id);
  const outgoingDelegations = ctx.db.query<{ id: string }, [string | null]>(
    "SELECT id FROM delegations WHERE from_work_item_id = ? AND status = 'open' ORDER BY rowid").all(turn.work_item_id).map((row) => row.id);
  const incomingDelegations = ctx.db.query<{ id: string }, [string | null, string]>(
    "SELECT id FROM delegations WHERE to_work_item_id = ? AND to_bot_id = ? AND status = 'open' ORDER BY rowid").all(turn.work_item_id, turn.bot_id).map((row) => row.id);
  const waits = ctx.db.query<{ id: string }, [string | null, string]>(`SELECT id FROM check_backs c
    WHERE (c.work_item_id = ?1 OR c.turn_id = ?2) AND c.fired_at IS NULL AND c.voided_at IS NULL AND c.suspended_at IS NULL
      AND (c.wait_spec IS NULL OR json_extract(c.wait_spec, '$.kind') = 'timer'
        OR (json_extract(c.wait_spec, '$.kind') = 'delegation' AND EXISTS (SELECT 1 FROM delegations d
          WHERE d.id = json_extract(c.wait_spec, '$.ref') AND d.from_work_item_id = ?1 AND d.status = 'open')))
    ORDER BY c.created_at, c.id`).all(turn.work_item_id, turn.id).map((row) => row.id);
  return { tickets, outgoingDelegations, incomingDelegations, waits };
}

function validWaiting(ctx: StoreContext, item: Item | null, facts: EndObligations): boolean {
  if (item?.state !== "waiting" || !item.waiting_on || !facts.waits.length) return false;
  let waiting: unknown;
  try { waiting = JSON.parse(item.waiting_on); } catch { return false; }
  if (!waiting || typeof waiting !== "object" || Array.isArray(waiting)) return false;
  const { kind, ref } = waiting as Record<string, unknown>;
  if (typeof ref !== "string") return false;
  if (kind === "timer") return facts.waits.includes(ref);
  if (kind !== "delegation" || !facts.outgoingDelegations.includes(ref)) return false;
  return Boolean(ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM check_backs WHERE id IN (SELECT value FROM json_each(?))
    AND json_extract(wait_spec, '$.kind') = 'delegation' AND json_extract(wait_spec, '$.ref') = ? LIMIT 1`).get(JSON.stringify(facts.waits), ref));
}

/** Citation evidence only. Exists/hash/check/submission preparation stays outside this transaction. */
function implicitCandidates(ctx: StoreContext, turn: Actor): ImplicitSubmissionCandidates {
  const dir = turn.ticket_id ? ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE id = ?").get(turn.ticket_id)?.dir : null;
  const rows = dir ? ctx.db.query<{ path: string; messageId: string; attachmentId: string }, [string, string]>(`SELECT
    a.workspace_relpath AS path, m.id AS messageId, a.id AS attachmentId FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE (m.turn_id = ?1 OR m.source_turn_id = ?1) AND m.author = ?2 AND m.kind = 'bot' ORDER BY m.created_at, a.id`).all(turn.id, turn.bot_id) : [];
  const seen = new Set<string>();
  const candidates = rows.filter((row) => {
    if (!dir || !row.path.startsWith(`${dir}/`) || row.path.includes("\\") || row.path.split("/").some((part) => part === "." || part === "..")
      || isReservedTaskPath(dir, row.path) || seen.has(row.path)) return false;
    seen.add(row.path);
    return true;
  });
  return { implemented: false, candidates, requires: ["exists", "new_content_hash", "bound_checks", "stored_submission"] };
}

function ticketClosed(ctx: StoreContext, ticketId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM tickets t WHERE t.id = ? AND ${STAGE_SQL("t")} IN ('approved', 'dropped')`).get(ticketId));
}

/**
 * A segment that handed its ticket's work over with `submit` ends with it (§5.2: submit ends the
 * segment by default): its work goes idle — closed once the ticket is approved — unless something
 * still holds it open: a line of yours it read and has not answered for, an open request of its
 * own, or a wait. Then it does not end, and the Bot is told why; nothing is counted against it.
 */
export function endAfterSubmit(ctx: StoreContext, turnId: string): { ended: boolean; reason?: string } {
  return ctx.commit(() => {
    const { turn } = actor(ctx, turnId, "done");
    const unacknowledged = turnInbox(ctx, turn.id).filter((mail) => mail.delivered_turn_id === turn.id
      && mail.state === "delivered" && ["user", "annotation"].includes(mail.source)).map(inboxLabel);
    if (unacknowledged.length > 0) return { ended: false, reason: `answer for the user's lines you read first (${unacknowledged.join(", ")}), then end_turn` };
    const facts = obligations(ctx, turn);
    if (facts.outgoingDelegations.length + facts.incomingDelegations.length + facts.waits.length > 0 || facts.tickets.length > 0) {
      return { ended: false, reason: "this work still has open requests, waits or tickets: carry on, or end_turn saying what you wait for" };
    }
    const state = turn.ticket_id && ticketClosed(ctx, turn.ticket_id) ? "closed" : "idle";
    persistEnd(ctx, turn, { obligations: facts, dispositions: { recorded: [], notRecorded: [] }, unacknowledgedInbox: [], replies: [],
      implicitSubmission: implicitCandidates(ctx, turn) }, "done", state);
    return { ended: true };
  });
}

/** Trusted domain writers emit these only for the progress facts in §5.3, not for prose edits. */
export const PROGRESS_KINDS = ["ticket.stage_changed", "part.stage_changed", "submission.created", "review.recorded", "check.first_passed", "artifact.changed"];

function stageSnapshot(ctx: StoreContext, turn: Actor): string {
  const tickets = ctx.db.query<{ id: string; status: string }, [string | null, string | null]>(
    "SELECT id, status FROM tickets WHERE task_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY id").all(turn.task_id, turn.ticket_id);
  const parts = ctx.db.query<{ id: string; stage: string }, [string | null, string | null]>(`SELECT p.id, p.stage FROM ticket_parts p
    JOIN tickets t ON t.id = p.ticket_id WHERE t.task_id = ?1 AND (?2 IS NULL OR t.id = ?2) ORDER BY p.id`).all(turn.task_id, turn.ticket_id);
  return JSON.stringify({ tickets, parts });
}

function stagesChanged(before: unknown, after: string): boolean {
  if (typeof before !== "string") return false;
  const old = JSON.parse(before) as { tickets: Array<{ id: string; status: string }>; parts: Array<{ id: string; stage: string }> };
  const next = JSON.parse(after) as typeof old;
  return old.tickets.some((row) => next.tickets.some((now) => now.id === row.id && now.status !== row.status))
    || old.parts.some((row) => next.parts.some((now) => now.id === row.id && now.stage !== row.stage))
    || next.tickets.some((row) => row.status !== "todo" && !old.tickets.some((previous) => previous.id === row.id))
    || next.parts.some((row) => row.stage !== "todo" && !old.parts.some((previous) => previous.id === row.id));
}

function progressSince(ctx: StoreContext, turn: Actor, afterSeq: number, currentSegment = false): boolean {
  return ctx.db.query<{ n: number }, Array<string | number | null>>(`SELECT COUNT(*) AS n FROM work_events WHERE seq > ?1
    AND kind IN (SELECT value FROM json_each(?2)) AND (?6 = 0 OR turn_id = ?7) AND
      (work_item_id = ?3 OR json_extract(payload, '$.work_item_id') = ?3
        OR (task_id = ?4 AND ?5 IS NOT NULL AND ticket_id = ?5)
        OR (task_id = ?4 AND ?5 IS NULL AND work_item_id IS NULL AND json_extract(payload, '$.work_item_id') IS NULL))`).get(afterSeq,
          JSON.stringify(PROGRESS_KINDS), turn.work_item_id, turn.task_id, turn.ticket_id, currentSegment ? 1 : 0, turn.id)!.n > 0;
}

function noProgressCount(ctx: StoreContext, turn: Actor, unfinished: boolean): number {
  if (!turn.work_item_id || !unfinished || progressSince(ctx, turn, 0, true)) return 0;
  const previous = ctx.db.query<{ seq: number; payload: string }, [string]>(`SELECT seq, payload FROM work_events WHERE kind = 'work.ended'
    AND (work_item_id = ?1 OR json_extract(payload, '$.work_item_id') = ?1) ORDER BY seq DESC LIMIT 1`).get(turn.work_item_id);
  if (!previous) return 1;
  const payload = JSON.parse(previous.payload) as Record<string, unknown>;
  if (payload.reason !== "nothing_new" || payload.state === "waiting" || stagesChanged(payload.stage_snapshot, stageSnapshot(ctx, turn))) return 1;
  const progressed = progressSince(ctx, turn, previous.seq);
  return progressed ? 1 : (typeof payload.no_progress_count === "number" ? payload.no_progress_count : 1) + 1;
}

function persistEnd(ctx: StoreContext, turn: Actor, base: Pick<FinishWorkResult, "obligations" | "dispositions" | "unacknowledgedInbox" | "replies" | "implicitSubmission">,
  endReason: NonNullable<FinishWorkResult["endReason"]>, state: NonNullable<FinishWorkResult["state"]>, count = 0,
  extra: Pick<FinishWorkResult, "ask" | "notice" | "code"> = {}): FinishWorkResult {
  const now = isoNow();
  ctx.db.run("UPDATE turns SET end_reason = ?, updated_at = ? WHERE id = ?", [endReason, now, turn.id]);
  if (turn.work_item_id) ctx.db.run(`UPDATE work_items SET state = ?, updated_at = ?,
    waiting_on = CASE WHEN ? = 'waiting' THEN waiting_on ELSE NULL END,
    closed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END WHERE id = ?`, [state, now, state, state, now, turn.work_item_id]);
  const result: FinishWorkResult = { ended: true, workItemId: turn.work_item_id, ...base, endReason, state, noProgressCount: count, ...extra };
  recordWorkEvent(ctx, { kind: "work.ended", actor: turn.bot_id, botId: turn.bot_id, taskId: turn.task_id,
    ticketId: turn.ticket_id, turnId: turn.id, sessionId: turn.session_id, payload: { work_item_id: turn.work_item_id, reason: endReason, state,
      stage_snapshot: stageSnapshot(ctx, turn), no_progress_count: count, result } });
  return result;
}

function rejectEnd(ctx: StoreContext, turn: Actor, base: Pick<FinishWorkResult, "obligations" | "dispositions" | "unacknowledgedInbox" | "replies" | "implicitSubmission">,
  opts: FinishWorkOptions, code: string, bounce: string): FinishWorkResult {
  const count = ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM work_events WHERE turn_id = ? AND kind = 'end.rejected'").get(turn.id)!.n;
  const filing = ctx.db.query<{ filing_bounces: number }, [string]>("SELECT filing_bounces FROM turns WHERE id = ?").get(turn.id)!.filing_bounces;
  if (Math.max(opts.contractBounces ?? 0, count + filing) >= 2) {
    return persistEnd(ctx, turn, base, "needs_attention", "needs_attention", 0, { code: "contract_budget" });
  }
  recordWorkEvent(ctx, { kind: "end.rejected", actor: "app", botId: turn.bot_id, taskId: turn.task_id,
    ticketId: turn.ticket_id, turnId: turn.id, sessionId: turn.session_id, payload: { work_item_id: turn.work_item_id, code } });
  return { ended: false, workItemId: turn.work_item_id, ...base, code, bounce };
}

/** The no-progress line, in your language, naming the job and the Bot. */
function noProgressNotice(ctx: StoreContext, turn: Actor): string {
  const locale = settingsCached(ctx).locale === "en" ? "en" : "zh";
  const plan = turn.task_id ? ctx.db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(turn.task_id)?.title ?? turn.task_id : "";
  const ticket = turn.ticket_id ? ctx.db.query<{ seq: number; title: string }, [string]>("SELECT seq, title FROM tickets WHERE id = ?").get(turn.ticket_id) ?? null : null;
  const bot = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(turn.bot_id)?.name ?? turn.bot_id;
  return noProgressNoticeBody(locale, { job: supervisorJobLabel(locale, { plan, ticket }), bot });
}

/** The lines of yours this segment read and has not said anything about, each answered by its closing reply. */
function answeredByReply(ctx: StoreContext, turnId: string): Array<{ id: string; disposition: "answered" }> {
  return turnInbox(ctx, turnId).filter((mail) => mail.delivered_turn_id === turnId && mail.state === "delivered"
    && ["user", "annotation"].includes(mail.source)).map((mail) => ({ id: inboxLabel(mail), disposition: "answered" }));
}

export function finishWork(ctx: StoreContext, input: FinishWorkInput, opts: FinishWorkOptions = {}): FinishWorkResult {
  return ctx.commit(() => {
    if (typeof input.reason !== "string" || !["done", "answered", "nothing_new", "blocked", "gave_up"].includes(input.reason)) {
      throw new HttpError(422, "invalid_args", "reason must be done, answered, nothing_new, blocked or gave_up");
    }
    if (opts.contractBounces !== undefined && (!Number.isInteger(opts.contractBounces) || opts.contractBounces < 0)) {
      throw new HttpError(422, "invalid_args", "contractBounces must be a nonnegative integer");
    }
    let reason = input.reason as EndReason;
    const note = optionalText("note", input.note);
    const answer = optionalText("answer", input.answer);
    if (input.answer !== undefined) requireNonEmpty("answer", answer);
    const needsFromUser = optionalText("needsFromUser", input.needsFromUser);
    if (reason === "blocked") requireNonEmpty("needsFromUser", needsFromUser);
    if (reason === "gave_up") requireNonEmpty("note", note);
    const previousEnd = ctx.db.query<{ payload: string }, [string]>("SELECT payload FROM work_events WHERE kind = 'work.ended' AND turn_id = ? ORDER BY seq DESC LIMIT 1").get(input.turnId);
    const declaredMode = ctx.db.query<{ mode: string | null; task_id: string | null }, [string]>("SELECT mode, task_id FROM turns WHERE id = ?").get(input.turnId);
    if (opts.pureText) reason = declaredMode?.mode === "readonly" || declaredMode?.task_id === null ? "answered" : "done";
    const { turn, item } = actor(ctx, input.turnId, reason, previousEnd !== null);
    if (previousEnd) return (JSON.parse(previousEnd.payload) as { result: FinishWorkResult }).result;
    const implicitSubmission = implicitCandidates(ctx, turn);
    // A reply in words is the Bot's answer to the lines of yours it read: they are answered by it,
    // not bounced back for a disposition a pure-text ending has no way to give (ADR 0044).
    const inbox = opts.pureText && input.inbox === undefined ? answeredByReply(ctx, turn.id) : input.inbox;
    const dispositions = disposeInboxItems(ctx, turn.id, inbox);
    const unacknowledgedInbox = turnInbox(ctx, turn.id).filter((mail) => mail.delivered_turn_id === turn.id
      && mail.state === "delivered" && ["user", "annotation"].includes(mail.source)).map(inboxLabel);
    if (dispositions.notRecorded.length || unacknowledgedInbox.length) {
      const code = dispositions.notRecorded.length ? "invalid_inbox_disposition" : "inbox_unacknowledged";
      return rejectEnd(ctx, turn, { obligations: obligations(ctx, turn), dispositions, unacknowledgedInbox, replies: [], implicitSubmission }, opts, code,
        `Record valid dispositions for each user inbox item: ${unacknowledgedInbox.join(", ") || dispositions.notRecorded.map((entry) => entry.id).join(", ")}.`);
    }
    const replies = reason === "answered" && answer && turn.work_item_id
      ? listDelegations(ctx, { toWorkItemId: turn.work_item_id, status: "open" })
        .filter((delegation) => delegation.to_bot_id === turn.bot_id && delegation.expects === "answer")
        .map((delegation) => replyDelegation(ctx, { delegationId: delegation.id, fromTurnId: turn.id, answer })) : [];
    const facts = obligations(ctx, turn);
    const waiting = validWaiting(ctx, item, facts);
    const unfinished = facts.tickets.length + facts.outgoingDelegations.length + facts.incomingDelegations.length + facts.waits.length > 0;
    const base = { obligations: facts, dispositions, unacknowledgedInbox, replies, implicitSubmission };
    const previous = ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM work_events
      WHERE turn_id = ? AND kind = 'end.rejected' AND json_extract(payload, '$.code') = 'unfinished_obligations'`).get(turn.id)!.n;
    if (reason === "done" && unfinished && !waiting && previous === 0) {
      return rejectEnd(ctx, turn, base, opts, "unfinished_obligations",
        `Unfinished obligations: ${[...facts.tickets.map((ticket) => ticket.id), ...facts.outgoingDelegations, ...facts.incomingDelegations, ...facts.waits].join(", ")}. Continue. If you are waiting on another Bot's work, delegate it to that Bot and wait for the reply, or end_turn with reason nothing_new; blocked is only for something the user alone can give, and needs_from_user reaches the user as a question.`);
    }
    const endReason = reason === "done" && unfinished && !waiting ? "nothing_new" : reason;
    // From level 5 the work on a ticket closes only once it is approved or dropped: a hand-over can
    // still come back to rework (§2.6 → closed).
    const completedTicket = turn.ticket_id !== null && facts.tickets.length === 0 && !unfinished
      && (readEngineLevel(ctx.db) < ENGINE_LEVELS.submissions || ticketClosed(ctx, turn.ticket_id));
    const count = endReason === "nothing_new" && !waiting ? noProgressCount(ctx, turn, unfinished) : 0;
    const state = reason === "blocked" || reason === "gave_up" || count >= 2 ? "blocked"
      : waiting ? "waiting" : turn.task_id === null || completedTicket ? "closed" : "idle";
    const result = persistEnd(ctx, turn, base, endReason, state, count, {
      ...(reason === "blocked" ? { ask: { body: needsFromUser! } } : {}),
      ...(reason === "gave_up" ? { notice: { code: "gave_up" as const, body: note! } } : {}),
      ...(count >= 2 ? { notice: { code: "no_progress" as const, body: noProgressNotice(ctx, turn) } } : {}),
    });
    if (reason === "gave_up") recordWorkEvent(ctx, { kind: "quality.gave_up", actor: turn.bot_id, botId: turn.bot_id,
      taskId: turn.task_id, ticketId: turn.ticket_id, turnId: turn.id, payload: { work_item_id: turn.work_item_id, note } });
    return result;
  });
}
