/**
 * Each conversation's line for its row (`latestPreview`'s answer), worked out once for all rows. Each
 * row asked `latestPreview`, which filters and sorts every loaded message, and asked again on every
 * change of the messages or the turns (each streamed token): the work grew with every conversation
 * opened, times the rows on screen.
 */
import { isHiddenTranscriptKind, type Message, type SessionSummary, type Turn } from "@real-bot/protocol";

export type PreviewIndex = {
  /** The first running turn of each conversation, as `latestPreview` finds it. */
  running: Map<string, Turn>;
  /** The newest shown message of each conversation. */
  last: Map<string, Message>;
  /** The newest message of each conversation but a profile change: what its status reads (`sidebarStatus`). */
  settled: Map<string, Message>;
};

/** `latestPreview`'s order: by time, then by id. */
function after(a: { created_at: string; id: string }, b: { created_at: string; id: string }): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id >= b.id;
}

export function previewIndex(messages: readonly Message[], turns: readonly Turn[]): PreviewIndex {
  const running = new Map<string, Turn>();
  for (const turn of turns) if (turn.status === "running" && !running.has(turn.session_id)) running.set(turn.session_id, turn);
  const last = new Map<string, Message>();
  const settled = new Map<string, Message>();
  for (const message of messages) {
    if (message.kind !== "profile_change") {
      const newest = settled.get(message.session_id);
      if (!newest || after(message, newest)) settled.set(message.session_id, message);
    }
    if (isHiddenTranscriptKind(message.kind)) continue;
    const before = last.get(message.session_id);
    if (!before || after(message, before)) last.set(message.session_id, message);
  }
  return { running, last, settled };
}

/** What `latestPreview(messages, session.id, session, turns, limit)` says, read from the index. */
export function previewOf(index: PreviewIndex, session: SessionSummary, limit = 80): string {
  const turn = index.running.get(session.id);
  if (turn?.partial_text) return turn.partial_text.slice(-limit);
  const last = index.last.get(session.id);
  if (last) return last.body.slice(0, limit);
  if (session.last_message && !isHiddenTranscriptKind(session.last_message.kind)) return session.last_message.body.slice(0, limit);
  return "";
}

/** The messages `sidebarStatus` needs of a conversation: its newest but a profile change, or none. */
export function statusMessages(index: PreviewIndex, session: SessionSummary): readonly Message[] {
  const newest = index.settled.get(session.id);
  return newest ? [newest] : [];
}
