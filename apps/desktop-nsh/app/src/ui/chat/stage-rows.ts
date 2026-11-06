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
