import {
  INTERRUPT_NOTE_BODY,
  UNREACHABLE_NOTE_BODIES,
  USER_MEMBER,
  isContinuableNote,
  isHiddenTranscriptKind,
  isInterruptNote,
  isUnreachableNote,
  type Message,
  type Reaction,
  type Turn,
} from "@real-bot/protocol";
import { isLiveStatus } from "./transcript.ts";
import type { TranscriptItem } from "./transcript.ts";

export { isContinuableNote, isInterruptNote, isUnreachableNote };

export function canContinueInterrupt(
  message: Pick<Message, "id" | "kind" | "body" | "author" | "turn_id" | "source_turn_id">,
  turns: readonly Turn[],
  opts: { locked?: boolean; readOnly?: boolean; hasLiveTurnForBot?: boolean } = {},
): boolean {
  if (!isContinuableNote(message) || !message.turn_id) return false;
  if (message.source_turn_id) return false;
  // A Bot↔Bot chat has no composer, so Continue is how that chat picks up. Anywhere else a
  // locked composer means there is nobody to hand the next turn to.
  if (opts.locked && !opts.readOnly) return false;
  if (opts.hasLiveTurnForBot) return false;
  const own = turns.find((turn) => turn.id === message.turn_id);
  if (own) {
    if (isInterruptNote(message) && own.status !== "interrupted") return false;
    if (!isInterruptNote(message) && own.status !== "completed" && own.status !== "interrupted") return false;
  }
  return !turns.some(
    (turn) => turn.trigger_message_id === message.id && isLiveStatus(turn.status),
  );
}

/**
 * The daemon's completion-failure note, 「这一轮没写完：…」 (`COMPLETION_FAIL` in
 * apps/daemon/src/prompts/transcript-copy.ts), in whichever locale was set when the turn failed:
 * every continuable note but 中断. A turn's other system notes, like an @ that matched nobody, are
 * not failures.
 */
export function isCompletionFailNote(message: Pick<Message, "kind" | "body">): boolean {
  return isContinuableNote(message) && !isInterruptNote(message);
}

/**
 * What a 继续 on a 中断 or 这一轮没写完 row came to, once the follow-up turn is recorded on the
 * note.
 */
export type InterruptFollowUp =
  | { state: "live" }
  | { state: "done"; first: Message; failed: boolean }
  | { state: "stopped" }
  | { state: "nothing" }
  | { state: "unknown" };

/**
 * The follow-up turn recorded on a continuable row (`source_turn_id`, set when 继续 is used on a
 * 中断 or 这一轮没写完 note): still going; left something in a transcript (`first` is its earliest
 * message, this session's before any other, and `failed` says a completion-failure note is among
 * them); stopped or redirected before it left anything; or seen to finish without a message, as a
 * no-work closer does by design. After a reload the window holds only this session's page and each
 * other session's last message, so a follow-up it did not see end and finds no message for is
 * `unknown` — it may have posted elsewhere — never `nothing`. Null while no follow-up is recorded,
 * where `canContinueInterrupt` decides instead.
 */
export function interruptFollowUp(
  message: Pick<Message, "id" | "kind" | "body" | "session_id" | "source_turn_id">,
  messages: readonly Message[],
  turns: readonly Turn[],
): InterruptFollowUp | null {
  const followUpId = message.source_turn_id;
  if (!isContinuableNote(message) || !followUpId) return null;
  const turn = turns.find((t) => t.id === followUpId);
  if (turn && isLiveStatus(turn.status)) return { state: "live" };
  const produced = messages.filter(
    (m) => m.turn_id === followUpId && m.id !== message.id && !isHiddenTranscriptKind(m.kind),
  );
  if (produced.length === 0) {
    if (!turn) return { state: "unknown" };
    return turn.status === "stopped" || turn.status === "redirected" ? { state: "stopped" } : { state: "nothing" };
  }
  const here = produced.filter((m) => m.session_id === message.session_id);
  const first = (here.length > 0 ? here : produced).reduce((a, b) => (isEarlier(b, a) ? b : a));
  return { state: "done", first, failed: produced.some(isCompletionFailNote) };
}

function isEarlier(
  a: Pick<Message, "created_at" | "id">,
  b: Pick<Message, "created_at" | "id">,
): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

export type BotDuration = {
  ms: number;
  formatted: string;
};

export type ReactionGroup = {
  emoji: string;
  count: number;
  userReacted: boolean;
};

