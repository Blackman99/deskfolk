/**
 * A blocked job's question (ADR 0045): what `end_turn({reason:"blocked", needs_from_user})` needs
 * from you, kept as a card that outlives the segment that asked, where you can answer it — where
 * the segment asked, else where you last spoke about the job, else the job's conversation, else its
 * plan's, else your direct with the Bot. It is not a live ask (no turn
 * waits on it) nor an approval. Your answer is a line of yours in the job's inbox: it queues the
 * work again, is held like any line while a stop of yours covers the work, and lifts nothing.
 */
import type { Database } from "bun:sqlite";
import { USER_MEMBER, type Message, type WorkAnswerResult, type WorkQuestionControl } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { queueInboxItem, refreshHeldInbox, getInboxItem } from "./inbox";
import { insertMessage, getMessage, assertUserMayPost } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { recordQuote } from "./quotes";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { requireNonEmpty, type StoreContext } from "./shared";
import { jobConversations } from "./job-conversations";
import { recordWorkEvent } from "./work-events";

type Work = { id: string; bot_id: string; task_id: string | null; ticket_id: string | null; state: string; home_session_id: string; closed_at: string | null; waiting_on: string | null };

function workOf(ctx: StoreContext, id: string): Work {
  const work = ctx.db.query<Work, [string]>("SELECT * FROM work_items WHERE id = ?").get(id);
  if (!work || work.state === "closed" || work.closed_at) throw new HttpError(409, "conflict", "this work is no longer answerable");
  const bot = ctx.db.query<{ archived_at: string | null; deleted_at: string | null }, [string]>("SELECT archived_at, deleted_at FROM bots WHERE id = ?").get(work.bot_id);
  if (!bot || bot.archived_at || bot.deleted_at) throw new HttpError(409, "conflict", "the Bot is no longer available");
  return work;
}

function publicHome(ctx: StoreContext, work: Work, asked: string): string {
  const planHome = work.task_id ? ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(work.task_id)?.session_id : null;
  // Where the Bot asked comes first: a job opened in a group and taken up in your direct asked its
  // 「请拍板」 there, while the card went to the group its work began in (2026-10-04).
  const spoken = work.task_id ? jobConversations(ctx, work.task_id).spoken : [];
  for (const sessionId of [asked, ...spoken, work.home_session_id, planHome]) {
    if (sessionId && ctx.db.query(`SELECT 1 FROM session_participants p JOIN sessions s ON s.id = p.session_id
      WHERE p.session_id = ? AND p.member = 'user' AND p.left_at IS NULL AND s.archived_at IS NULL`).get(sessionId)) return sessionId;
  }
  const direct = ctx.db.query<{ id: string }, [string]>(`SELECT s.id FROM sessions s JOIN session_participants u ON u.session_id = s.id AND u.member = 'user' AND u.left_at IS NULL
    JOIN session_participants b ON b.session_id = s.id AND b.member = ? AND b.left_at IS NULL WHERE s.kind = 'direct' AND s.archived_at IS NULL ORDER BY s.created_at LIMIT 1`).get(work.bot_id);
  if (!direct) throw new HttpError(409, "conflict", "there is no conversation where the user can answer");
  return direct.id;
}

/** The card for a segment that just ended blocked, once per segment; the same question again returns it. */
export function createWorkQuestion(ctx: StoreContext, input: { turnId: string; body: string }): Message {
  return ctx.commit(() => {
    if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) {
      throw new HttpError(409, "work_questions_unavailable", "a blocked job's question is a card from the supervisor's engine level on");
    }
    requireNonEmpty("question", input.body);
    const turn = ctx.db.query<{ id: string; bot_id: string; session_id: string; work_item_id: string | null; task_id: string | null; ticket_id: string | null; end_reason: string | null }, [string]>("SELECT * FROM turns WHERE id = ?").get(input.turnId);
    if (!turn?.work_item_id || turn.end_reason !== "blocked" || !turn.task_id) throw new HttpError(422, "invalid_args", "a question requires a bound blocked segment");
    const work = workOf(ctx, turn.work_item_id);
    if (work.state !== "blocked" || work.bot_id !== turn.bot_id || work.task_id !== turn.task_id || work.ticket_id !== turn.ticket_id) throw new HttpError(409, "conflict", "the blocked work changed");
    const previous = ctx.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE source_turn_id = ? AND json_extract(control, '$.kind') = 'work_question' ORDER BY created_at LIMIT 1").get(turn.id);
    if (previous) {
      const question = getMessage(ctx, previous.id);
      if (question.control?.kind !== "work_question" || question.control.question !== input.body) throw new HttpError(409, "conflict", "question changed for this segment");
      return question;
    }
    const sessionId = publicHome(ctx, work, turn.session_id);
    const control: WorkQuestionControl = { kind: "work_question", work_item_id: work.id, task_id: turn.task_id, ticket_id: turn.ticket_id, question: input.body, offer: [] };
    const message = insertMessage(ctx, { sessionId, turnId: turn.id, sourceTurnId: turn.id, kind: "system", author: work.bot_id, body: input.body,
      hiddenFromBots: true, control });
    ctx.db.run("UPDATE work_items SET waiting_on = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ kind: "user", ref: message.id, since: message.created_at }), isoNow(), work.id]);
    createNotification(ctx, { semantic_key: `work_question:${message.id}`, kind: "ask", session_id: sessionId, message_id: message.id, action_state: "open" });
    recordWorkEvent(ctx, { kind: "work.questioned", actor: work.bot_id, botId: work.bot_id, taskId: work.task_id, ticketId: work.ticket_id, turnId: turn.id, sessionId,
      payload: { work_item_id: work.id, message_id: message.id } });
    return message;
  });
}

