import {
  isHiddenTranscriptKind,
  type Message,
  type PendingJudgement,
  type SessionKind,
  type SessionSummary,
  type Turn,
  type TurnStatus,
} from "@real-bot/protocol";

export type ReplyingEntry = {
  bot_id: string;
  created_at: string;
  source: "turn" | "judgement";
  turn_id?: string;
  judgement_id?: string;
};

export type TranscriptItem =
  | { type: "message"; message: Message; replying?: ReplyingEntry[] }
  | { type: "streaming"; turn: Turn }
  | { type: "replying"; trigger_message_id: string; entries: ReplyingEntry[] };

export function isLiveStatus(status: TurnStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_ask";
}

export function transcriptItemKey(item: TranscriptItem): string {
  if (item.type === "message") return item.message.id;
  if (item.type === "streaming") return item.turn.id;
  return `replying-${item.trigger_message_id}`;
}

export function composeTranscript(
  messages: readonly Message[],
  turns: readonly Turn[],
  sessionId: string,
  pendingJudgements: readonly PendingJudgement[] = [],
): TranscriptItem[] {
  const main = messages
    .filter(
      (m) =>
        m.session_id === sessionId && m.parent_id === null && !isHiddenTranscriptKind(m.kind),
    )
    .slice()
    .sort(byTime);
  const items: TranscriptItem[] = main.map((message) => ({ type: "message", message }));
  const running = turns
    .filter((turn) => turn.session_id === sessionId && turn.status === "running")
    .slice()
    .sort(byTime);
  for (const turn of running) {
    if (!hasStreamedText(turn)) continue;
    const stream: TranscriptItem = { type: "streaming", turn };
    const at = lastIndexForTrigger(items, turn.trigger_message_id, turn.id);
    if (at >= 0) items.splice(at + 1, 0, stream);
    else items.push(stream);
  }

  const occupied = new Set(
    running.map((turn) => occupancyKey(turn.trigger_message_id, turn.bot_id)),
  );
  const byTrigger = new Map<string, ReplyingEntry[]>();

  function addEntry(trigger: string, entry: ReplyingEntry): void {
    const list = byTrigger.get(trigger) ?? [];
    if (list.some((existing) => existing.bot_id === entry.bot_id)) return;
    list.push(entry);
    byTrigger.set(trigger, list);
  }

  for (const turn of running) {
    if (hasStreamedText(turn)) continue;
    addEntry(turn.trigger_message_id, {
      bot_id: turn.bot_id,
      created_at: turn.created_at,
      source: "turn",
      turn_id: turn.id,
    });
  }

  for (const pending of pendingJudgements) {
    if (pending.session_id !== sessionId) continue;
    if (occupied.has(occupancyKey(pending.message_id, pending.bot_id))) continue;
    addEntry(pending.message_id, {
      bot_id: pending.bot_id,
      created_at: pending.created_at,
      source: "judgement",
      judgement_id: pending.id,
    });
  }

  const triggers = [...byTrigger.keys()].sort((a, b) => {
    const left = byTrigger.get(a)![0];
    const right = byTrigger.get(b)![0];
    return byTime(
      { created_at: left.created_at, id: a },
      { created_at: right.created_at, id: b },
    );
  });
  for (const trigger of triggers) {
    const entries = byTrigger
      .get(trigger)!
      .slice()
      .sort((a, b) =>
        byTime({ created_at: a.created_at, id: a.bot_id }, { created_at: b.created_at, id: b.bot_id }),
      );
    const block: TranscriptItem = { type: "replying", trigger_message_id: trigger, entries };
    const at = lastIndexForTrigger(items, trigger);
    if (at >= 0) items.splice(at + 1, 0, block);
    else items.push(block);
  }
  return items;
}

function hasStreamedText(turn: Turn): boolean {
  return Boolean(turn.partial_text?.trim());
}

function occupancyKey(triggerId: string, botId: string): string {
  return `${triggerId}\0${botId}`;
}

export function isPendingAsk(message: Message, turns: readonly Turn[]): boolean {
  if (message.kind !== "ask" || !message.turn_id) return false;
  return turns.some((turn) => turn.id === message.turn_id && turn.status === "waiting_ask");
}

export function latestPreview(
  messages: readonly Message[],
  sessionId: string,
  session?: SessionSummary | null,
  liveTurns?: readonly Turn[],
): string {
  const runningTurn = liveTurns?.find(
    (turn) => turn.session_id === sessionId && turn.status === "running",
  );
  if (runningTurn?.partial_text) {
    return runningTurn.partial_text.slice(-80);
  }
  const last = messages
    .filter(
      (m) =>
        m.session_id === sessionId && m.parent_id === null && !isHiddenTranscriptKind(m.kind),
    )
    .slice()
    .sort(byTime)
    .at(-1);
  if (last) return last.body.slice(0, 80);
  if (session?.last_message && !isHiddenTranscriptKind(session.last_message.kind)) {
    return session.last_message.body.slice(0, 80);
  }
  return "";
}

export function stopTarget(
  turns: readonly Turn[],
  sessionId: string | null,
  focusedTurnId: string | null,
  sessionKind?: SessionKind | null,
): string | null {
  if (!sessionId || sessionKind === "group") return null;
  const liveHere = (turn: Turn) => turn.session_id === sessionId && isLiveStatus(turn.status);
  if (focusedTurnId) {
    const focused = turns.find((turn) => turn.id === focusedTurnId && liveHere(turn));
    if (focused) return focused.id;
  }
  const newest = turns
    .filter(liveHere)
    .slice()
    .sort((a, b) =>
      a.last_activity_at < b.last_activity_at ? 1 : a.last_activity_at > b.last_activity_at ? -1 : 0,
    )[0];
  return newest?.id ?? null;
}

function lastIndexForTrigger(
  items: readonly TranscriptItem[],
  triggerId: string,
  turnId?: string,
): number {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === "message") {
      if (item.message.id === triggerId || (turnId && item.message.turn_id === turnId)) last = i;
    } else if (item.type === "streaming") {
      if (item.turn.id === turnId || item.turn.trigger_message_id === triggerId) last = i;
    } else if (item.trigger_message_id === triggerId) {
      last = i;
    }
  }
  return last;
}

function byTime(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
