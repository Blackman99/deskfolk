/**
 * Writing a line a live turn hears into `inbox_items` (ADR 0040 P4a). The turn's in-memory list
 * stays the copy the hop reads; the row is the record, with the words kept as they were said.
 *
 * A line that asks something is a question. Everything else is a change: when it is not clear which,
 * treating it as a change only postpones the rest of the hop's calls by one hop, and loses none.
 */
import type { Message } from "@real-bot/protocol";
import type { InboxKind, InboxSource, Store } from "../store";
import type { InboxEntry } from "./types";

const ASKS = /[?？]|(?:吗|么|呢)\s*$/;

export function inboxKindOf(body: string, checkBack: boolean): InboxKind {
  if (checkBack) return "wake";
  return ASKS.test(body.trim()) ? "question" : "change";
}

/** Who the row says it is from, in the terms the table keeps. */
export function inboxSourceOf(message: Message, checkBack: boolean): InboxSource {
  if (checkBack) return "timer";
  if (message.kind === "user") return message.annotation_source_message_id ? "annotation" : "user";
  if (message.kind === "system") return "system";
  return "peer_note";
}

/** 1 for a line of yours, 3 for everything this phase writes. A hand-back is 2, and nothing writes one yet. */
export function inboxPriorityOf(source: InboxSource): number {
  return source === "user" || source === "annotation" ? 1 : 3;
}

/**
 * One row for a line a live turn just took into its inbox. `sessionId` is the conversation the
 * hearing turn runs in, which is where the row is delivered; the line itself may have been said
 * somewhere else.
 */
export function recordHeard(
  store: Store,
  turn: { id: string; bot_id: string; session_id: string; task_id?: string | null; ticket_id?: string | null },
  entry: Omit<InboxEntry, "message"> & { message: Message },
): InboxEntry {
  const source = inboxSourceOf(entry.message, entry.item.checkBack);
  const item = store.queueInboxItem({
    botId: turn.bot_id,
    sessionId: turn.session_id,
    turnId: turn.id,
    taskId: entry.message.task_id ?? turn.task_id ?? null,
    ticketId: entry.message.ticket_id ?? turn.ticket_id ?? null,
    messageId: entry.message.id,
    author: entry.item.author,
    body: entry.item.body,
    saidIn: entry.item.where ?? null,
    source,
    kind: inboxKindOf(entry.item.body, entry.item.checkBack),
    priority: inboxPriorityOf(source),
  });
  return { ...entry, seq: item.seq };
}
