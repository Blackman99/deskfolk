/**
 * What keeps a drag from doing its expensive follow-up work on every pixel.
 *
 * The panes themselves resize with the pointer: a divider moves every pane it sits between, and
 * a corner pull resizes that floating pane. What waits is the measuring those contents do from a
 * resize — a transcript walking every bubble to place its index, Monaco laying out, xterm fitting
 * and telling the pty. That runs once, when the pointer is released.
 *
 * Do not hold a pane's content at its old pixel size to get this. That min-width stops the grid
 * from giving the other panes their new share, so the drag looks like one panel sliding over
 * the rest. And do not put `contain: layout` or `contain: paint` on a pane: both make it the
 * containing block for `position: fixed`, and the menus placed from `clientX` / `clientY` then
 * open a column away from the pointer.
 */
let active = false;
let depth = 0;
const pending = new Set<() => void>();

function releasePending(): void {
  const due = [...pending];
  pending.clear();
  let failure: unknown;
  for (const run of due) {
    try {
      run();
    } catch (cause) {
      failure ??= cause;
    }
  }
  if (failure !== undefined) throw failure;
}

export const dragGate = {
  get active(): boolean {
    return active;
  },
  begin(): void {
    depth += 1;
    active = true;
  },
  end(): void {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      active = false;
      releasePending();
    }
  },
};

/**
 * Run `run` immediately, or once when the current drag ends.
 *
 * Repeated calls during one drag collapse into a single run. `cancel` drops that run, for a
 * watcher that goes away while the pointer is still down.
 */
export function deferWhileDragging(run: () => void): { run: () => void; cancel: () => void } {
  const fire = () => {
    if (active) {
      pending.add(fire);
      return;
    }
    pending.delete(fire);
    run();
  };
  return { run: fire, cancel: () => pending.delete(fire) };
}

/**
 * Watch an element's size, holding the callback while a drag is in progress.
 *
 * Call from an `$effect` or `onMount`; the returned function stops watching. A `window.resize`
 * listener comes along because the browser used for UI verification never delivers
 * `ResizeObserver` callbacks, and a pane that only resizes through one of the two cannot be
 * checked there.
 */
export function onPaneResize(host: HTMLElement | null, run: () => void): () => void {
  if (!host) return () => {};
  const deferred = deferWhileDragging(run);
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(deferred.run) : null;
  observer?.observe(host);
  const onWindowResize = () => deferred.run();
  if (typeof window !== "undefined") window.addEventListener("resize", onWindowResize);
  return () => {
    observer?.disconnect();
    if (typeof window !== "undefined") window.removeEventListener("resize", onWindowResize);
    deferred.cancel();
  };
}

