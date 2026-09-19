import type { SessionSummary } from "@real-bot/protocol";
import { classifySession } from "./session-groups.ts";

/** How many Bot↔Bot directs the sidebar keeps on show before the rest fold away. */
export const BOT_DM_VISIBLE = 5;

/** Depth guard for the walk up the source chain; a real chain never comes close. */
const MAX_ORIGIN_DEPTH = 8;

/**
 * When a Bot↔Bot direct was last actually talked in.
 *
 * Deliberately not `updated_at`: that is also written by marking a session read, renaming,
 * archiving and membership changes, so merely opening one to look at it would float it to the
 * top of a list whose whole point is recent activity. `created_at` covers the gap between a
 * direct being opened and its first message landing.
 */
export function botDmRecency(session: SessionSummary): string {
  const last = session.last_message?.created_at ?? "";
  return last > session.created_at ? last : session.created_at;
}

/**
 * The most recently active directs, newest first.
 *
 * `keepId` is held in even when it falls past the cap, so the one you are reading does not
 * vanish from the sidebar while you read it.
 */
export function recentBotDms(
  botBot: readonly SessionSummary[],
  opts: { limit?: number; keepId?: string | null; expanded?: boolean } = {},
): SessionSummary[] {
  const limit = opts.limit ?? BOT_DM_VISIBLE;
  const sorted = [...botBot].sort((a, b) => {
    const left = botDmRecency(a);
    const right = botDmRecency(b);
    if (left !== right) return left < right ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  if (opts.expanded) return sorted;
  const shown = sorted.slice(0, limit);
  if (opts.keepId && !shown.some((s) => s.id === opts.keepId)) {
    const kept = sorted.find((s) => s.id === opts.keepId);
    if (kept) shown.push(kept);
  }
  return shown;
}

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
    messageId: session.origin_message_id,
    depth,
    root: root && root.id !== immediate.id ? root : null,
  };
}
