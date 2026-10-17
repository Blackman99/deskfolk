import type { Approval, Bot, PendingJudgement, SessionSummary, Turn } from "@real-bot/protocol";
import { isLiveStatus } from "../chat/transcript.ts";
import { activeMembers, classifySession, youBotPeer } from "./session-groups.ts";
import { isWorkingStatus, sessionStatus, type SessionStatusResult, type StatusLabels } from "./session-status.ts";
import { sessionTitle, type RosterLabels } from "./session-title.ts";

/** One conversation a Bot is at work in, with how it stands there. */
export type WorkPlace = {
  session: SessionSummary;
  status: SessionStatusResult;
  /** When its earliest open turn there began, for the order. */
  since: string;
  /** In a Bot↔Bot direct, the other Bot: the place is named by who it talks with. */
  with: string | null;
};

/**
 * Where a Bot is at work besides `here`: the answer to an avatar that says it is busy while the
 * conversation on screen is quiet. A place waiting on you comes first, then the longest running.
 */
export function botWorkPlaces(
  botId: string,
  here: string | null,
  sessions: readonly SessionSummary[],
  turns: readonly Turn[],
  approvals: readonly Approval[],
  labels: StatusLabels,
  pendingJudgements: readonly PendingJudgement[] = [],
): WorkPlace[] {
  const botTurns = turns.filter((turn) => turn.bot_id === botId);
  const botJudgements = pendingJudgements.filter((j) => j.bot_id === botId);
  const since = new Map<string, string>();
  for (const turn of botTurns) {
    if (!isLiveStatus(turn.status)) continue;
    const at = since.get(turn.session_id);
    if (!at || turn.created_at < at) since.set(turn.session_id, turn.created_at);
  }
  for (const j of botJudgements) {
    const at = since.get(j.session_id);
    if (!at || j.created_at < at) since.set(j.session_id, j.created_at);
  }
  const places: WorkPlace[] = [];
  for (const session of sessions) {
    if (session.id === here || !since.has(session.id)) continue;
    const status = sessionStatus(session.id, botTurns, approvals, labels, botJudgements);
    if (!isWorkingStatus(status.kind)) continue;
    const other = classifySession(session) === "bot-bot"
      ? (activeMembers(session.participants).find((member) => member !== botId) ?? null)
      : null;
    places.push({ session, status, since: since.get(session.id)!, with: other });
  }
  const waiting = (place: WorkPlace) => (place.status.isBusy ? 1 : 0);
  return places.sort((a, b) => waiting(a) - waiting(b) || a.since.localeCompare(b.since));
}

export type ElsewhereWords = {
  /** "在群「x」· 回复中" */
  at: (place: string, status: string) => string;
  alsoAt: (place: string, status: string) => string;
  many: (count: number) => string;
  alsoMany: (count: number) => string;
  group: (name: string) => string;
  direct: (name: string) => string;
  other: (name: string) => string;
};

/** A place's name as the line says it: a group marked as one, a Bot↔Bot direct by the other Bot. */
export function workPlaceName(
  place: WorkPlace,
  bots: ReadonlyMap<string, Bot>,
  roster: RosterLabels,
  words: Pick<ElsewhereWords, "group" | "direct" | "other">,
): string {
  if (place.with) return words.direct(bots.get(place.with)?.name ?? roster.deleted);
  const title = sessionTitle(place.session, bots, roster);
  return classifySession(place.session) === "group" ? words.group(title) : words.other(title);
}

/**
 * The one line that says where else it works: the place and its status when there is one, a
 * count when there are more. `alsoHere` when it is at work in the conversation on screen too.
 */
export function elsewhereLine(
  places: readonly WorkPlace[],
  alsoHere: boolean,
  bots: ReadonlyMap<string, Bot>,
  roster: RosterLabels,
  words: ElsewhereWords,
): string | null {
  if (places.length === 0) return null;
  if (places.length > 1) return alsoHere ? words.alsoMany(places.length) : words.many(places.length);
  const name = workPlaceName(places[0], bots, roster, words);
  return alsoHere ? words.alsoAt(name, places[0].status.label) : words.at(name, places[0].status.label);
}

/** What the list and the rail need of the snapshot to say it. */
export type WorkSnapshot = {
  sessions: readonly SessionSummary[];
  turns: readonly Turn[];
  approvals: readonly Approval[];
  pendingJudgements: readonly PendingJudgement[];
};

/** For your direct with a Bot: where else that Bot is at work, or nothing. */
export function directElsewhere(
  session: SessionSummary,
  alsoHere: boolean,
  snapshot: WorkSnapshot,
  bots: ReadonlyMap<string, Bot>,
  labels: StatusLabels,
  roster: RosterLabels,
  words: ElsewhereWords,
): string | null {
  const peer = classifySession(session) === "you-bot" ? youBotPeer(session) : null;
  if (!peer) return null;
  const places = botWorkPlaces(peer, session.id, snapshot.sessions, snapshot.turns, snapshot.approvals, labels, snapshot.pendingJudgements);
  return elsewhereLine(places, alsoHere, bots, roster, words);
}
