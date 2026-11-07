/**
 * Dragging a ticket card between the board's columns (`ticket-board-drag.ts`, which reads the DOM
 * under the pointer). Here the card's own `PanResponder` claims a press once it has travelled the
 * threshold (a press that stays under it is the card's click) and reads the column under the finger
 * from the columns' measured frames in the window; the drop is the pure `dropStatusAt`.
 *
 * A finger never starts one: on a phone the board scrolls. Escape cancels the drag; held near an edge,
 * the board scrolls sideways and the column under the card up and down (a timer, since a held finger
 * sends no moves).
 */
import { PanResponder, keymap, platform, type ScrollRef, type ViewRef } from "nsh";
import type { TicketStatus } from "@real-bot/protocol";
import { dropStatusAt, passedDragThreshold } from "../../m/overlays/ticket-board.ts";

/** The card under the pointer, once the press has travelled far enough to be a drag. */
export type CardDrag = {
  ticketId: string;
  from: TicketStatus;
  over: TicketStatus | null;
  x: number;
  y: number;
};

type Frame = { x: number; y: number; width: number; height: number };

/** A `Scroll` the drag may move, and where it is now (its offset along the axis it scrolls). */
export type EdgeScroller = { ref: ScrollRef | null; offset: () => number };

/** How close to a scroller's edge the pointer sits before it moves, and how far one tick moves it. */
export const SCROLL_EDGE_PX = 24;
export const SCROLL_STEP_PX = 12;
const SCROLL_TICK_MS = 16;

/** How far to move a scroller whose frame spans `start..end` along the axis, for a pointer at `at`: negative back, positive on, 0 not at an edge. */
export function edgeStep(at: number, start: number, end: number): number {
  if (at < start + SCROLL_EDGE_PX) return -SCROLL_STEP_PX;
  if (at > end - SCROLL_EDGE_PX) return SCROLL_STEP_PX;
  return 0;
}

export type CardDragHandlers = {
  /** Whether a card can be dragged at all: with an api, and never on a phone. */
  enabled: () => boolean;
  /** The column the card is drawn in when the press starts. */
  from: () => TicketStatus;
  /** True while this card's own request is on its way: a second drag of it waits. */
  busy: () => boolean;
  /** The column views, to read where each one is in the window. */
  columns: () => Partial<Record<TicketStatus, ViewRef | null>>;
  /** The board's sideways scroll, for the edge scroll; left out, nothing scrolls under the card. */
  boardScroll?: () => EdgeScroller | null;
  /** A column's up-and-down scroll. */
  columnScroll?: (status: TicketStatus) => EdgeScroller | null;
  onDrag: (drag: CardDrag | null) => void;
  onDrop: (status: TicketStatus) => void;
};

/** The column whose frame holds the point, or null. */
export function columnUnder(frames: ReadonlyMap<TicketStatus, Frame>, x: number, y: number): TicketStatus | null {
  for (const [status, frame] of frames) {
    if (x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height) return status;
  }
  return null;
}

/** The handlers to spread on a card (`{...cardDrag(...)}`). */
export function cardDrag(ticketId: string, handlers: CardDragHandlers) {
  let started = false;
  let cancelled = false;
  let from: TicketStatus = "todo";
  let frames = new Map<TicketStatus, Frame>();
  let last = { x: 0, y: 0 };
  let unbind: (() => void) | null = null;
  let ticking: ReturnType<typeof setInterval> | null = null;
  let busyTick = false;

  const stopEdgeScroll = (): void => {
    if (ticking) clearInterval(ticking);
    ticking = null;
  };
  const end = (): void => {
    started = false;
    stopEdgeScroll();
    unbind?.();
    unbind = null;
  };

  async function measureColumns(): Promise<void> {
    const next = new Map<TicketStatus, Frame>();
    for (const [status, ref] of Object.entries(handlers.columns()) as [TicketStatus, ViewRef | null][]) {
      const box = await ref?.measure();
      if (box) next.set(status, { x: box.pagePosition.x, y: box.pagePosition.y, width: box.bounds.size.width, height: box.bounds.size.height });
    }
    frames = next;
  }

  async function frameOf(ref: ScrollRef | null): Promise<Frame | null> {
    const box = await ref?.measure();
    return box ? { x: box.pagePosition.x, y: box.pagePosition.y, width: box.bounds.size.width, height: box.bounds.size.height } : null;
  }

  /**
   * Held near an edge, the board moves under the card: sideways when the columns run past the pane,
   * up and down in the column under it. The column under it is read again after a sideways step.
   */
  async function edgeScroll(): Promise<void> {
    if (busyTick || !started || cancelled) return;
    busyTick = true;
    try {
      const board = handlers.boardScroll?.() ?? null;
      const boardFrame = board ? await frameOf(board.ref) : null;
      let sideways = false;
      if (board?.ref && boardFrame) {
        const step = edgeStep(last.x, boardFrame.x, boardFrame.x + boardFrame.width);
        if (step !== 0) {
          board.ref.scrollTo({ x: Math.max(0, board.offset() + step), animated: false });
          sideways = true;
        }
      }
      if (sideways) await measureColumns();
      const over = columnUnder(frames, last.x, last.y);
      const column = over ? (handlers.columnScroll?.(over) ?? null) : null;
      const columnFrame = column ? await frameOf(column.ref) : null;
      if (column?.ref && columnFrame && last.x >= columnFrame.x && last.x <= columnFrame.x + columnFrame.width) {
        const step = edgeStep(last.y, columnFrame.y, columnFrame.y + columnFrame.height);
        if (step !== 0) column.ref.scrollTo({ y: Math.max(0, column.offset() + step), animated: false });
      }
      if (started && !cancelled) handlers.onDrag({ ticketId, from, over, x: last.x, y: last.y });
    } finally {
      busyTick = false;
    }
  }

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) =>
      !started && handlers.enabled() && platform.desktop && !handlers.busy() && passedDragThreshold(g.dx, g.dy),
    onPanResponderGrant: () => {
      started = true;
      cancelled = false;
      from = handlers.from();
      frames = new Map();
      void measureColumns();
      unbind = keymap.bind(
        "escape",
        () => {
          cancelled = true;
          stopEdgeScroll();
          handlers.onDrag(null);
        },
        { when: "always" },
      );
    },
    onPanResponderMove: (_e, g) => {
      if (!started || cancelled) return;
      last = { x: g.moveX, y: g.moveY };
      handlers.onDrag({ ticketId, from, over: columnUnder(frames, g.moveX, g.moveY), x: g.moveX, y: g.moveY });
      if (!ticking && (handlers.boardScroll || handlers.columnScroll)) ticking = setInterval(() => void edgeScroll(), SCROLL_TICK_MS);
    },
    onPanResponderRelease: () => {
      const landed = started && !cancelled;
      // The release's own gesture state is not the finger's place; the last move is.
      const over = columnUnder(frames, last.x, last.y);
      end();
      handlers.onDrag(null);
      if (!landed) return;
      const status = dropStatusAt(from, over);
      if (status) handlers.onDrop(status);
    },
    onPanResponderTerminate: () => {
      end();
      handlers.onDrag(null);
    },
  });
  return pan.panHandlers;
}
