import { USER_MEMBER, type Bot, type SessionParticipant, type SessionSummary } from "@real-bot/protocol";

export type SessionGroup = "group" | "you-bot" | "bot-bot";

export function activeMembers(participants: SessionParticipant[]): string[] {
  return participants.filter((p) => p.left_at === null).map((p) => p.member);
}

export function classifySession(session: SessionSummary): SessionGroup {
  if (session.kind === "group") return "group";
  return activeMembers(session.participants).includes(USER_MEMBER) ? "you-bot" : "bot-bot";
}

export function isSessionArchived(
  session: SessionSummary,
  botsById?: ReadonlyMap<string, Bot>,
): boolean {
  if (Boolean(session.archived_at)) return true;
  if (session.kind === "direct" && botsById) {
    const peer = youBotPeer(session);
    if (peer && Boolean(botsById.get(peer)?.archived_at)) {
      return true;
    }
  }
  return false;
}

export function groupSessions(
  sessions: SessionSummary[],
  pinnedIds?: ReadonlySet<string> | readonly string[],
  aliveBotIds?: ReadonlySet<string>,
  botsById?: ReadonlyMap<string, Bot>,
): {
  pinned: SessionSummary[];
  groups: SessionSummary[];
  youBot: SessionSummary[];
  botBot: SessionSummary[];
} {
  const pinSet = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds ?? []);
  const pinned: SessionSummary[] = [];
  const groups: SessionSummary[] = [];
  const youBot: SessionSummary[] = [];
  const botBot: SessionSummary[] = [];

  for (const session of sessions) {
    if (aliveBotIds) {
      if (session.kind === "direct") {
        const active = activeMembers(session.participants);
        const botMembers = active.filter((m) => m !== USER_MEMBER);
        if (botMembers.some((m) => !aliveBotIds.has(m))) {
          continue;
        }
      }
    }

    if (isSessionArchived(session, botsById)) {
      continue;
    }

    if (pinSet.has(session.id)) {
      pinned.push(session);
      continue;
    }
    const kind = classifySession(session);
    if (kind === "group") groups.push(session);
    else if (kind === "you-bot") youBot.push(session);
    else botBot.push(session);
  }
  return { pinned, groups, youBot, botBot };
}

export function youBotSession(sessions: SessionSummary[], botId: string): SessionSummary | undefined {
  return sessions.find(
    (session) =>
      classifySession(session) === "you-bot" && activeMembers(session.participants).includes(botId),
  );
}

export function youBotPeer(session: SessionSummary): string | null {
  if (classifySession(session) !== "you-bot") return null;
  return activeMembers(session.participants).find((member) => member !== USER_MEMBER) ?? null;
}
