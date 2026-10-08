/** Your complaint about delivered work, the rework card it raises, and undoing it. */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { clauseObjects, clausesOf } from "../complaint-words";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import type { ReadingSource } from "../line-reading";
import { queueInboxItem, refreshHeldInbox } from "./inbox";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { emptyPlanSpec, parsePlanSpec } from "./plan-shape";
import { letGoOfCard } from "./review-cards";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import { OPEN_STATES, supervised, toSubmission, yourDirectWith, type SubmissionRow, type SubmissionState } from "./submission-rows";
import { getTask, setTaskSpec } from "./tasks";
import { setTicketStage, settlePlanStage, STAGE_SQL, stagedTicket, ticketStage, type TicketStage } from "./ticket-stage";
import { recordWorkEvent } from "./work-events";
import { queueWork } from "./work-items";

/** Where a complaint can still send work back: handed over, under review, or approved. */
const REWORKABLE: readonly TicketStage[] = ["submitted", "in_review", "approved"];
/** How much of your line a rework card or a calibration record quotes. */
const COMPLAINT_EXCERPT_MAX = 80;

type ReworkBefore = {
  ticket_stage: TicketStage;
  parts: Array<{ key: string; stage: string }>;
  plan_stage: string;
  submissions: Array<{ id: string; state: SubmissionState }>;
};

export type ReworkCardAction = "rework" | "dismiss" | "undo";
const REWORK_CARD_ACTIONS: readonly ReworkCardAction[] = ["rework", "dismiss", "undo"];

function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}

/** The rework cards about one line of yours, by ticket. */
function reworkCards(ctx: StoreContext, messageId: string): Array<{ id: string; ticket_id: string }> {
  return ctx.db.query<{ id: string; ticket_id: string }, [string]>(`SELECT id, json_extract(control, '$.ticket_id') AS ticket_id FROM messages
    WHERE json_extract(control, '$.kind') = 'rework' AND json_extract(control, '$.message_id') = ? ORDER BY created_at, rowid`).all(messageId);
}

/**
 * Your complaint about work already handed over or approved (§6.6, ADR 0046) — only ever asked
 * about, never acted on by itself: what a reading makes of a line is still a reading («收到» in a
 * reply, «别重做了», «C07 很好，比上一版那个错乱的好多了»), so a misreading costs a card, not a
 * rework. A line of yours filed under a ticket (or some of its parts) by the rows or by you — not a
 * Bot's pick; or under a plan as a whole whose handed-over work is one ticket with its maker still here —
 * while that ticket is handed over, in review or approved, asks when one of its clauses
 * objects (`objecting`: the clauses a model read as objecting to the work as it stands, ADR 0055;
 * with no reading, `clauseObjects`: a complaint word, no praise, no redo turned down), when it annotates a
 * file, or when the scribe made a part-level entry of it. The parts asked about are those an
 * objecting clause numbers, or every part it was filed under when an objecting clause numbers none
 * (or the signal was not words). One card per line and ticket; on a refile, a card still asking about
 * a ticket the line is no longer filed under stops asking. Returns the new cards.
 */
