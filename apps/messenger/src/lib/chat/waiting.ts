import type { Approval, Message, Turn } from "@real-bot/protocol";
import { approvalForMessage } from "./approval-card.ts";
import { isPendingAsk } from "./transcript.ts";
import type { TranscriptItem } from "./transcript.ts";

/** A card in this conversation that is waiting on you. */
export type Waiting = { id: string; kind: "approval" | "ask" };

/**
 * The approvals and questions in a transcript that still wait on you, oldest first: what the
 * waiting chip above the composer can jump back to when their cards are out of sight.
 */
export function waitingCards(
  items: readonly TranscriptItem[],
  approvals: readonly Approval[],
  turns: readonly Turn[],
  pendingAskCapable: boolean | undefined,
): Waiting[] {
  const out: Waiting[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    const message: Message = item.message;
    if (message.kind === "approval") {
      if (approvalForMessage(approvals, message)?.status === "pending") out.push({ id: message.id, kind: "approval" });
    } else if (message.kind === "ask") {
      if (!message.ask_answer && isPendingAsk(message, turns, pendingAskCapable)) out.push({ id: message.id, kind: "ask" });
    }
  }
  return out;
}

/**
 * The same, read straight from the snapshot for one conversation: for a pane's header, which has
 * no transcript of its own to read.
 */
export function waitingInSession(
  messages: readonly Message[],
  approvals: readonly Approval[],
  turns: readonly Turn[],
  sessionId: string,
  pendingAskCapable: boolean | undefined,
): Waiting[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.session_id === sessionId && (message.kind === "approval" || message.kind === "ask")) {
      items.push({ type: "message", message });
    }
  }
  return waitingCards(items, approvals, turns, pendingAskCapable);
}
