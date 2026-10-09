/**
 * Pointer plumbing for dragging a ticket card between columns.
 *
 * Touch never starts one: a finger on the narrow board scrolls it. A press that stays under the
 * threshold is a click on the card. Once it crosses, the following click is swallowed so the drop
 * does not also pick the card.
 */
import type { TicketStatus } from "@real-bot/protocol";
import { trackPointerDrag } from "../pointer-drag.ts";
import { TICKET_STATUS_ORDER } from "./plan-board.ts";
import { dropStatusAt, passedDragThreshold } from "./ticket-board.ts";

/** How close to a scroller's edge the pointer has to sit before that scroller moves. */
const SCROLL_EDGE_PX = 24;
/** How far one frame scrolls it. */
const SCROLL_STEP_PX = 12;

export type CardDrag = {
  ticketId: string;
  from: TicketStatus;
  over: TicketStatus | null;
  x: number;
  y: number;
};

export type CardDragHandlers = {
  /** The column the card is drawn in when the press starts. */
  from: () => TicketStatus;
  /** True while this card's own request is on its way: a second drag of it waits. */
  busy: () => boolean;
  onDrag: (drag: CardDrag | null) => void;
  onDrop: (status: TicketStatus) => void;
};

function isStatus(value: string | undefined): value is TicketStatus {
  return !!value && (TICKET_STATUS_ORDER as readonly string[]).includes(value);
}

/**
 * The column under the pointer, on this board only: with two panes open on the same plan, a drop on
 * the other one's column is no drop. The card that follows the pointer must not catch it.
 */
function columnElementAt(x: number, y: number, board: Element | null): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  const column = hit instanceof Element ? hit.closest<HTMLElement>("[data-board-status]") : null;
  return column && (!board || board.contains(column)) ? column : null;
}

export function columnAt(x: number, y: number, board: Element | null = null): TicketStatus | null {
  const status = columnElementAt(x, y, board)?.dataset.boardStatus;
  return isStatus(status) ? status : null;
}

/** Whether an element scrolls up and down by itself (a column across), rather than with its rail. */
function scrollsDown(element: HTMLElement): boolean {
  return getComputedStyle(element).overflowY === "auto" && element.scrollHeight > element.clientHeight;
}

/**
 * Start watching a press on a card. The title is a button but also where a card is grabbed: a
 * press there that stays under the threshold is still its click. Every other button, links,
 * fields and the status menu keep their own press. Returns nothing: the listeners remove themselves.
 */
export function beginCardDrag(event: PointerEvent, ticketId: string, handlers: CardDragHandlers): void {
  if (event.button !== 0 || event.pointerType === "touch" || handlers.busy()) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("button:not(.ticket-main), a, input, textarea, select, .real-select")) return;

  const pointerId = event.pointerId;
  const origin = { x: event.clientX, y: event.clientY };
  const from = handlers.from();
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const board = row?.closest<HTMLElement>(".ticket-board") ?? null;
  let started = false;
  let cancelled = false;
  let drag: CardDrag | null = null;
  let scrollTimer = 0;

  const stopEdgeScroll = (): void => {
    if (scrollTimer) cancelAnimationFrame(scrollTimer);
    scrollTimer = 0;
  };

  /**
   * Near an edge, the board moves under a held pointer: sideways when its columns run past the
   * pane, up and down in the column under the pointer (across) or in the rail around it (stacked).
   * The column under the pointer is read again after each step, since it is a different one now.
   */
  const edgeScroll = (): void => {
    stopEdgeScroll();
    const step = (): void => {
      scrollTimer = 0;
      if (!drag) return;
      if (board && board.scrollWidth > board.clientWidth) {
        const box = board.getBoundingClientRect();
        if (drag.x < box.left + SCROLL_EDGE_PX) board.scrollLeft -= SCROLL_STEP_PX;
        else if (drag.x > box.right - SCROLL_EDGE_PX) board.scrollLeft += SCROLL_STEP_PX;
      }
      const column = columnElementAt(drag.x, drag.y, board);
      const scroller = column && scrollsDown(column) ? column : board?.closest<HTMLElement>(".trace-side-panel") ?? null;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (drag.y < box.top + SCROLL_EDGE_PX) scroller.scrollTop -= SCROLL_STEP_PX;
        else if (drag.y > box.bottom - SCROLL_EDGE_PX) scroller.scrollTop += SCROLL_STEP_PX;
      }
      const over = columnAt(drag.x, drag.y, board);
      if (over !== drag.over) {
        drag = { ...drag, over };
        handlers.onDrag(drag);
      }
      scrollTimer = requestAnimationFrame(step);
    };
    scrollTimer = requestAnimationFrame(step);
  };

  const noSelect = (e: Event): void => e.preventDefault();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !started) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    drag = null;
    handlers.onDrag(null);
    stopEdgeScroll();
  };

  document.addEventListener("selectstart", noSelect, true);
  window.addEventListener("keydown", onKey, true);
  trackPointerDrag(window, {
    move: (e) => {
      // Escape ended this drag; the moves until the release draw nothing.
      if (e.pointerId !== pointerId || cancelled) return;
      if (!started) {
        if (!passedDragThreshold(e.clientX - origin.x, e.clientY - origin.y)) return;
        started = true;
        try {
          row?.setPointerCapture(pointerId);
        } catch {
          // The window still hears the pointer.
        }
      }
      drag = { ticketId, from, over: columnAt(e.clientX, e.clientY, board), x: e.clientX, y: e.clientY };
      handlers.onDrag(drag);
      edgeScroll();
    },
    end: (e) => {
      document.removeEventListener("selectstart", noSelect, true);
      window.removeEventListener("keydown", onKey, true);
      stopEdgeScroll();
      if (!started) return;
      const landed = drag;
      drag = null;
      handlers.onDrag(null);
      const swallow = (click: MouseEvent): void => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (cancelled || e.type === "pointercancel" || !landed) return;
      const status = dropStatusAt(landed.from, columnAt(e.clientX, e.clientY, board));
      if (status) handlers.onDrop(status);
    },
  });
}
