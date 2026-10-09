/**
 * Pointer plumbing for dragging a model ladder rung to another place on the ladder.
 *
 * Unlike the board's cards, touch starts one too: it starts only on the rung's grip, which takes no
 * scroll (`touch-action: none`), so a finger anywhere else on the page still scrolls it. A press
 * that stays under the threshold is no drag; once it crosses, the following click is swallowed.
 * Escape puts the rung back. Returns nothing: the listeners remove themselves.
 */
import { trackPointerDrag } from "../pointer-drag.ts";

/** How far a press moves before it is a drag rather than a tap on the grip. */
const LADDER_DRAG_THRESHOLD_PX = 4;

/**
 * Where the rung dragged from `from` lands when its middle is at `y`: after every other rung whose
 * middle it has reached (held against either end, it has reached that end's rung). `middles` are the rungs' middles as they sat when the drag started.
 */
export function ladderSlot(middles: readonly number[], from: number, y: number): number {
  let slot = 0;
  middles.forEach((middle, index) => {
    if (index < from ? middle < y : index > from && middle <= y) slot += 1;
  });
  return slot;
}

/** Where each rung is drawn while one is dragged: the dragged one at its slot, the ones it passed one place over. */
export function ladderPlace(index: number, from: number, slot: number): number {
  if (index === from) return slot;
  if (from < slot && index > from && index <= slot) return index - 1;
  if (slot < from && index >= slot && index < from) return index + 1;
  return index;
}

/** The ladder in the order a drag from `from` to `slot` leaves it. */
export function movedTo<T>(items: readonly T[], from: number, slot: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(slot, 0, moved!);
  return next;
}

export type LadderDrag = {
  from: number;
  slot: number;
  /** How far the dragged rung has moved from where it sat. */
  dy: number;
  /** How far a rung it passes moves to make room: the dragged rung's height and the gap after it. */
  shift: number;
};

export type LadderDragHandlers = {
  onDrag: (drag: LadderDrag | null) => void;
  /** Once, on a release after the threshold that Escape did not cancel. */
  onDrop: (from: number, slot: number) => void;
};

/** Start watching a press on the grip of rung `from`; `rows` are every rung, in order. */
export function beginLadderDrag(event: PointerEvent, from: number, rows: readonly HTMLElement[], handlers: LadderDragHandlers): void {
  if (event.button !== 0 || !rows[from]) return;
  const grip = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const pointerId = event.pointerId;
  const origin = { x: event.clientX, y: event.clientY };
  const boxes = rows.map((row) => row.getBoundingClientRect());
  const middles = boxes.map((box) => box.top + box.height / 2);
  const own = boxes[from]!;
  const gap = boxes.length > 1 ? Math.max(0, boxes[1]!.top - boxes[0]!.bottom) : 0;
  const shift = own.height + gap;
  // The rung's middle stays between the first rung's top and the last one's bottom.
  const lowest = boxes[0]!.top - own.top;
  const highest = boxes[boxes.length - 1]!.bottom - own.bottom;
  let started = false;
  let cancelled = false;
  let drag: LadderDrag | null = null;

  const noSelect = (e: Event): void => e.preventDefault();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !started || cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    drag = null;
    handlers.onDrag(null);
  };

  document.addEventListener("selectstart", noSelect, true);
  window.addEventListener("keydown", onKey, true);
  trackPointerDrag(window, {
    move: (e) => {
      if (e.pointerId !== pointerId || cancelled) return;
      if (!started) {
        if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < LADDER_DRAG_THRESHOLD_PX) return;
        started = true;
        try {
          grip?.setPointerCapture(pointerId);
        } catch {
          // The window still hears the pointer.
        }
      }
      const dy = Math.min(highest, Math.max(lowest, e.clientY - origin.y));
      drag = { from, slot: ladderSlot(middles, from, middles[from]! + dy), dy, shift };
      handlers.onDrag(drag);
    },
    end: (e) => {
      document.removeEventListener("selectstart", noSelect, true);
      window.removeEventListener("keydown", onKey, true);
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
      handlers.onDrop(landed.from, landed.slot);
    },
  });
}
