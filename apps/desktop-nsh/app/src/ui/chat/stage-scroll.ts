/**
 * Where the transcript is scrolled (`chat-scroll.svelte.ts`, which measured a DOM): stuck to the
 * newest line or not, the jump to the bottom, the jump to a message (a search hit, a tick of the
 * index) and the paging of older lines. The virtualised, inverted `List` keeps a reader at the
 * newest line where they were as lines come in, so "stuck" is read from its scroll events (and
 * decides the scroll-to-bottom button, the reading reports and the read); there is no history
 * window to grow (the list mounts only what is near) and no scrollbar width to hand the composer.
 *
 * The list's own paging (`onLoadMore`, near the oldest row) fetches the next page back once every
 * loaded line has been reached.
 */
import { effect, signal, untracked, type ListRef, type ScrollEvent } from "nsh";
import type { IndexMark } from "../../m/chat/message-index.ts";
import { distanceFromNewest, nearNewest } from "./stage-rows";

export type StageScrollDeps = {
  /** The conversation's id alone: a new summary of the same conversation is not another one. */
  sessionId: () => string | null;
  highlightedId: () => string | null;
  highlightToken: () => number;
  /** Where a message is in the list (its rows newest first), or -1; read live. */
  indexOf: (messageId: string) => number;
  /** The message the index strip marks for the rows viewable now (`activeMessageId`); read live. */
  activeFor: (viewable: number[], atEnd: boolean) => string | null;
  hasOlder: () => boolean;
  olderLoading: () => boolean;
  loadOlder: () => void;
};

export function createStageScroll(deps: StageScrollDeps) {
  let list: ListRef | undefined;
  const stick = signal(true);
  const showBottom = signal(false);
  const viewable = signal<number[]>([]);
  /** The reading position last reported by an event, for the index strip. */
  const distance = signal(0);
  /** A search hit already scrolled to, by id and token, so a later snapshot does not pull the view back. */
  let followed = "";
  let jumping = false;

  function setNear(near: boolean): void {
    stick.set(near);
    showBottom.set(!near);
  }

  /** Newest line first in the list: its first row, at the foot of the view. */
  function scrollToBottom(animated = true): void {
    setNear(true);
    jumping = animated;
    list?.scrollToIndex({ index: 0, animated, viewPosition: 1 });
    if (animated) setTimeout(() => (jumping = false), 600);
  }

  function onScroll(e: ScrollEvent): void {
    distance.set(distanceFromNewest(e));
    if (jumping) return;
    setNear(nearNewest(e));
  }

  /** Up to a line (a tick of the index, the waiting chip): you are reading back from here, so what comes in next no longer pulls you down. */
  function jumpToMessage(id: string, animated = false): boolean {
    const at = deps.indexOf(id);
    if (at < 0 || !list) return false;
    jumping = false;
    setNear(false);
    list.scrollToIndex({ index: at, animated, viewPosition: 0.5 });
    return true;
  }

  function jumpToIndexMark(mark: Pick<IndexMark, "id">): void {
    if (jumpToMessage(mark.id)) active.set(mark.id);
  }

  const active = signal<string | null>(null);
  effect(() => {
    active.set(deps.activeFor(viewable(), stick()));
  });

  // Another conversation in this stage starts over at its newest line.
  effect(() => {
    void deps.sessionId();
    untracked(() => {
      followed = "";
      jumping = false;
      viewable.set([]);
      active.set(null);
      if (deps.highlightedId()) setNear(false);
      else setNear(true);
    });
  });

  // A highlighted line (a search hit, a link) is brought into view once it is in the list.
  effect(() => {
    const id = deps.highlightedId();
    const token = deps.highlightToken();
    if (!id) return;
    const key = `${deps.sessionId()}:${id}:${token}`;
    if (followed === key) return;
    if (deps.indexOf(id) < 0) return;
    followed = key;
    untracked(() => setTimeout(() => void jumpToMessage(id, true), 0));
  });

  /** The list's last row came near: another page of older lines, when there is one. */
  function onLoadMore(): void {
    if (deps.hasOlder() && !deps.olderLoading()) deps.loadOlder();
  }

  return {
    ref: (node: ListRef) => {
      list = node;
    },
    stick,
    showBottom,
    viewable,
    distance,
    active,
    onScroll,
    onViewable: (indices: number[]) => viewable.set(indices),
    onLoadMore,
    scrollToBottom,
    jumpToMessage,
    jumpToIndexMark,
    /** Pins to the newest line when it was where the reader was (a line sent from here). */
    keepBottom: () => {
      if (stick()) scrollToBottom(false);
    },
  };
}

export type StageScroll = ReturnType<typeof createStageScroll>;
