import type { Message, Routine, SearchHit, SearchKind, SessionSummary } from "@real-bot/protocol";
import { youBotSession } from "./session-groups.ts";

export type SearchJump = {
  sessionId: string;
  messageId?: string;
} | { botId: string; routineId: string };

export type SearchKindLabels = Record<SearchKind, string>;

export type SearchHitView = {
  kindLabel: string;
  sessionTitle: string | null;
  snippet: string;
};

/** Map a search hit to a session the messenger can open, and the message to land on. */
export function searchJump(hit: SearchHit, sessions: readonly SessionSummary[], routines: readonly Routine[] = []): SearchJump | null {
  if (hit.kind === "routine") {
    const routine = routines.find((row) => row.id === hit.id);
    return routine ? { botId: routine.bot_id, routineId: routine.id } : null;
  }
  if (hit.kind === "session" && hit.id) return { sessionId: hit.id };
  if (hit.kind === "bot") {
    const sessionId =
      hit.session_id ??
      (hit.id ? (youBotSession(sessions as SessionSummary[], hit.id)?.id ?? null) : null);
    return sessionId ? { sessionId } : null;
  }
  if (hit.kind === "message" && hit.session_id && hit.id) {
    return {
      sessionId: hit.session_id,
      messageId: hit.parent_id || hit.id,
    };
  }
  return null;
}

/** Sidebar row for a hit: kind, owning session when there is one, and the snippet. */
export function searchHitView(hit: SearchHit, kindLabels: SearchKindLabels): SearchHitView {
  const snippet = (hit.snippet ?? hit.path ?? hit.kind).trim();
  if (hit.kind === "file" || hit.kind === "routine") {
    return { kindLabel: kindLabels[hit.kind], sessionTitle: null, snippet };
  }
  const sessionTitle = hit.session_title?.trim() || null;
  return { kindLabel: kindLabels[hit.kind], sessionTitle, snippet };
}

export type MessagePage = {
  items: Message[];
  next?: string | null;
};

/** Walk older message pages until the hit is in the loaded window. */
export async function collectUntilMessage(
  loaded: readonly Message[],
  messageId: string,
  nextPage: (cursor: string) => Promise<MessagePage>,
  startCursor: string | null,
): Promise<{ messages: Message[]; next: string | null; found: boolean }> {
  const seen = new Set(loaded.map((m) => m.id));
  const messages = [...loaded];
  if (seen.has(messageId)) {
    return { messages, next: startCursor, found: true };
  }
  let cursor = startCursor;
  let pages = 0;
  while (cursor && pages < 80) {
    pages += 1;
    const page = await nextPage(cursor);
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      messages.push(item);
    }
    cursor = page.next ?? null;
    if (seen.has(messageId)) return { messages, next: cursor, found: true };
    if (page.items.length === 0) break;
  }
  return { messages, next: cursor, found: seen.has(messageId) };
}
