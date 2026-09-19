import type { Bot, SessionSummary, Turn } from "@real-bot/protocol";
import { classifySession, isSessionArchived } from "../sidebar/session-groups.ts";

/** Bot↔Bot directs opened from a session, keyed by the message each one hangs under. */
export type BotDmIndex = ReadonlyMap<string, SessionSummary[]>;

/**
 * A `create_direct` that went nowhere should not leave a permanent mark in the transcript, so a
 * direct earns its entry only once it has something to show — a message, or a turn still running.
 */
function worthShowing(session: SessionSummary, turns: readonly Turn[]): boolean {
  if (session.last_message) return true;
  return turns.some((turn) => turn.session_id === session.id);
}

/**
 * One pass over the roster instead of a scan per message row: the transcript looks each message
 * up by id while it renders.
 */
export function indexBotDmsByOrigin(
  sessions: readonly SessionSummary[],
  originSessionId: string | null,
  turns: readonly Turn[] = [],
  botsById?: ReadonlyMap<string, Bot>,
): BotDmIndex {
  const index = new Map<string, SessionSummary[]>();
  if (!originSessionId) return index;
  for (const session of sessions) {
    if (session.origin_session_id !== originSessionId) continue;
    if (!session.origin_message_id) continue;
    if (classifySession(session) !== "bot-bot") continue;
    if (isSessionArchived(session, botsById)) continue;
    if (!worthShowing(session, turns)) continue;
    const bucket = index.get(session.origin_message_id);
    if (bucket) bucket.push(session);
    else index.set(session.origin_message_id, [session]);
  }
  // Oldest first: the order the bot opened them.
  for (const bucket of index.values()) {
    bucket.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  }
  return index;
}
