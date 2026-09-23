/**
 * The gate that keeps a drag cheap.
 *
 * Moving a divider is cheap; telling xterm to reflow its buffer and Monaco to re-measure is not,
 * and both do it from their own `ResizeObserver`. So while a drag is running they skip it, and
 * run exactly once when the pointer is released.
 */
let active = $state(false);
let depth = 0;

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
    if (depth === 0) active = false;
  },
};

/**
 * Watch an element's size, but hold off while a drag is in progress.
 *
 * Call from an `$effect`. The returned function stops watching. A `window.resize` listener comes
 * along for the ride because the browser used for UI verification never delivers `ResizeObserver`
 * callbacks, and a pane that only resizes through one of the two cannot be checked there.
 */
export function onPaneResize(host: HTMLElement | null, run: () => void): () => void {
  if (!host) return () => {};
  let pending = false;
  const fire = () => {
    if (dragGate.active) {
      pending = true;
      return;
    }
    pending = false;
    run();
  };
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fire) : null;
  observer?.observe(host);
  const onWindowResize = () => fire();
  if (typeof window !== "undefined") window.addEventListener("resize", onWindowResize);

  // The falling edge of the gate is what releases the one run a drag is allowed.
  const release = $effect.root(() => {
    $effect(() => {
      if (!dragGate.active && pending) {
        pending = false;
        run();
      }
    });
  });

  return () => {
    observer?.disconnect();
    if (typeof window !== "undefined") window.removeEventListener("resize", onWindowResize);
    release();
  };
}