/**
 * Your answer, once, with the request id it came with: the same answer under the same id again is
 * a no-op that says how it stands; anything else on an answered card is refused. Only the work's
 * current question, from its blocked segment once that segment has ended, takes an answer.
 */
export function answerWorkQuestion(ctx: StoreContext, messageId: string, input: { body: string; userActionId: string }): WorkAnswerResult {
  return ctx.commit(() => {
    requireNonEmpty("body", input.body);
    requireNonEmpty("userActionId", input.userActionId);
    const message = getMessage(ctx, messageId);
    if (message.control?.kind !== "work_question") throw new HttpError(422, "invalid_args", "this line is not a work question");
    const control = message.control;
    assertUserMayPost(ctx, message.session_id);
    if (control.answer) {
      if (control.answer.user_action_id !== input.userActionId || control.answer.body !== input.body) throw new HttpError(409, "conflict", "this question was already answered");
      const existing = getInboxItem(ctx, control.answer.inbox_seq);
      return { message, work_item_id: control.work_item_id, inbox_state: existing?.state === "held" ? "held" : "queued", answered: false };
    }
    const work = workOf(ctx, control.work_item_id);
    if ([message.session_id, work.home_session_id].some((sessionId) => Boolean(ctx.db.query<{ archived_at: string | null }, [string]>("SELECT archived_at FROM sessions WHERE id = ?").get(sessionId)?.archived_at))) {
      throw new HttpError(409, "conflict", "the work conversation is archived; restore it before answering");
    }
    if (work.bot_id !== message.author || work.task_id !== control.task_id || work.ticket_id !== control.ticket_id) throw new HttpError(409, "conflict", "the question's work changed");
    if (work.state !== "blocked") throw new HttpError(409, "conflict", "this work is no longer waiting for this answer");
    const waiting = work.waiting_on ? JSON.parse(work.waiting_on) as { kind?: string; ref?: string } : null;
    if (waiting?.kind !== "user" || waiting.ref !== message.id) throw new HttpError(409, "conflict", "this is no longer the current question");
    const source = message.source_turn_id ? ctx.db.query<{ work_item_id: string | null; end_reason: string | null; status: string; session_id: string }, [string]>("SELECT work_item_id, end_reason, status, session_id FROM turns WHERE id = ?").get(message.source_turn_id) : null;
    if (!source || source.work_item_id !== work.id || source.end_reason !== "blocked") throw new HttpError(409, "conflict", "the question's blocked source is no longer available");
    if (["running", "waiting_ask", "waiting_approval"].includes(source.status)) throw new HttpError(409, "conflict", "the question's source segment is still ending");
    const now = isoNow();
    // In the conversation the blocked segment ran in, from that segment: a stop over either holds it,
    // wherever the card was answered, and lifting it is what lets the work go on.
    const inbox = queueInboxItem(ctx, { botId: work.bot_id, sessionId: source.session_id, turnId: null, sourceTurnId: message.source_turn_id,
      workItemId: work.id, taskId: work.task_id, ticketId: work.ticket_id, messageId: message.id, author: USER_MEMBER,
      body: input.body, saidIn: message.session_id, source: "user", kind: "result", priority: 1, now });
    refreshHeldInbox(ctx, { botId: work.bot_id });
    recordQuote(ctx, { via: "ask_answer", body: input.body, messageId: message.id, sessionId: message.session_id, taskId: work.task_id, ticketId: work.ticket_id, now });
    updateNotificationActionState(ctx, `work_question:${message.id}`, "resolved", "answered", true);
    const answered: WorkQuestionControl = { ...control, answer: { body: input.body, at: now, user_action_id: input.userActionId, inbox_seq: inbox.seq } };
    ctx.db.run("UPDATE messages SET control = ? WHERE id = ?", [JSON.stringify(answered), message.id]);
    ctx.db.run("UPDATE work_items SET state = 'queued', waiting_on = NULL, updated_at = ? WHERE id = ?", [now, work.id]);
    recordWorkEvent(ctx, { kind: "work.answered", actor: USER_MEMBER, botId: work.bot_id, taskId: work.task_id, ticketId: work.ticket_id, turnId: message.source_turn_id, sessionId: message.session_id,
      payload: { work_item_id: work.id, message_id: message.id, user_action_id: input.userActionId, inbox_seq: inbox.seq } });
    return { message: getMessage(ctx, message.id), work_item_id: work.id, inbox_state: getInboxItem(ctx, inbox.seq)?.state === "held" ? "held" : "queued", answered: true };
  });
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** A card nothing can answer any more says so, in place of its answer box. */
const LAPSE_CARDS = `UPDATE messages SET control = json_set(control, '$.superseded_at', ${NOW_SQL})
  WHERE json_valid(control) AND json_extract(control, '$.kind') = 'work_question'
    AND json_type(control, '$.answer') IS NULL AND json_type(control, '$.superseded_at') IS NULL`;
/** ...and its `ask` no longer counts toward the Dock badge. */
const VOID_SUPERSEDED_ASKS = `UPDATE notifications SET action_state = 'voided', resolution_reason = 'superseded',
  terminal_at = COALESCE(terminal_at, ${NOW_SQL}), revision = revision + 1`;
/** The job is still blocked on this card: `card` is an SQL expression for the card's message id. */
const STILL_WAITING_ON = (card: string) => `EXISTS (SELECT 1 FROM work_items w WHERE w.state = 'blocked' AND json_valid(w.waiting_on)
  AND json_extract(w.waiting_on, '$.kind') = 'user' AND json_extract(w.waiting_on, '$.ref') = ${card})`;

/**
 * A card waits on you only while its job does. Once the job goes on without your answer (another
 * line woke the Bot and its segment ended blocked on something new, or with nothing to ask; the
 * supervisor or a close moved it), the card takes no answer any more: it would still offer a box
 * that refuses what you type, and its `ask` would hold the Dock badge up. Whoever moves the job, an
 * older build sharing the database included. Answering writes the answer and resolves the `ask`
 * before it requeues the job, so that card stays answered.
 */
export const WORK_QUESTION_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "work_question_asks_follow_work",
    sql: `CREATE TRIGGER work_question_asks_follow_work AFTER UPDATE OF state, waiting_on ON work_items
      WHEN OLD.state = 'blocked' AND json_valid(OLD.waiting_on) AND json_extract(OLD.waiting_on, '$.kind') = 'user'
        AND NOT (NEW.state = 'blocked' AND NEW.waiting_on IS OLD.waiting_on)
      BEGIN
        ${LAPSE_CARDS} AND id = json_extract(OLD.waiting_on, '$.ref');
        ${VOID_SUPERSEDED_ASKS}
        WHERE semantic_key = 'work_question:' || json_extract(OLD.waiting_on, '$.ref') AND action_state = 'open';
        UPDATE notification_counters SET val = val + 1 WHERE name = 'cleanup_revision';
      END`,
  },
];

/** The cards a build without the trigger left waiting after their job went on; run on every open, after it. */
export function lapseSupersededWorkQuestions(db: Database): void {
  db.run(`${LAPSE_CARDS} AND control LIKE '%"work_question"%' AND NOT ${STILL_WAITING_ON("messages.id")}`);
  const voided = db.run(`${VOID_SUPERSEDED_ASKS}
    WHERE kind = 'ask' AND action_state = 'open' AND semantic_key LIKE 'work_question:%'
      AND NOT ${STILL_WAITING_ON("substr(notifications.semantic_key, length('work_question:') + 1)")}`);
  if (voided.changes) db.run("UPDATE notification_counters SET val = val + 1 WHERE name = 'cleanup_revision'");
}
