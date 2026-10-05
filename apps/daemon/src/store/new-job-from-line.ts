/**
 * 「新开一件事」 from a line of yours (2026-10-03): you say a line is not about the job it was filed
 * under but a new one, and the app opens that job from the line — named after it, with a ticket for
 * what it asks — and files the line there, as your correction. The Bots that read it get the
 * correction there and start on it in a segment of their own; one still at work on the old job is
 * told not to act on the line there (see `refileMessage`). Nothing of the old job changes.
 */
import { HttpError } from "../errors";
import { refileMessage, updatePlanDormancy, type RefileMessageResult } from "./filing";
import type { StoreContext } from "./shared";
import { openTask, planTitle } from "./tasks";
import { createTicket } from "./tickets";
import { recordWorkEvent } from "./work-events";

export function newJobFromLine(ctx: StoreContext, messageId: string, input: { title?: string | null; userActionId: string }): RefileMessageResult & { task_id: string } {
  return ctx.commit(() => {
    const line = ctx.db.query<{ id: string; session_id: string; kind: string; author: string; body: string }, [string]>(
      "SELECT id, session_id, kind, author, body FROM messages WHERE id = ?").get(messageId);
    if (!line) throw new HttpError(404, "not_found", "no such message");
    if (line.kind !== "user" || line.author !== "user") throw new HttpError(422, "invalid_args", "only a line of yours opens a new job");
    const said = (input.title ?? "").trim() || line.body.trim();
    if (!said) throw new HttpError(422, "invalid_args", "a line with no words names no job");
    const title = planTitle(ctx, said);
    const task = openTask(ctx, { sessionId: line.session_id, title, brief: line.body });
    // In your direct the one Bot is on it; in a group the lead lays it out.
    const directBots = ctx.db.query<{ member: string }, [string]>(`SELECT p.member FROM sessions s JOIN session_participants p ON p.session_id = s.id
      AND p.left_at IS NULL AND p.member <> 'user' WHERE s.id = ? AND s.kind = 'direct'`).all(line.session_id);
    const ticket = createTicket(ctx, { taskId: task.id, title, spec: line.body, worker: directBots.length === 1 ? directBots[0]!.member : null });
    updatePlanDormancy(ctx, { newTaskId: task.id });
    recordWorkEvent(ctx, { kind: "plan.opened", actor: "user", taskId: task.id, ticketId: ticket.id, sessionId: line.session_id,
      payload: { quote_message_id: line.id, from: "attribution" } });
    const moved = refileMessage(ctx, line.id, { filings: [{ taskId: task.id, ticketId: ticket.id }], userActionId: input.userActionId });
    return { ...moved, task_id: task.id };
  });
}
