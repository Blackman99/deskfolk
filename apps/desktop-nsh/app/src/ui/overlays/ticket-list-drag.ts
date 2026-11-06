/**
 * Dragging a ticket card between the board's columns (`ticket-board-drag.ts`, which reads the DOM
 * under the pointer). Here the card's own `PanResponder` claims a press once it has travelled the
 * threshold (a press that stays under it is the card's click) and reads the column under the finger
 * from the columns' measured frames in the window; the drop is the pure `dropStatusAt`.
 *
 * A finger never starts one: on a phone the board scrolls. Not carried over: the board scrolling
 * sideways or up and down under a card held at its edge; Escape cancels the drag.
 */
import { PanResponder, keymap, platform, type ViewRef } from "nsh";
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

export type CardDragHandlers = {
  /** Whether a card can be dragged at all: with an api, and never on a phone. */
  enabled: () => boolean;
  /** The column the card is drawn in when the press starts. */
  from: () => TicketStatus;
  /** True while this card's own request is on its way: a second drag of it waits. */
  busy: () => boolean;
  /** The column views, to read where each one is in the window. */
  columns: () => Partial<Record<TicketStatus, ViewRef | null>>;
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

  const end = (): void => {
    started = false;
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
          handlers.onDrag(null);
        },
        { when: "always" },
      );
    },
    onPanResponderMove: (_e, g) => {
      if (!started || cancelled) return;
      last = { x: g.moveX, y: g.moveY };
      handlers.onDrag({ ticketId, from, over: columnUnder(frames, g.moveX, g.moveY), x: g.moveX, y: g.moveY });
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