export function noteComplaint(
  ctx: StoreContext,
  messageId: string,
  input: { scribeAdded?: readonly string[]; objecting?: { clauses: readonly string[]; source: ReadingSource }; now?: string } = {},
): Message[] {
  return ctx.commit(() => {
    if (!supervised(ctx)) return [];
    const message = ctx.db.query<{ id: string; kind: string; body: string; session_id: string }, [string]>("SELECT id, kind, body, session_id FROM messages WHERE id = ?").get(messageId);
    if (!message || message.kind !== "user") return [];
    const filings = ctx.db.query<{ ticket_id: string; part_key: string | null }, [string]>(`SELECT ticket_id, part_key FROM message_filings
      WHERE message_id = ? AND ticket_id IS NOT NULL AND strength IN ('locked', 'default', 'user') ORDER BY is_primary DESC, rowid`).all(messageId);
    // Filed under a plan as a whole, no ticket (「从头再做一遍，之前的作废」): about its handed-over work,
    // when that is one ticket whose maker is still here. With more, which one is meant is a guess.
    const plans = ctx.db.query<{ task_id: string }, [string]>(`SELECT DISTINCT task_id FROM message_filings
      WHERE message_id = ? AND ticket_id IS NULL AND task_id IS NOT NULL AND strength IN ('locked', 'default', 'user')`).all(messageId).map((row) => row.task_id);
    if (filings.length === 0) {
      for (const taskId of plans) {
        const handed = ctx.db.query<{ id: string }, [string]>(`SELECT t.id FROM tickets t JOIN bots b ON b.id = COALESCE(t.owner_bot_id, t.worker)
          WHERE t.task_id = ? AND ${STAGE_SQL("t")} IN ('submitted', 'in_review', 'approved') AND b.archived_at IS NULL AND b.deleted_at IS NULL`).all(taskId);
        if (handed.length === 1) filings.push({ ticket_id: handed[0]!.id, part_key: null });
      }
    }
    const existing = reworkCards(ctx, messageId);
    for (const card of existing) {
      if (filings.some((filing) => filing.ticket_id === card.ticket_id)) continue;
      const control = getMessage(ctx, card.id).control;
      if (control?.kind === "rework" && plans.includes(control.task_id)) continue;
      if (control?.kind === "rework" && control.offer.includes("rework") && (control.acted ?? []).length === 0) {
        setMessageControl(ctx, card.id, { ...control, offer: [], result: localeOf(ctx) === "en" ? "That line was filed elsewhere since." : "这句话后来改归别处了。" });
      }
    }
    const annotated = Boolean(ctx.db.query("SELECT 1 FROM annotations WHERE message_id = ? AND status <> 'draft'").get(messageId));
    const scribed = (input.scribeAdded ?? []).length > 0
      && Boolean(ctx.db.query("SELECT 1 FROM requirements WHERE scope = 'part' AND id IN (SELECT value FROM json_each(?))").get(JSON.stringify(input.scribeAdded)));
    const objecting = input.objecting ? [...input.objecting.clauses] : clausesOf(message.body).filter(clauseObjects);
    if (!annotated && !scribed && objecting.length === 0) return [];
    // Which parts it is about: the parts it is filed under — what the reading of where it belongs
    // named, an annotation's file, the line it quotes or your own choice (ADR 0057) — never a
    // number picked out of its words.
    const byTicket = new Map<string, { whole: boolean; parts: Set<string> }>();
    for (const filing of filings) {
      const entry = byTicket.get(filing.ticket_id) ?? { whole: false, parts: new Set<string>() };
      if (!filing.part_key) entry.whole = true;
      else entry.parts.add(filing.part_key);
      byTicket.set(filing.ticket_id, entry);
    }
    const now = input.now ?? isoNow();
    const excerpt = truncate(message.body.replace(/\s+/g, " ").trim(), COMPLAINT_EXCERPT_MAX);
    const cards: Message[] = [];
    for (const [ticketId, about] of byTicket) {
      if (existing.some((card) => card.ticket_id === ticketId)) continue;
      if (!about.whole && about.parts.size === 0) continue;
      const ticket = stagedTicket(ctx, ticketId);
      if (!REWORKABLE.includes(ticketStage(ticket))) continue;
      const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(ticket.task_id);
      if (!plan?.session_id) continue;
      const partKeys = about.parts.size > 0 ? [...about.parts].sort() : [];
      const en = localeOf(ctx) === "en";
      const number = String(ticket.seq).padStart(2, "0");
      const what = partKeys.length > 0 ? (en ? ` (${partKeys.join(", ")})` : `（${partKeys.join("、")}）`) : "";
      // The card answers what you just said, so it is where you said it while you can still answer there.
      const place = ctx.db.query(`SELECT 1 FROM sessions s JOIN session_participants u ON u.session_id = s.id AND u.member = 'user'
        AND u.left_at IS NULL WHERE s.id = ? AND s.archived_at IS NULL`).get(message.session_id) ? message.session_id : plan.session_id;
      const card = insertMessage(ctx, {
        sessionId: place, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
        body: en ? `You said "${excerpt}" — send ticket ${number} "${ticket.title}"${what} of ${plan.title} back to rework?`
          : `你说「${excerpt}」——要把 ${plan.title} 的任务 ${number}「${ticket.title}」${what}转回返工吗？`,
        control: { kind: "rework", task_id: ticket.task_id, ticket_id: ticketId, part_keys: partKeys, message_id: messageId, offer: ["rework", "dismiss"] },
      });
      createNotification(ctx, { semantic_key: `rework:${card.id}`, kind: "ask", session_id: place, message_id: card.id, action_state: "open" });
      recordWorkEvent(ctx, { kind: "complaint.asked", actor: "app", taskId: ticket.task_id, ticketId,
        payload: { message_id: messageId, card_id: card.id, parts: partKeys, signal: annotated ? "annotation" : scribed ? "scribe" : input.objecting?.source === "model" ? "reading" : "words", at: now } });
      cards.push(card);
    }
    return cards;
  });
}

