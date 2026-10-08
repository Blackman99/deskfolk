import type { Approval, PendingJudgement, SessionSummary, Turn } from "@real-bot/protocol";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import { classifySession } from "./session-groups.ts";
import { workingSessionIds } from "./session-status.ts";
import { sessionUnreadCount } from "./unread.ts";

const STORAGE_KEY = "real-bot-sidebar-working-only";

/** Whether the session list shows only the conversations a Bot is working in, or with unread messages. */
export function loadWorkingOnly(): boolean {
  return readStored(STORAGE_KEY) === "1";
}

export function saveWorkingOnly(on: boolean): void {
  if (on) writeStored(STORAGE_KEY, "1");
  else forgetStored(STORAGE_KEY);
}

/**
 * What the filter keeps: a conversation a Bot is at work in, and one with messages you have not
 * read. A Bot↔Bot direct counts only while it is working: its row shows no unread, and most of
 * them are never opened, so their unread would bring the whole section back.
 */
export function workingOrUnreadIds(
  sessions: readonly SessionSummary[],
  turns: readonly Turn[],
  approvals: readonly Approval[],
  pendingJudgements: readonly PendingJudgement[] = [],
): Set<string> {
  const ids = workingSessionIds(sessions, turns, approvals, pendingJudgements);
  for (const session of sessions) {
    if (classifySession(session) !== "bot-bot" && sessionUnreadCount(session) > 0) ids.add(session.id);
  }
  return ids;
}

type Listed = {
  groups: SessionSummary[];
  youBot: SessionSummary[];
  botBot: SessionSummary[];
  fileDrop: SessionSummary | null;
};

/**
 * The list's sections cut down to `ids`, or left alone when there is no filter. The pins are not
 * touched: they are a shortcut row, kept whole in the list and in its rail alike. `keepId`, the
 * conversation on screen, stays too: opening an unread row reads it, and the row must not vanish
 * from under the pointer that opened it.
 */
export function onlyWorking<T extends Listed>(
  grouped: T,
  ids: ReadonlySet<string> | null,
  keepId: string | null = null,
): T {
  if (!ids) return grouped;
  const keep = (session: SessionSummary) => ids.has(session.id) || session.id === keepId;
  return {
    ...grouped,
    groups: grouped.groups.filter(keep),
    youBot: grouped.youBot.filter(keep),
    botBot: grouped.botBot.filter(keep),
    fileDrop: grouped.fileDrop && keep(grouped.fileDrop) ? grouped.fileDrop : null,
  };
}
