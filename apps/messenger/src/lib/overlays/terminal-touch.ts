/** The parts of an xterm a swipe reads. */
type Swipeable = {
  readonly element: HTMLElement | undefined;
  readonly rows: number;
  readonly modes: { readonly mouseTrackingMode: string };
  readonly buffer: { readonly active: { readonly type: string } };
};

/**
 * A swipe on a phone's terminal, for the programs that keep their own history.
 *
 * xterm scrolls its scrollback under a finger by itself, but only its own: once a program has
 * taken the mouse or moved to the alternate screen — Claude Code, vim, less, htop, tmux — xterm
 * does nothing with a touch, and those programs are where the history is. On a desktop the wheel
 * reaches them, reported to a program that asked for the mouse and sent as arrow keys to one
 * that did not; a phone has no wheel, so a swipe there did nothing at all.
 *
 * Here each row the finger travels becomes one wheel step handed to xterm, which does with it
 * exactly what it does with a desktop wheel, at the cell under the finger. Finger down is wheel
 * up: the text follows the finger, as a page does. Everywhere else the swipe is left to xterm.
 */
export function swipeAsWheel(host: HTMLElement, term: Swipeable): () => void {
  let lastY: number | null = null;
  /** Travel short of a whole row, kept for the next move so a slow drag still gets there. */
  let travel = 0;

  const start = (event: TouchEvent) => {
    // Two fingers are a pinch, not a scroll.
    lastY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
    travel = 0;
  };
  const move = (event: TouchEvent) => {
    if (lastY === null || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const moved = lastY - touch.clientY;
    lastY = touch.clientY;
    if (!ownsSwipe(term)) {
      travel = 0;
      return;
    }
    // The page under the terminal must not move instead.
    if (event.cancelable) event.preventDefault();
    const row = rowHeight(term);
    if (row <= 0) return;
    travel += moved;
    const steps = Math.trunc(travel / row);
    travel -= steps * row;
    for (let i = 0; i < Math.abs(steps); i += 1) wheel(term, Math.sign(steps), touch.clientX, touch.clientY);
  };
  const end = () => {
    lastY = null;
  };

  host.addEventListener("touchstart", start, { passive: true });
  host.addEventListener("touchmove", move, { passive: false });
  host.addEventListener("touchend", end);
  host.addEventListener("touchcancel", end);
  return () => {
    host.removeEventListener("touchstart", start);
    host.removeEventListener("touchmove", move);
    host.removeEventListener("touchend", end);
    host.removeEventListener("touchcancel", end);
  };
}

/** Where xterm's own touch scrolling has nothing to move, or has stood aside for the program. */
function ownsSwipe(term: Swipeable): boolean {
  return term.modes.mouseTrackingMode !== "none" || term.buffer.active.type === "alternate";
}

function rowHeight(term: Swipeable): number {
  const screen = term.element?.querySelector(".xterm-screen");
  return screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0;
}

/** Line mode: one step is one line whatever the row height, so xterm neither rounds it away nor multiplies it. */
function wheel(term: Swipeable, direction: number, clientX: number, clientY: number): void {
  term.element?.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: direction,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    }),
  );
}