/** A delivered plan your complaint reopened: active again, by the path its status always takes. */
function reopenPlan(ctx: StoreContext, taskId: string, now: string): void {
  const task = getTask(ctx, taskId);
  const spec = parsePlanSpec(task.spec) ?? emptyPlanSpec(task.brief ?? task.title);
  setTaskSpec(ctx, taskId, { ...spec, status: "active" }, now);
  ctx.db.run("UPDATE tasks SET stage = 'active', delivered_at = NULL WHERE id = ?", [taskId]);
  recordWorkEvent(ctx, { kind: "plan.reopened", actor: USER_MEMBER, taskId, payload: { by: "complaint" } });
}

/**
 * Your answer on a rework card (§6.6). Rework: the parts it names (else the ticket) go back to
 * rework, a hand-over still waiting is superseded, every review that approved the current hand-over
 * gets a `review.miss` (once per hand-over and reviewer — the reviewer reads it in its calibration
 * record), a delivered plan is active again, and the producer is woken with what you said; the card
 * then offers undo. Refused when the ticket is no longer handed over, in review or approved.
 * Dismiss: nothing moves. Undo: the ticket, its parts, the plan and the superseded hand-overs back
 * where they were, the misses no longer counted — refused once the work has moved on (a newer
 * hand-over, or the ticket out of rework).
 */
