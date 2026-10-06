/**
 * New-plan receipts live on messages; no separate card table or whole-plan merge. The app no longer
 * puts one up (ADR 0058, 2026-10-06): the tag under your line already names the job it opened, and
 * none of the four ever posted was pressed. Cards already out keep their buttons.
 */
import type { ControlActionResult, Hold, Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { isoNow } from "../ids";
import { filingsOfMessage, refileMessage } from "./filing";
import type { StoreContext } from "./shared";
import { settingsCached } from "./settings";
import { recordWorkEvent } from "./work-events";

type OpenedControl = Extract<NonNullable<Message["control"]>, { kind: "plan_opened" }>;

/** Called at the actual effect boundary (also on approved deferred calls), never with arguments. */
export function recordNewPlanEffectStarted(ctx: StoreContext, input: { turnId: string; tool: string; toolCallId?: string }): void {
  ctx.commit(() => {
    const turn = ctx.db.query<{ task_id: string | null; ticket_id: string | null; session_id: string; bot_id: string }, [string]>(
      "SELECT task_id, ticket_id, session_id, bot_id FROM turns WHERE id = ?",
    ).get(input.turnId);
    if (!turn?.task_id || !ctx.db.query(`SELECT 1 FROM messages WHERE json_valid(control)
      AND json_extract(control, '$.kind') = 'plan_opened' AND json_extract(control, '$.task_id') = ?`).get(turn.task_id)) return;
    if (input.toolCallId && ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'plan.effect_started' AND turn_id = ?
      AND json_extract(payload, '$.tool_call_id') = ?`).get(input.turnId, input.toolCallId)) return;
    recordWorkEvent(ctx, { kind: "plan.effect_started", actor: "app", taskId: turn.task_id, ticketId: turn.ticket_id,
      turnId: input.turnId, botId: turn.bot_id, sessionId: turn.session_id, payload: { tool: input.tool, tool_call_id: input.toolCallId ?? null } });
  });
}

/** Finished run evidence plus uncapped start markers across every segment of this job. Failures may have acted. */
function retainedEffects(ctx: StoreContext, taskId: string): string[] {
  const tools = ctx.db.query<{ tool: string }, [string]>(`SELECT tool FROM turn_runs WHERE task_id = ?
    UNION SELECT json_extract(payload, '$.tool') AS tool FROM work_events
      WHERE task_id = ?1 AND kind = 'plan.effect_started'`).all(taskId).map((row) => row.tool);
  return [...new Set(tools)].sort();
}

/** Only the authenticated user-button route supplies this callback; it must hold and stop first. */
export function actNewPlanCard(ctx: StoreContext, messageId: string,
  input: { action: unknown; taskId?: unknown; userActionId: string }, stopNewPlan: (taskId: string) => Hold): ControlActionResult {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "plan_opened" || (input.action !== "undo_plan" && input.action !== "merge_plan")
      || !control.offer.includes(input.action) || !input.userActionId.trim()
      || (input.action === "undo_plan" && input.taskId !== undefined)) {
      throw new HttpError(422, "invalid_args", "choose a new-plan button with a user action id");
    }
    if (control.acted?.length) return { made: [], lifted: [] };
    const source = ctx.db.query<{ session_id: string | null; stage: string }, [string]>(`SELECT session_id,
      COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) AS stage FROM tasks WHERE id = ?`).get(control.task_id);
    if (!source || !["active", "delivered"].includes(source.stage)) {
      throw new HttpError(409, "plan_changed", "the new job has since been accepted or abandoned; use its board instead");
    }
    const targetId = input.action === "merge_plan" && typeof input.taskId === "string" ? input.taskId : null;
    if (input.action === "merge_plan") {
      const target = targetId ? ctx.db.query<{ session_id: string | null; stage: string }, [string]>(`SELECT session_id,
        COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) AS stage FROM tasks WHERE id = ?`).get(targetId) : null;
      if (!target || targetId === control.task_id || !source.session_id || target.session_id !== source.session_id
        || !["active", "delivered"].includes(target.stage) || !control.merge_targets.some((t) => t.task_id === targetId)) {
        throw new HttpError(422, "invalid_args", "choose an existing job offered on this card in the same project");
      }
      const quote = getMessage(ctx, control.quote_message_id);
      if (quote.kind !== "user" || !filingsOfMessage(ctx, quote.id).some((f) => f.taskId === control.task_id)) {
        throw new HttpError(409, "attribution_changed", "the quoted message has already been corrected");
      }
    }
    const hold = stopNewPlan(control.task_id);
    const live = ctx.db.query(`SELECT 1 FROM turns WHERE task_id = ? AND mode IS NOT 'readonly'
      AND status IN ('running', 'waiting_approval', 'waiting_ask') LIMIT 1`).get(control.task_id);
    if (hold.scope !== "plan" || hold.scope_id !== control.task_id || hold.lifted_at || hold.lift_on_next_user_message || live) {
      throw new HttpError(409, "plan_not_stopped", "the new job must be held and stopped before abandoning it");
    }
    const effects = retainedEffects(ctx, control.task_id);
    if (targetId) {
      const filings = filingsOfMessage(ctx, control.quote_message_id).map((f) => f.taskId === control.task_id
        ? { taskId: targetId } : { taskId: f.taskId, ticketId: f.ticketId, partKey: f.partKey });
      refileMessage(ctx, control.quote_message_id, { filings, userActionId: input.userActionId });
    }
    const now = isoNow();
    ctx.db.run(`UPDATE tasks SET stage = 'abandoned', status = 'parked', closed_at = COALESCE(closed_at, ?),
      spec = CASE WHEN json_valid(spec) THEN json_set(spec, '$.status', 'parked') ELSE spec END WHERE id = ?`, [now, control.task_id]);
    setMessageControl(ctx, message.id, { ...control, acted: [input.action], user_action_id: input.userActionId,
      retained_effects: effects, ...(targetId ? { merged_into: targetId } : {}) });
    recordWorkEvent(ctx, { kind: "plan.card_acted", actor: "user", taskId: control.task_id, turnId: control.turn_id,
      sessionId: message.session_id, payload: { message_id: message.id, user_action_id: input.userActionId, action: input.action,
        hold_id: hold.id, retained_effects: effects, artifacts_retained: true } });
    return { made: [hold], lifted: [] };
  });
}

/** A card as builds before 2026-10-06 put one up when a job opened; only tests of cards already out make one now. */
export function createNewPlanCard(ctx: StoreContext, input: { turnId: string; taskId: string; quoteMessageId: string }): Message {
  return ctx.commit(() => {
    const turn = ctx.db.query<{ session_id: string; bot_id: string; task_id: string | null; mode: string | null; created_at: string }, [string]>(
      "SELECT session_id, bot_id, task_id, mode, created_at FROM turns WHERE id = ?",
    ).get(input.turnId);
    const plan = ctx.db.query<{ title: string; session_id: string | null; created_at: string }, [string]>(
      "SELECT title, session_id, created_at FROM tasks WHERE id = ?",
    ).get(input.taskId);
    const quote = getMessage(ctx, input.quoteMessageId);
    const queued = turn?.mode === "desk" && turn.task_id === null
      && filingsOfMessage(ctx, quote.id).some((f) => f.taskId === input.taskId)
      && Boolean(ctx.db.query("SELECT 1 FROM work_items WHERE bot_id = ? AND task_id = ? AND state = 'queued'")
        .get(turn.bot_id, input.taskId));
    if (!turn || !plan || (turn.task_id !== input.taskId && !queued) || quote.kind !== "user" || quote.session_id !== turn.session_id
      || plan.session_id !== quote.session_id || plan.created_at < turn.created_at || plan.created_at < quote.created_at) {
      throw new HttpError(422, "invalid_args", "a new-plan card names its opening turn and a user line in that conversation");
    }
    const previous = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_valid(control)
      AND json_extract(control, '$.kind') = 'plan_opened' AND json_extract(control, '$.task_id') = ? LIMIT 1`).get(input.taskId);
    if (previous) return getMessage(ctx, previous.id);
    const targets = ctx.db.query<{ task_id: string; title: string }, [string | null, string]>(`SELECT id AS task_id, title FROM tasks
      WHERE session_id IS ? AND id <> ? AND routine_id IS NULL
        AND COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) IN ('active', 'delivered')
      ORDER BY created_at DESC, id DESC`).all(plan.session_id, input.taskId);
    const control: OpenedControl = { kind: "plan_opened", task_id: input.taskId, turn_id: input.turnId,
      quote_message_id: input.quoteMessageId, merge_targets: targets, offer: ["undo_plan", "merge_plan"] };
    const card = insertMessage(ctx, { sessionId: turn.session_id, turnId: input.turnId, kind: "system", author: turn.bot_id,
      body: settingsCached(ctx).locale === "en" ? `New job: ${plan.title}` : `新开：${plan.title}`, hiddenFromBots: true, control });
    recordWorkEvent(ctx, { kind: "plan.card_created", actor: "app", taskId: input.taskId, turnId: input.turnId,
      sessionId: turn.session_id, payload: { message_id: card.id, quote_message_id: input.quoteMessageId } });
    return card;
  });
}
