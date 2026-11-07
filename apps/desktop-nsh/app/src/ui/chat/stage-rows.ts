/**
 * What the stage's list is made of and how the view's position is read (pure; `ChatStage.tsx`
 * uses it). The Svelte stage drew a column of groups in a scroll area and measured the DOM; the
 * NSH one hands a virtualised, inverted `List` the rows below, newest first, and learns where the
 * view is from the list's own events: its scroll offset and which rows are viewable.
 *
 * An inverted `List` puts item 0 at the bottom; its offset is 0 at the oldest row and
 * `content - size` at the newest, so the distance from the bottom is `content - size - offset`.
 */
import type { ScrollEvent } from "nsh";
import { isDifferentDay, type TranscriptGroup } from "../../m/chat/chat-view.ts";
import type { ReplyingEntry, TranscriptItem } from "../../m/chat/transcript.ts";
import { STREAM_NEAR_BOTTOM_PX } from "../../m/chat/stream-scroll.ts";
import type { HiddenWaiting } from "./waiting-jump";
import { hiddenWaiting } from "./waiting-jump";
import type { Waiting } from "../../m/chat/waiting.ts";

export type StageRow =
  /** The delegations of a Bot↔Bot direct, above everything. */
  | { id: "delegations"; kind: "delegations" }
  /** The line above the first message while an earlier page may still come. */
  | { id: "earlier"; kind: "earlier" }
  /** A group of lines, with the date line above it when the day changes and the "New" line when it is the first unread. */
  | { id: string; kind: "group"; group: TranscriptGroup; date: string | null; fresh: boolean };

/** The rows oldest first, as the Svelte stage laid them from top to bottom. */
export function stageRows(
  groups: readonly TranscriptGroup[],
  opts: { earlier: boolean; delegations: boolean; newMarkId: string | null },
): StageRow[] {
  const rows: StageRow[] = [];
  if (opts.delegations) rows.push({ id: "delegations", kind: "delegations" });
  if (opts.earlier) rows.push({ id: "earlier", kind: "earlier" });
  groups.forEach((group, index) => {
    const previous = index > 0 ? groups[index - 1]! : null;
    rows.push({
      id: group.id,
      kind: "group",
      group,
      date: !previous || isDifferentDay(previous.created_at, group.created_at) ? group.created_at : null,
      fresh: opts.newMarkId !== null && group.items.some((item) => item.type === "message" && item.message.id === opts.newMarkId),
    });
  });
  return rows;
}

/** The list's order: the newest row first. */
export function invertedRows(rows: readonly StageRow[]): StageRow[] {
  return rows.slice().reverse();
}

/**
 * Hands back each row's previous object while what it shows is the same. NSH's `List` tells its
 * items apart by identity (`keyExtractor` only names them to viewability), so a row made anew is
 * built anew; and the rows are made anew whenever the snapshot's messages or turns change, a line
 * in another pane's conversation included. Lines and turns that did not change keep their objects
 * through the snapshot's events, so a row is the same when its items hold the same ones (or ones
 * fetched again that say the same).
 */
export function createRowKeeper(): (rows: readonly StageRow[]) => StageRow[] {
  let kept = new Map<string, StageRow>();
  return (rows) => {
    const next = new Map<string, StageRow>();
    const out = rows.map((row) => {
      const before = kept.get(row.id);
      const keep = before && sameRow(before, row) ? before : row;
      next.set(row.id, keep);
      return keep;
    });
    kept = next;
    return out;
  };
}

function sameRow(a: StageRow, b: StageRow): boolean {
  if (a.kind !== "group" || b.kind !== "group") return a.kind === b.kind;
  return a.date === b.date && a.fresh === b.fresh && sameGroup(a.group, b.group);
}

function sameGroup(a: TranscriptGroup, b: TranscriptGroup): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.author === b.author &&
    a.created_at === b.created_at &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => sameItem(item, b.items[index]!))
  );
}

function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.type === "message" && b.type === "message") return sameRecord(a.message, b.message) && sameEntries(a.replying, b.replying);
  if (a.type === "streaming" && b.type === "streaming") return sameRecord(a.turn, b.turn);
  if (a.type === "replying" && b.type === "replying") return a.trigger_message_id === b.trigger_message_id && sameEntries(a.entries, b.entries);
  return false;
}

/**
 * The same line or turn: the same object, or one fetched again that says the same (selecting a
 * conversation, as making its pane the current one does, loads its page anew). Compared as JSON
 * only when the objects differ; a different order of keys just makes the row anew.
 */
function sameRecord(a: object, b: object): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameEntries(a: readonly ReplyingEntry[] | undefined, b: readonly ReplyingEntry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.bot_id === other.bot_id && entry.created_at === other.created_at && entry.judgement_id === other.judgement_id;
  });
}

/** Whether the group (a row of `groups`) holds the message. */
export function groupHolds(group: TranscriptGroup, messageId: string): boolean {
  return group.items.some((item) => item.type === "message" && item.message.id === messageId);
}

/** Where a message is in the inverted list (its rows, newest first), or -1. */
export function inverseIndexOf(inverted: readonly StageRow[], messageId: string): number {
  return inverted.findIndex((row) => row.kind === "group" && groupHolds(row.group, messageId));
}

/** How far the view is from the newest line, in points. */
export function distanceFromNewest(e: Pick<ScrollEvent, "offset" | "contentSize" | "size">): number {
  return e.contentSize.height - e.size.height - e.offset.y;
}

export function nearNewest(e: Pick<ScrollEvent, "offset" | "contentSize" | "size">): boolean {
  return distanceFromNewest(e) <= STREAM_NEAR_BOTTOM_PX;
}

/** The oldest row of the viewable ones (the highest inverted index), for the index strip and the waiting chip. */
export function viewRange(viewable: readonly number[]): { oldest: number; newest: number } | null {
  if (viewable.length === 0) return null;
  return { oldest: Math.max(...viewable), newest: Math.min(...viewable) };
}

/**
 * The waiting cards out of sight (`inverted`: the list's rows, newest first), from which rows are viewable instead of rectangles: a card in a
 * viewable row is in; one in an older row than the viewable ones is above, one in a newer row below.
 * (`hiddenWaiting` is the Svelte's logic and takes boxes; these stand for the three places.)
 */
export function hiddenWaitingFromRows(
  waiting: readonly Waiting[],
  inverted: readonly StageRow[],
  viewable: readonly number[],
): HiddenWaiting {
  const range = viewRange(viewable);
  if (!range) return { items: [], above: false };
  return hiddenWaiting(
    waiting,
    (id) => {
      const at = inverseIndexOf(inverted, id);
      if (at < 0) return null;
      if (at > range.oldest) return { top: -300, bottom: -200 };
      if (at < range.newest) return { top: 300, bottom: 400 };
      return { top: 20, bottom: 80 };
    },
    { top: 0, bottom: 100 },
  );
}

/** The message at the top of the view, for the index strip: the first message of the oldest viewable group, or the newest while at the end. */
export function activeMessageId(inverted: readonly StageRow[], viewable: readonly number[], atEnd: boolean, last: string | null): string | null {
  if (atEnd) return last;
  const range = viewRange(viewable);
  if (!range) return null;
  for (let i = range.oldest; i >= range.newest; i--) {
    const row = inverted[i];
    if (row?.kind !== "group") continue;
    for (const item of row.group.items) if (item.type === "message") return item.message.id;
  }
  return null;
}
