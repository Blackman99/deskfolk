/**
 * work_on's durable state transition (ADR 0040 §2.8/§8.4). Tool adapters only decode this result;
 * they never write SQL or publish a card before the selection, binding and work log commit.
 */
import { parseMentions, type Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { assertDeskCandidate, originalUserRequest } from "./desk";
import { fileMessage, updatePlanDormancy } from "./filing";
import { holdsCovering } from "./holds";
import { queueInboxItem } from "./inbox";
import { getMessage } from "./messages";
import { createNewPlanCard } from "./new-plan-cards";
import { readEngineLevel, ENGINE_LEVELS } from "./schema-gate";
import type { StoreContext } from "./shared";
import { getTask, openTask } from "./tasks";
import { createTicket, getTicket } from "./tickets";
import { getTurn, listLiveTurns } from "./turns";
import { recordWorkEvent } from "./work-events";
import { closeWorkItemIfIdle, findOrCreateWorkItem, queuePlace, queueWork } from "./work-items";

export type WorkOnInput = {
  turnId: string;
  plan: unknown;
  ticket?: unknown;
  also?: unknown;
  /** Additional in-flight evidence not yet represented by persisted directory-use/run markers. */
  writtenPaths?: readonly string[];
};
export type WorkOnResult = {
  taskId?: string;
  ticketId?: string | null;
  workItemId?: string;
  mergedInto?: string;
  queued?: boolean;
  ended?: boolean;
  messages: Message[];
  /** Your line this call filed under the job, for the scribe to read against it (ADR 0040 P3). */
  filed: string[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * A new job's title without the Bots it names: 「@Alpha 做一个 logo」 opens 「做一个 logo」. A title
 * that is nothing but names keeps them.
 */
export function planTitle(ctx: StoreContext, said: string): string {
  const roster = ctx.db.query<{ name: string }, []>("SELECT name FROM bots WHERE deleted_at IS NULL").all().map((row) => row.name);
  const spans = parseMentions(said, roster).spans.filter((span) => span.kind !== "unresolved");
  let title = said;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) title = `${title.slice(0, span.start)} ${title.slice(span.end)}`;
  title = title.replace(/\s+/g, " ").replace(/^[\s,，、:：]+/, "").trim();
  return title || said;
}

/** Every refusal throws, so a new plan/ticket created earlier in the transaction never leaks. */
export function workOn(ctx: StoreContext, input: WorkOnInput): WorkOnResult {
  return ctx.commit(() => {
    const turn = getTurn(ctx, input.turnId);
    if (turn.status !== 'running') throw new HttpError(409, 'turn_ended', 'this segment is no longer running');
    const trigger = originalUserRequest(ctx, turn.id) ?? getMessage(ctx, turn.trigger_message_id);
    if (turn.mode === "readonly") throw new HttpError(409, "held", "a read-only answer cannot take work on");
    const fresh = object(object(input.plan)?.new);
    let taskId: string;
    let quote: Message | null = null;
    if (typeof input.plan === "string") {
      if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items) assertDeskCandidate(ctx, turn.id, input.plan);
      const task = getTask(ctx, input.plan);
      const state = ctx.db.query<{ stage: string }, [string]>(`SELECT COALESCE(stage,
        CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) AS stage FROM tasks WHERE id = ?`).get(task.id);
      if (!state || !['active', 'delivered'].includes(state.stage)) {
        throw new HttpError(409, 'plan_changed', 'this captured job is no longer runnable');
      }
      taskId = task.id;
    } else if (fresh) {
      quote = typeof fresh.quote_message_id === "string" ? getMessage(ctx, fresh.quote_message_id) : null;
      if (!quote || quote.kind !== "user" || quote.author !== "user" || quote.session_id !== trigger.session_id) {
        throw new HttpError(422, "invalid_args", "a new job quotes a user line from this turn's conversation");
      }
      const used = ctx.db.query<{ n: number }, [string]>("SELECT work_dir_changes AS n FROM turns WHERE id = ?").get(turn.id)?.n ?? 0;
      const ran = Boolean(ctx.db.query("SELECT 1 FROM turn_runs WHERE turn_id = ? LIMIT 1").get(turn.id));
      if (turn.task_id && (used > 0 || (input.writtenPaths?.length ?? 0) > 0 || ran)) {
        throw new HttpError(409, "work_dir_fixed", "this working segment already acted in its directory; open the other job in a separate segment");
      }
      taskId = openTask(ctx, { sessionId: quote.session_id,
        title: planTitle(ctx, typeof fresh.title === "string" && fresh.title.trim() ? fresh.title : quote.body), brief: quote.body }).id;
      // A new job in a conversation puts its older jobs nobody is on to sleep (ADR 0040 §2.6 ②).
      updatePlanDormancy(ctx, { newTaskId: taskId });
    } else {
      throw new HttpError(422, "invalid_args", "plan is a candidate job id or {new:{title, quote_message_id}}");
    }

    let ticketId: string | null = null;
    const newTicket = object(object(input.ticket)?.new);
    if (typeof input.ticket === "string") {
      const ticket = getTicket(ctx, input.ticket);
      if (ticket.task_id !== taskId) throw new HttpError(422, "invalid_args", "the ticket belongs to another job");
      ticketId = ticket.id;
    } else if (newTicket || (fresh && (input.ticket === undefined || input.ticket === null))) {
      const task = getTask(ctx, taskId);
      ticketId = createTicket(ctx, { taskId, title: typeof newTicket?.title === "string" ? newTicket.title : task.title,
        spec: typeof newTicket?.deliverable === "string" ? newTicket.deliverable : trigger.body, worker: turn.bot_id }).id;
    } else if (input.ticket !== undefined && input.ticket !== null) {
      throw new HttpError(422, "invalid_args", "ticket is an id or {new:{title,deliverable}}");
    } else if (turn.task_id === taskId) {
      ticketId = turn.ticket_id ?? null;
    }
    if (holdsCovering(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId, ticketId, turnId: turn.id }).length) {
      throw new HttpError(409, "held", "a stop of yours covers this work");
    }

    const others: Array<{ taskId: string; ticketId: string | null }> = [];
    if (input.also !== undefined) {
      if (!Array.isArray(input.also) || input.also.some((id) => typeof id !== "string")) {
        throw new HttpError(422, "invalid_args", "also lists work-item ids");
      }
      for (const id of input.also) {
        const item = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null }, [string]>(
          "SELECT bot_id, task_id, ticket_id FROM work_items WHERE id = ? AND state <> 'closed'").get(id);
        if (!item?.task_id || item.bot_id !== turn.bot_id) throw new HttpError(422, "invalid_args", "also names another Bot's or a closed work item");
        assertDeskCandidate(ctx, turn.id, item.task_id);
        others.push({ taskId: item.task_id, ticketId: item.ticket_id });
      }
    }
    // Another ticket of the same job is open to a segment that has done nothing yet — no file, no
    // command, its directory unused — as a new job is (I8: the directory changes once, before any
    // effect). A lead woken with the slogans in could not go on to its own poster, and waited minutes
    // for the supervisor to open a segment on it (2026-10-03).
    if (!fresh && turn.task_id && (turn.task_id !== taskId || turn.ticket_id !== ticketId)) {
      const used = ctx.db.query<{ n: number }, [string]>("SELECT work_dir_changes AS n FROM turns WHERE id = ?").get(turn.id)?.n ?? 0;
      const ran = Boolean(ctx.db.query("SELECT 1 FROM turn_runs WHERE turn_id = ? LIMIT 1").get(turn.id));
      const acted = used > 0 || (input.writtenPaths?.length ?? 0) > 0 || ran;
      // From the whole job down to one of its own tickets is no move to another directory: what the
      // segment did, it did in the job, which holds the ticket. A lead woken at the job's level by
      // your change after a stop made the poster, then could neither submit (no ticket) nor bind to
      // its ticket, and gave up with the job undelivered (2026-10-04, real-model run).
      const narrowing = turn.task_id === taskId && turn.ticket_id === null && ticketId !== null;
      if (turn.task_id !== taskId || (acted && !narrowing)) {
        throw new HttpError(409, "work_dir_fixed", "this segment's working directory is already bound");
      }
    }
    const busy = listLiveTurns(ctx, { botId: turn.bot_id }).find((row) => row.id !== turn.id && row.task_id === taskId && row.mode !== "readonly");
    const filedLine = quote ?? trigger;
    fileMessage(ctx, filedLine.id, { botId: turn.bot_id, botSelection: [{ taskId, ticketId }, ...others] });
    const filed = filedLine.kind === "user" ? [filedLine.id] : [];
    if (busy) {
      ctx.db.run("UPDATE turns SET end_reason = 'merged' WHERE id = ?", [turn.id]);
      queueInboxItem(ctx, { botId: turn.bot_id, sessionId: busy.session_id, turnId: busy.id, taskId, ticketId,
        messageId: trigger.id, author: trigger.author, body: trigger.body, source: trigger.author === "user" ? "user" : "system",
        kind: "change", priority: trigger.author === "user" ? 1 : 3 });
      recordWorkEvent(ctx, { kind: "work.merged", actor: turn.bot_id, taskId, turnId: turn.id, payload: { into: busy.id } });
      return { mergedInto: busy.id, ended: true, messages: [], filed };
    }
    if (queuePlace(ctx, { botId: turn.bot_id, taskId }) !== null && turn.task_id !== taskId) {
      const queued = queueWork(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId, ticketId,
        messageId: quote?.id ?? trigger.id, author: trigger.author, body: (quote ?? trigger).body });
      const messages = queued.message ? [queued.message] : [];
      if (fresh) messages.push(createNewPlanCard(ctx, { turnId: turn.id, taskId, quoteMessageId: quote!.id }));
      ctx.db.run("UPDATE turns SET end_reason = 'queued' WHERE id = ?", [turn.id]);
      return { ended: true, queued: true, taskId, ticketId, workItemId: queued.workItem.id, messages, filed };
    }
    const previousItem = turn.work_item_id;
    ctx.db.run(`UPDATE turns SET task_id = ?, ticket_id = ?, work_item_id = NULL, mode = 'work',
      work_dir_changes = work_dir_changes + CASE WHEN task_id IS NULL OR task_id <> ? THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?`,
      [taskId, ticketId, taskId, isoNow(), turn.id]);
    const item = findOrCreateWorkItem(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId, ticketId });
    ctx.db.run("UPDATE turns SET work_item_id = ? WHERE id = ?", [item.id, turn.id]);
    if (previousItem && previousItem !== item.id) closeWorkItemIfIdle(ctx, previousItem);
    recordWorkEvent(ctx, { kind: fresh ? "plan.opened" : "work.bound", actor: turn.bot_id, taskId, ticketId, turnId: turn.id,
      sessionId: turn.session_id, payload: { quote_message_id: quote?.id ?? null, also: others } });
    const messages = fresh ? [createNewPlanCard(ctx, { turnId: turn.id, taskId, quoteMessageId: quote!.id })] : [];
    return { taskId, ticketId, workItemId: item.id, messages, filed };
  });
}