export function answerReworkCard(ctx: StoreContext, cardId: string, action: unknown): Message {
  return ctx.commit(() => {
    const card = getMessage(ctx, cardId);
    const control = card.control;
    if (control?.kind !== "rework") throw new HttpError(422, "invalid_args", "this line is not a rework card");
    if (!REWORK_CARD_ACTIONS.includes(action as ReworkCardAction)) throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action as ReworkCardAction)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const now = isoNow();
    const en = localeOf(ctx) === "en";
    if (action === "dismiss") {
      updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "dismiss", true);
      return setMessageControl(ctx, cardId, { ...control, acted: ["dismiss"] });
    }
    if (action === "undo") return undoRework(ctx, cardId, control, now);
    const ticket = stagedTicket(ctx, control.ticket_id);
    const stage = ticketStage(ticket);
    // The work moved on since your line: nothing handed over or approved to send back, or a newer
    // hand-over your line was not about. The card says so instead of acting on the wrong version.
    const saidAt = ctx.db.query<{ created_at: string }, [string]>("SELECT created_at FROM messages WHERE id = ?").get(control.message_id)?.created_at ?? "";
    const newer = Boolean(ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND created_at > ? AND state <> 'superseded'").get(ticket.id, saidAt));
    if (!REWORKABLE.includes(stage) || newer) {
      updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "moved_on", true);
      return setMessageControl(ctx, cardId, { ...control, offer: [], result: newer
        ? (en ? "A newer version was handed over after your line, so nothing was sent back; say it again if it is still wrong." : "这句话之后又交了新的一版，没有转回；新版还有问题就再说一次。")
        : (en ? "It is no longer handed over or approved, so there was nothing to send back." : "它已经不在交付或通过的状态，没有可转回的。") });
    }
    const partKeys = control.part_keys;
    const plan = ctx.db.query<{ session_id: string | null; stage: string | null; status: string }, [string]>(
      "SELECT session_id, stage, status FROM tasks WHERE id = ?").get(ticket.task_id)!;
    const planStage = plan.stage ?? (plan.status === "done" ? "delivered" : "active");
    const parts = partKeys.length > 0
      ? ctx.db.query<{ key: string; stage: string }, [string]>("SELECT key, stage FROM ticket_parts WHERE ticket_id = ? ORDER BY key").all(ticket.id)
        .filter((part) => partKeys.includes(part.key))
      : [];
    const open = ctx.db.query<SubmissionRow, [string, string]>("SELECT * FROM submissions WHERE ticket_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid")
      .all(ticket.id, JSON.stringify(OPEN_STATES)).map(toSubmission);
    const before: ReworkBefore = { ticket_stage: stage, parts, plan_stage: planStage, submissions: open.map((submission) => ({ id: submission.id, state: submission.state })) };
    // A hand-over still waiting is no longer what counts: your complaint is.
    for (const submission of open) {
      ctx.db.run("UPDATE submissions SET state = 'superseded', awaiting = NULL, updated_at = ? WHERE id = ?", [now, submission.id]);
      if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "superseded", by: "complaint" });
    }
    // The reviews that let the current hand-over through missed what you found.
    const said = ctx.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(control.message_id)?.body ?? "";
    const excerpt = truncate(said.replace(/\s+/g, " ").trim(), COMPLAINT_EXCERPT_MAX);
    const approved = ctx.db.query<SubmissionRow, [string]>("SELECT * FROM submissions WHERE ticket_id = ? AND state = 'approved' ORDER BY created_at DESC, rowid DESC")
      .all(ticket.id).map(toSubmission)
      .find((submission) => partKeys.length === 0 || submission.part_keys.length === 0 || submission.part_keys.some((key) => partKeys.includes(key)));
    const misses: string[] = [];
    for (const review of approved?.reviews ?? []) {
      if (review.outcome !== "approve") continue;
      const missed = ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'review.miss' AND json_extract(payload, '$.submission_id') = ?
        AND json_extract(payload, '$.reviewer_bot_id') = ? AND json_extract(payload, '$.undone') IS NULL`).get(approved!.id, review.reviewer_bot_id);
      if (missed) continue;
      recordWorkEvent(ctx, { kind: "review.miss", actor: USER_MEMBER, botId: review.reviewer_bot_id, taskId: ticket.task_id, ticketId: ticket.id,
        payload: { submission_id: approved!.id, reviewer_bot_id: review.reviewer_bot_id, reviewer_model: review.reviewer_model, same_model: review.same_model,
          message_id: control.message_id, card_id: cardId, quote: excerpt, reviewed_at: review.at } });
      misses.push(review.reviewer_bot_id);
    }
    for (const part of parts) {
      if (part.stage === "rework" || part.stage === "waived") continue;
      ctx.db.run("UPDATE ticket_parts SET stage = 'rework' WHERE ticket_id = ? AND key = ?", [ticket.id, part.key]);
      recordWorkEvent(ctx, { kind: "part.stage_changed", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
        payload: { part: part.key, before: part.stage, after: "rework", message_id: control.message_id } });
    }
    setTicketStage(ctx, { ticketId: ticket.id, stage: "rework", source: "user", now });
    if (planStage === "delivered") reopenPlan(ctx, ticket.task_id, now);
    // Its producer hears it and goes back to work on it.
    const producer = ticket.owner_bot_id ?? ticket.worker;
    let producerInbox: number | null = null;
    if (producer && plan.session_id && ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(producer)) {
      const what = partKeys.length > 0 ? (en ? ` (${partKeys.join(", ")})` : `（${partKeys.join("、")}）`) : "";
      producerInbox = queueWork(ctx, { botId: producer, sessionId: yourDirectWith(ctx, card.session_id, producer) ?? plan.session_id, taskId: ticket.task_id, ticketId: ticket.id, messageId: null, author: "app",
        body: en ? `(app) The user sent ticket "${ticket.title}"${what} back to rework, saying: "${excerpt}". Fix that and hand it over again.`
          : `（应用）用户把任务「${ticket.title}」${what}转回返工了，用户说：「${excerpt}」。按这个改好再交。`,
        source: "review", kind: "change", priority: 2, notice: false }).inbox.seq;
      refreshHeldInbox(ctx, { botId: producer });
    }
    recordWorkEvent(ctx, { kind: "complaint.rework", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
      payload: { message_id: control.message_id, card_id: cardId, parts: partKeys, before, misses, superseded: open.map((submission) => submission.id),
        producer: producer ?? null, producer_inbox: producerInbox } });
    updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "rework", true);
    return setMessageControl(ctx, cardId, { ...control, offer: ["undo"], result: en ? "Sent back to rework." : "已转回返工。" });
  });
}

function undoRework(ctx: StoreContext, cardId: string, control: Extract<Message["control"], { kind: "rework" }>, now: string): Message {
  const event = ctx.db.query<{ at: string; payload: string }, [string]>(`SELECT at, payload FROM work_events WHERE kind = 'complaint.rework'
    AND json_extract(payload, '$.card_id') = ? ORDER BY rowid DESC LIMIT 1`).get(cardId);
  if (!event) throw new HttpError(409, "conflict", "there is nothing left to undo");
  const payload = JSON.parse(event.payload) as { message_id: string; before: ReworkBefore; superseded: string[]; producer?: string | null; producer_inbox?: number | null };
  const newer = ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND created_at > ? AND id NOT IN (SELECT value FROM json_each(?))")
    .get(control.ticket_id, event.at, JSON.stringify(payload.superseded));
  if (newer || ticketStage(stagedTicket(ctx, control.ticket_id)) !== "rework") {
    throw new HttpError(409, "moved_on", "the work has moved on since: there is a newer hand-over, or the ticket is no longer in rework");
  }
  const before = payload.before;
  for (const submission of before.submissions) {
    ctx.db.run("UPDATE submissions SET state = ?, awaiting = NULL, updated_at = ? WHERE id = ? AND state = 'superseded'", [submission.state, now, submission.id]);
  }
  for (const part of before.parts) {
    ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ? AND stage = 'rework'", [part.stage, control.ticket_id, part.key]);
  }
  setTicketStage(ctx, { ticketId: control.ticket_id, stage: before.ticket_stage, source: "user", now });
  if (before.plan_stage === "delivered") settlePlanStage(ctx, control.task_id, now);
  ctx.db.run(`UPDATE work_events SET payload = json_set(payload, '$.undone', ?) WHERE kind = 'review.miss'
    AND json_extract(payload, '$.card_id') = ? AND json_extract(payload, '$.undone') IS NULL`, [now, cardId]);
  // The producer's call to rework: dropped if it has not read it yet, else told it is taken back.
  if (payload.producer && payload.producer_inbox !== null && payload.producer_inbox !== undefined) {
    const item = ctx.db.query<{ state: string; work_item_id: string | null; session_id: string | null }, [number]>(
      "SELECT state, work_item_id, session_id FROM inbox_items WHERE seq = ?").get(payload.producer_inbox);
    if (item && (item.state === "queued" || item.state === "held")) {
      ctx.db.run("UPDATE inbox_items SET state = 'superseded', disposition_note = 'the user undid the rework', disposed_at = ? WHERE seq = ?", [now, payload.producer_inbox]);
    } else if (item?.work_item_id && item.session_id) {
      const title = stagedTicket(ctx, control.ticket_id).title;
      queueInboxItem(ctx, { botId: payload.producer, sessionId: item.session_id, turnId: null, workItemId: item.work_item_id, taskId: control.task_id,
        ticketId: control.ticket_id, messageId: null, author: "app", source: "review", kind: "info", priority: 2, wakes: false, now,
        body: localeOf(ctx) === "en" ? `(app) The user took back the rework of "${title}": it stands as before, nothing to change.`
          : `（应用）用户撤销了任务「${title}」的返工：照旧算数，不用改了。` });
    }
    refreshHeldInbox(ctx, { botId: payload.producer });
  }
  recordWorkEvent(ctx, { kind: "complaint.rework_undone", actor: USER_MEMBER, taskId: control.task_id, ticketId: control.ticket_id,
    payload: { message_id: payload.message_id, card_id: cardId } });
  const { result: _done, ...rest } = control;
  return setMessageControl(ctx, cardId, { ...rest, acted: ["undo"] });
}
