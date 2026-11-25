import type { Approval, PendingJudgement, SessionSummary, Turn } from "@real-bot/protocol";
import { isLiveStatus } from "../chat/transcript.ts";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import { classifySession, isConsultantSession, youBotPeer } from "./session-groups.ts";
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
  liveRunSessionIds: Iterable<string> = [],
): Set<string> {
  const ids = workingSessionIds(sessions, turns, approvals, pendingJudgements);
  // Bot↔Bot directs are never listed in the sidebar (ADR 0091): surface each active Bot's own
  // you↔Bot direct instead so its "在和「…」私聊 · 思考中" row stays visible under the filter.
  const workingBotBotIds = new Set<string>();
  for (const session of sessions) {
    if (classifySession(session) === "bot-bot" && ids.has(session.id)) workingBotBotIds.add(session.id);
  }
  if (workingBotBotIds.size > 0) {
    const pendingApprovalTurns = new Set(approvals.filter((a) => a.status === "pending").map((a) => a.turn_id));
    const busyBots = new Set<string>();
    for (const turn of turns) {
      if (workingBotBotIds.has(turn.session_id) && (isLiveStatus(turn.status) || pendingApprovalTurns.has(turn.id))) {
        busyBots.add(turn.bot_id);
      }
    }
    for (const j of pendingJudgements) {
      if (workingBotBotIds.has(j.session_id)) busyBots.add(j.bot_id);
    }
    for (const session of sessions) {
      const peer = youBotPeer(session);
      if (peer && busyBots.has(peer)) ids.add(session.id);
    }
  }
  // A project session has no turns: its run says whether the agent is at work.
  for (const id of liveRunSessionIds) ids.add(id);
  for (const session of sessions) {
    if (classifySession(session) !== "bot-bot" && sessionUnreadCount(session) > 0) ids.add(session.id);
  }
  // A consultant is never a row, working or not (ADR 0116).
  for (const session of sessions) if (isConsultantSession(session)) ids.delete(session.id);
  return ids;
}

type Listed = {
  bots: SessionSummary[];
  botBot: SessionSummary[];
  project: SessionSummary[];
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
    bots: grouped.bots.filter(keep),
    botBot: grouped.botBot.filter(keep),
    project: grouped.project.filter(keep),
    fileDrop: grouped.fileDrop && keep(grouped.fileDrop) ? grouped.fileDrop : null,
  };
}
