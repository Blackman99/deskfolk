/** Plain pair-thread words are durable mail, never an implicit delegation or wake. */
import type { Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { queueInboxItem, refreshHeldInbox, type InboxItem } from "./inbox";
import { findOrCreateWorkItem } from "./work-items";
import { isPresent } from "./sessions";
import type { StoreContext } from "./shared";

/** Count committed user-visible progress, not answers to labelled questions. */
export function progressMessagesSent(ctx: StoreContext, turnId: string): number {
  return ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM messages m WHERE m.turn_id = ?
    AND m.kind = 'bot' AND m.author <> 'user' AND m.parent_id IS NULL
    AND EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = m.session_id AND p.member = 'user' AND p.left_at IS NULL)`).get(turnId)?.n ?? 0;
}

export function uncitedTurnPaths(ctx: StoreContext, turnId: string, paths: readonly string[]): string[] {
  const cited = new Set(ctx.db.query<{ path: string }, [string]>(`SELECT a.workspace_relpath AS path FROM attachments a
    JOIN messages m ON m.id = a.message_id WHERE m.turn_id = ? AND m.kind = 'bot'`).all(turnId).map((row) => row.path));
  return paths.filter((path) => !cited.has(path));
}

export function recordPeerNote(ctx: StoreContext, message: Message, toBotId: string): InboxItem {
  return ctx.commit(() => {
    const session = ctx.db.query<{ kind: string; thread_task_id: string | null }, [string]>("SELECT kind, thread_task_id FROM sessions WHERE id = ?").get(message.session_id);
    if (!session || session.kind !== "direct" || isPresent(ctx, message.session_id, "user")
      || !isPresent(ctx, message.session_id, message.author) || !isPresent(ctx, message.session_id, toBotId)) {
      throw new HttpError(422, "invalid_args", "a peer note belongs to its actual Bot pair thread");
    }
    const taskId = session.thread_task_id ?? message.task_id ?? null;
    const live = ctx.db.query<{ id: string; work_item_id: string | null; ticket_id: string | null }, [string, string | null]>(
      "SELECT id, work_item_id, ticket_id FROM turns WHERE bot_id = ? AND task_id IS ? AND status IN ('running','waiting_ask','waiting_approval') AND mode <> 'readonly' ORDER BY created_at LIMIT 1",
    ).get(toBotId, taskId);
    const item = live?.work_item_id ?? findOrCreateWorkItem(ctx, { botId: toBotId, sessionId: message.session_id,
      taskId, ticketId: message.ticket_id ?? null }).id;
    if (!live) ctx.db.run("UPDATE work_items SET state = 'idle' WHERE id = ? AND state = 'running'", [item]);
    const note = queueInboxItem(ctx, { botId: toBotId, sessionId: message.session_id, turnId: live?.id ?? null,
      workItemId: item, taskId, ticketId: message.ticket_id ?? null, messageId: message.id, author: message.author,
      body: message.body, source: "peer_note", kind: "info", priority: 3, wakes: false });
    refreshHeldInbox(ctx, { botId: toBotId });
    return note;
  });
}
