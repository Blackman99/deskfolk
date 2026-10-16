import type { SessionSummary } from "@real-bot/protocol";
import { classifySession } from "./session-groups.ts";

/** Depth guard for the walk up the source chain; a real chain never comes close. */
const MAX_ORIGIN_DEPTH = 8;

export type BotDmOrigin =
  /** Opened before sessions recorded a source, so there is nothing to point at. */
  | { kind: "none" }
  /** The source session is gone, or not in this snapshot. */
  | { kind: "missing" }
  | {
      kind: "session";
      session: SessionSummary;
      messageId: string | null;
      /** Bot↔Bot hops between this direct and its source; 0 when the source is a group or you↔Bot. */
      depth: number;
      /** Nearest ancestor you take part in, when the walk reaches one. */
      root: SessionSummary | null;
    };

/**
 * Where a Bot↔Bot direct came from.
 *
 * The click target is always the immediate source, because that is where the triggering message
 * physically lives. When the chain runs back through other directs, the root is reported
 * separately so it can be named in a tooltip rather than pointed at by the link.
 */
export function resolveBotDmOrigin(
  session: SessionSummary,
  byId: ReadonlyMap<string, SessionSummary>,
): BotDmOrigin {
  if (!session.origin_session_id) return { kind: "none" };
  const immediate = byId.get(session.origin_session_id);
  if (!immediate) return { kind: "missing" };

  let root: SessionSummary | null = null;
  let depth = 0;
  let cursor: SessionSummary = immediate;
  const visited = new Set<string>([session.id]);
  while (classifySession(cursor) === "bot-bot") {
    if (visited.has(cursor.id) || depth >= MAX_ORIGIN_DEPTH) {
      cursor = immediate;
      root = null;
      break;
    }
    visited.add(cursor.id);
    depth += 1;
    const next = cursor.origin_session_id ? byId.get(cursor.origin_session_id) : undefined;
    if (!next) break;
    cursor = next;
  }
  if (classifySession(cursor) !== "bot-bot") root = cursor;

  return {
    kind: "session",
    session: immediate,
    messageId: session.entry_message_id ?? session.origin_message_id,
    depth,
    root: root && root.id !== immediate.id ? root : null,
  };
}
