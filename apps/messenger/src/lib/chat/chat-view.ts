import {
  INTERRUPT_NOTE_BODY,
  USER_MEMBER,
  type Message,
  type Reaction,
  type Turn,
} from "@real-bot/protocol";
import { isLiveStatus } from "./transcript.ts";
import type { TranscriptItem } from "./transcript.ts";

export function isInterruptNote(message: Pick<Message, "kind" | "body">): boolean {
  return message.kind === "system" && message.body === INTERRUPT_NOTE_BODY;
}

export function canContinueInterrupt(
  message: Pick<Message, "id" | "kind" | "body" | "author" | "turn_id" | "source_turn_id">,
  turns: readonly Turn[],
  opts: { locked?: boolean; hasLiveTurnForBot?: boolean } = {},
): boolean {
  if (!isInterruptNote(message) || !message.turn_id) return false;
  if (message.source_turn_id) return false;
  if (opts.locked) return false;
  if (opts.hasLiveTurnForBot) return false;
  const own = turns.find((turn) => turn.id === message.turn_id);
  if (own && own.status !== "interrupted") return false;
  return !turns.some(
    (turn) => turn.trigger_message_id === message.id && isLiveStatus(turn.status),
  );
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
export function calculateBotDuration(
  message: Message,
  messages: readonly Message[],
  turns: readonly Turn[],
): BotDuration | null {
  if (message.kind !== "bot") return null;

  let startTime: string | null = null;

  if (message.turn_id) {
    const turn = turns.find((t) => t.id === message.turn_id);
    if (turn) {
      if (turn.trigger_message_id) {
        const trigger = messages.find((m) => m.id === turn.trigger_message_id);
        if (trigger) startTime = trigger.created_at;
      }
      if (!startTime) startTime = turn.created_at;
    }
  }

  // If no turn or trigger found, check previous message in the session
  if (!startTime) {
    const sessionMsgs = messages
      .filter((m) => m.session_id === message.session_id && m.created_at <= message.created_at)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const idx = sessionMsgs.findIndex((m) => m.id === message.id);
    if (idx > 0) {
      const prev = sessionMsgs[idx - 1];
      if (prev.kind === "user") {
        startTime = prev.created_at;
      }
    }
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

