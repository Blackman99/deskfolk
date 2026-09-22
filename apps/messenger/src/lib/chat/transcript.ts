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

/**
 * One wrapper per message, reused for as long as that message object is.
 *
 * The transcript is rebuilt whenever anything in the snapshot moves — a streamed token does it
 * several times a second — and the view keys its rows by message id. Handing back the same item
 * object for an unchanged message means those rows compare equal and the row's own work is
 * skipped; a fresh wrapper each time made every bubble in a long history re-evaluate instead.
 */
const messageItems = new WeakMap<Message, TranscriptItem>();

function messageItem(message: Message): TranscriptItem {
  const reused = messageItems.get(message);
  if (reused) return reused;
  const item: TranscriptItem = { type: "message", message };
  messageItems.set(message, item);
  return item;
}

/**
 * The sorted message list for one session, remembered for as long as the snapshot's message
 * array is the same one. A streamed token replaces `turns`, not `messages`, so without this the
 * whole history would be filtered and sorted again several times a second.
 */
let sortedMain: { messages: readonly Message[]; sessionId: string; items: readonly TranscriptItem[] } | null = null;

function mainItems(messages: readonly Message[], sessionId: string): TranscriptItem[] {
  if (sortedMain && sortedMain.messages === messages && sortedMain.sessionId === sessionId) {
    return sortedMain.items.slice();
  }
  const items = messages
    .filter((m) => m.session_id === sessionId && !isHiddenTranscriptKind(m.kind))
    .slice()
    .sort(byTime)
    .map(messageItem);
  sortedMain = { messages, sessionId, items };
  // The caller splices live turns into this list, so it never gets the cached array itself.
  return items.slice();
}

export function composeTranscript(
  messages: readonly Message[],
  turns: readonly Turn[],
  sessionId: string,
  pendingJudgements: readonly PendingJudgement[] = [],
): TranscriptItem[] {
  const items: TranscriptItem[] = mainItems(messages, sessionId);
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

/**
 * The line a list row shows. `limit` is generous by default and larger still for a caller that
 * strips markdown afterwards — cutting first would leave half a link or an unclosed `**`.
 */
export function latestPreview(
  messages: readonly Message[],
  sessionId: string,
  session?: SessionSummary | null,
  liveTurns?: readonly Turn[],
  limit = 80,
): string {
  const runningTurn = liveTurns?.find(
    (turn) => turn.session_id === sessionId && turn.status === "running",
  );
  if (runningTurn?.partial_text) {
    return runningTurn.partial_text.slice(-limit);
  }
  const last = messages
    .filter((m) => m.session_id === sessionId && !isHiddenTranscriptKind(m.kind))
    .slice()
    .sort(byTime)
    .at(-1);
  if (last) return last.body.slice(0, limit);
  if (session?.last_message && !isHiddenTranscriptKind(session.last_message.kind)) {
    return session.last_message.body.slice(0, limit);
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
