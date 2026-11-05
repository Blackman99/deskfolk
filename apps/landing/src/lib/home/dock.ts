/**
 * Where the usage ball comes to rest after a drag, as the app's own widget does it (behavior.md,
 * 用量): wherever it is let go, kept inside the window and clear of the nav; let go within SNAP px
 * of the left or right edge, it sticks to that edge with half of it tucked out of sight. Plain
 * numbers, so the component only animates toward what is worked out here.
 */

export type Box = { x: number; y: number; size: number };
export type Viewport = { width: number; height: number };
export type Dock = { x: number; y: number; side: 'left' | 'right' | null };

/** Nav height plus a little air: the ball never docks higher than this. */
export const TOP_CLEAR = 76;

/** A press that moves less than this many px is a click, not a drag. */
export const TAP_SLOP = 4;

/** Let go this close to a side edge (px) and the ball sticks to it, as in the app. */
export const SNAP = 24;

export const isTap = (dx: number, dy: number) => Math.hypot(dx, dy) < TAP_SLOP;

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : v < lo ? lo : v > hi ? hi : v);

/**
 * The spot a ball let go at `box` settles on: stuck to a side, half tucked away, when it is within
 * SNAP px of it; otherwise where it is, at least `margin` px inside the window and below the nav.
 */
export function restAt(box: Box, viewport: Viewport, margin = 16, top = TOP_CLEAR): Dock {
  const y = clamp(box.y, top, viewport.height - box.size - margin);
  if (box.x <= SNAP) return { x: -box.size / 2, y, side: 'left' };
  if (box.x + box.size >= viewport.width - SNAP) return { x: viewport.width - box.size / 2, y, side: 'right' };
  return { x: clamp(box.x, margin, viewport.width - box.size - margin), y, side: null };
}

/** Which way a panel opens from the ball: toward the middle of the page, both across and down/up. */
export function panelPlacement(box: Box, viewport: Viewport): { h: 'right' | 'left'; v: 'down' | 'up' } {
  const cx = box.x + box.size / 2;
  const cy = box.y + box.size / 2;
  return { h: cx < viewport.width / 2 ? 'right' : 'left', v: cy < viewport.height / 2 ? 'down' : 'up' };
}