/** Formats duration in milliseconds into a concise readable string, e.g. "1.2s", "45s", "1m 12s" */
export function formatDurationMs(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Calculates how long a bot took to reply to a prompt.
 * Uses the associated turn or triggering message timestamp.
 */
/**
 * Message lookups the transcript needs per row, built once per message list instead.
 *
 * Every bubble used to answer "what was quoted here" and "what came before this" by scanning the
 * whole snapshot, so a long history cost rows × messages on every render. The list only changes
 * when a message arrives, so the maps are remembered until it does.
 */
export type MessageLookup = {
  byId: ReadonlyMap<string, Message>;
  /** The message directly before this one in its own session, in transcript order. */
  previousInSession: ReadonlyMap<string, Message>;
};

let lookupCache: { messages: readonly Message[]; lookup: MessageLookup } | null = null;

export function buildMessageLookup(messages: readonly Message[]): MessageLookup {
  if (lookupCache && lookupCache.messages === messages) return lookupCache.lookup;
  const byId = new Map<string, Message>();
  const bySession = new Map<string, Message[]>();
  for (const message of messages) {
    byId.set(message.id, message);
    const list = bySession.get(message.session_id);
    if (list) list.push(message);
    else bySession.set(message.session_id, [message]);
  }
  const previousInSession = new Map<string, Message>();
  for (const list of bySession.values()) {
    list.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (let i = 1; i < list.length; i++) previousInSession.set(list[i]!.id, list[i - 1]!);
  }
  const lookup: MessageLookup = { byId, previousInSession };
  lookupCache = { messages, lookup };
  return lookup;
}

export function calculateBotDuration(
  message: Message,
  messages: readonly Message[],
  turns: readonly Turn[],
  lookup: MessageLookup = buildMessageLookup(messages),
): BotDuration | null {
  if (message.kind !== "bot") return null;

  let startTime: string | null = null;

  if (message.turn_id) {
    const turn = turns.find((t) => t.id === message.turn_id);
    if (turn) {
      if (turn.trigger_message_id) {
        const trigger = lookup.byId.get(turn.trigger_message_id);
        if (trigger) startTime = trigger.created_at;
      }
      if (!startTime) startTime = turn.created_at;
    }
  }

  // No turn or trigger: the user message it answered is the one directly before it.
  if (!startTime) {
    const previous = lookup.previousInSession.get(message.id);
    if (previous && previous.kind === "user") startTime = previous.created_at;
  }

  if (!startTime) return null;

  const startMs = new Date(startTime).getTime();
  const endMs = new Date(message.created_at).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return null;

  const ms = Math.max(0, endMs - startMs);
  return { ms, formatted: formatDurationMs(ms) };
}

/** Formats a live timer from an ISO start timestamp to current time */
export function formatLiveDuration(startedAt: string, nowMs: number = Date.now()): string {
  const startMs = new Date(startedAt).getTime();
  if (isNaN(startMs)) return "0.0s";
  const elapsed = Math.max(0, nowMs - startMs);
  return formatDurationMs(elapsed);
}

/** Formats ISO timestamp into local HH:mm (e.g. 14:05) */
export function formatMessageTime(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Formats ISO timestamp into full localized readable date/time (e.g. 2026-09-15 14:05:22) */
export function formatFullTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** Determines if two ISO date strings fall on different calendar days */
export function isDifferentDay(dateA: string, dateB: string): boolean {
  const da = new Date(dateA);
  const db = new Date(dateB);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return false;
  return (
    da.getFullYear() !== db.getFullYear() ||
    da.getMonth() !== db.getMonth() ||
    da.getDate() !== db.getDate()
  );
}

/** Formats a date divider string ("今天" / "Today", "昨天" / "Yesterday", or localized date) */
export function formatDateDivider(
  isoString: string,
  locale: "zh" | "en" = "zh",
  now: Date = new Date(),
): string {
  const target = new Date(isoString);
  if (isNaN(target.getTime())) return "";

  const isToday =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();

  if (isToday) {
    return locale === "zh" ? "今天" : "Today";
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    target.getFullYear() === yesterday.getFullYear() &&
    target.getMonth() === yesterday.getMonth() &&
    target.getDate() === yesterday.getDate();

  if (isYesterday) {
    return locale === "zh" ? "昨天" : "Yesterday";
  }

  const year = target.getFullYear();
  const month = target.getMonth() + 1;
  const day = target.getDate();

  if (locale === "zh") {
    if (year === now.getFullYear()) {
      return `${month}月${day}日`;
    }
    return `${year}年${month}月${day}日`;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mName = months[target.getMonth()];
  if (year === now.getFullYear()) {
    return `${mName} ${day}`;
  }
  return `${mName} ${day}, ${year}`;
}

/** Groups reactions by emoji with count and user reacted state */
export function groupReactions(
  reactions: readonly Reaction[] | undefined | null,
  currentUserId: string,
): ReactionGroup[] {
  if (!reactions || reactions.length === 0) return [];
  const map = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    let entry = map.get(r.emoji);
    if (!entry) {
      entry = { emoji: r.emoji, count: 0, userReacted: false };
      map.set(r.emoji, entry);
    }
    entry.count++;
    if (r.actor === currentUserId) {
      entry.userReacted = true;
    }
  }
  return Array.from(map.values());
}

export type TranscriptGroupKind =
  | "bot"
  | "user"
  | "ask"
  | "approval"
  | "system"
  | "replying";

export type TranscriptGroup = {
  id: string;
  kind: TranscriptGroupKind;
  author: string;
  created_at: string;
  items: TranscriptItem[];
};

export const MAX_GROUP_TIME_DIFF_MS = 10 * 60 * 1000; // 10 minutes

export function itemGroupInfo(item: TranscriptItem): {
  kind: TranscriptGroupKind;
  author: string;
  created_at: string;
  mergeable: boolean;
} {
  if (item.type === "streaming") {
    return {
      kind: "bot",
      author: item.turn.bot_id,
      created_at: item.turn.created_at,
      mergeable: true,
    };
  }
  if (item.type === "replying") {
    return {
      kind: "replying",
      author: "replying",
      created_at: item.entries[0]?.created_at ?? "",
      mergeable: false,
    };
  }
  const m = item.message;
  if (m.kind === "ask") {
    return { kind: "ask", author: m.author, created_at: m.created_at, mergeable: false };
  }
  if (m.kind === "approval") {
    return { kind: "approval", author: m.author, created_at: m.created_at, mergeable: false };
  }
  if (m.kind === "system") {
    return { kind: "system", author: m.author, created_at: m.created_at, mergeable: false };
  }
  if (m.author === USER_MEMBER) {
    return { kind: "user", author: USER_MEMBER, created_at: m.created_at, mergeable: true };
  }
  return { kind: "bot", author: m.author, created_at: m.created_at, mergeable: true };
}

/**
 * Groups consecutive transcript items from the same author on the same calendar day.
 * Distinguishes distinct output segments while reducing redundant avatar/sender headers.
 */
export function groupTranscript(
  items: readonly TranscriptItem[],
  maxTimeDiffMs: number = MAX_GROUP_TIME_DIFF_MS,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let currentGroup: TranscriptGroup | null = null;
  let lastItemCreatedAt: string | null = null;

  for (const item of items) {
    if (item.type === "replying") {
      let attached = false;
      for (let i = groups.length - 1; i >= 0; i--) {
        const targetIndex = groups[i].items.findIndex(
          (it) => it.type === "message" && it.message.id === item.trigger_message_id,
        );
        if (targetIndex >= 0) {
          const target = groups[i].items[targetIndex];
          if (target.type === "message") {
            groups[i].items[targetIndex] = {
              ...target,
              replying: item.entries,
            };
            attached = true;
            break;
          }
        }
      }
      if (attached) {
        continue;
      }
    }

    const info = itemGroupInfo(item);
    const itemId =
      item.type === "message"
        ? item.message.id
        : item.type === "streaming"
          ? item.turn.id
          : `replying-${item.trigger_message_id}`;

    if (
      currentGroup &&
      info.mergeable &&
      currentGroup.kind === info.kind &&
      currentGroup.author === info.author
    ) {
      const differentDay = lastItemCreatedAt ? isDifferentDay(lastItemCreatedAt, info.created_at) : false;
      const timeDiff = lastItemCreatedAt
        ? Math.abs(new Date(info.created_at).getTime() - new Date(lastItemCreatedAt).getTime())
        : 0;

      if (!differentDay && timeDiff <= maxTimeDiffMs) {
        currentGroup.items.push(item);
        lastItemCreatedAt = info.created_at;
        continue;
      }
    }

    currentGroup = {
      id: `group-${itemId}`,
      kind: info.kind,
      author: info.author,
      created_at: info.created_at,
      items: [item],
    };
    groups.push(currentGroup);
    lastItemCreatedAt = info.created_at;
  }

  return groups;
}

