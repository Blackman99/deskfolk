/**
 * How the sidebar folds to its rail and back (⌘B): every number of it, in one place.
 *
 * Three things move, each its own way:
 *
 * - **The edge.** The column's width eases between the sidebar's and the rail's a frame at a time,
 *   each frame laid out afresh (`shell-state.ts`). It starts soft, is quickest a third of the way in
 *   and settles slowly: `cubic-bezier(0.25, 0, 0.35, 1)`. Its fastest frame is about twice the
 *   average one, and beside a long reply a step over some 25 points takes longer than a frame to lay
 *   out, so the fold takes longer the farther it goes (`sidebarFoldMs`). It never overshoots: the
 *   panes beside it would wrap twice.
 * - **The words** (names, last lines, times, headings, the brand row, the foot's labels): they
 *   follow how open the column is, fading and drawing in towards the avatars over the outer part of
 *   the way (`FOLD_TEXT`). Folding, they are gone before the edge has gone far; unfolding, they come
 *   last, once there is room for them.
 * - **The icons.** The open sidebar's avatars and buttons hold still while the words go; near the
 *   rail they hand over to it (`FOLD_SIDEBAR`). The rail's own icons grow into place one after
 *   another from the top, a little past their size and back, as the edge settles (`foldRailIcon`).
 *
 * The words and the icons are native animated bindings driven by one value, how open the column is
 * (`foldOpenness`, 0 at the rail, 1 at the sidebar's width), set at each frame with the width. So
 * they cannot drift from the edge, and a fold turned back halfway goes back from where it is. At
 * rest every one of them is exactly as it would be without the fold.
 */

/** The fold's shortest and longest run. */
export const FOLD_MIN_MS = 280;
export const FOLD_MAX_MS = 420;
/** The most the edge should move in one frame: beside a long reply some 25 points still lay out in a frame. */
export const FOLD_STEP_PT = 26;
const FRAME_MS = 1000 / 60;

/** The edge's curve, as CSS writes it. */
export const FOLD_EDGE_EASE = [0.25, 0, 0.35, 1] as const;

/** A CSS cubic-bezier timing function. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (t: number) => ((ax * t + bx) * t + cx) * t;
  const y = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let t = u;
    for (let i = 0; i < 6; i++) {
      const err = x(t) - u;
      const slope = dx(t);
      if (Math.abs(err) < 1e-6) return y(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= err / slope;
    }
    // Newton lost its way (a flat spot): halve the interval instead.
    let lo = 0, hi = 1;
    t = u;
    for (let i = 0; i < 30; i++) {
      if (x(t) < u) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return y(t);
  };
}

const edgeEase = cubicBezier(...FOLD_EDGE_EASE);

/** How many average frames the curve's fastest frame covers (measured once at 60 fps). */
const EDGE_PEAK = (() => {
  const frames = 60;
  let peak = 0;
  for (let i = 1; i <= frames; i++) peak = Math.max(peak, (edgeEase(i / frames) - edgeEase((i - 1) / frames)) * frames);
  return peak;
})();

/** How long a fold of `distance` points takes: long enough that no frame moves the edge much past `FOLD_STEP_PT`. */
export function sidebarFoldMs(distance: number): number {
  const ms = (FRAME_MS * EDGE_PEAK * Math.abs(distance)) / FOLD_STEP_PT;
  return Math.round(Math.min(FOLD_MAX_MS, Math.max(FOLD_MIN_MS, ms)));
}

/** The column's width a while into easing from one width to another, and `null` once it is there. */
export function sidebarFoldAt(from: number, to: number, elapsedMs: number, durationMs = sidebarFoldMs(to - from)): number | null {
  if (elapsedMs >= durationMs) return null;
  return from + (to - from) * edgeEase(Math.max(0, elapsedMs) / durationMs);
}

/** How open the column is at `width`: 0 at the rail, 1 at the sidebar's width. */
export function foldOpenness(width: number, rail: number, full: number): number {
  if (full <= rail) return 1;
  return Math.min(1, Math.max(0, (width - rail) / (full - rail)));
}

/** A binding's keyframes over how open the column is (`AnimatedNode.interpolate`, clamped at both ends). */
export type FoldKeys = { inputRange: number[]; outputRange: number[] };

/**
 * The words: gone below 60 % open, drawn in by 10 points towards the avatars on their way out
 * (and out from them on their way in).
 */
export const FOLD_TEXT = {
  opacity: { inputRange: [0.6, 1], outputRange: [0, 1] },
  translateX: { inputRange: [0.6, 1], outputRange: [-10, 0] },
} satisfies Record<string, FoldKeys>;

/** The open sidebar's avatars and buttons: whole until the rail's icons come, gone just short of the rail. */
export const FOLD_SIDEBAR = {
  opacity: { inputRange: [0.03, 0.32], outputRange: [0, 1] },
} satisfies Record<string, FoldKeys>;

/** The rail's icons: each one's span of the way, the one after it settling this much later, the tenth and on together. */
const RAIL_SPAN = 0.16;
const RAIL_STAGGER = 0.008;
export const RAIL_STAGGER_CAP = 10;
/** How small an icon starts and how far past its size it grows before settling. */
const RAIL_FROM_SCALE = 0.84;
const RAIL_OVERSHOOT = 1.04;

/**
 * The rail's icon at `order` (top first). Folding, it comes in over its span of the way: it fades in
 * over the first half while it grows from `RAIL_FROM_SCALE`, goes a little past its size and is back
 * at it before the column is shut, the ones under it a step later. Unfolding plays the same
 * backwards, and as the edge leaves the rail quicker than it settles on it, the icons go quicker
 * than they came.
 */
export function foldRailIcon(order: number): { opacity: FoldKeys; scale: FoldKeys } {
  const done = (RAIL_STAGGER_CAP - Math.min(Math.max(0, order), RAIL_STAGGER_CAP)) * RAIL_STAGGER;
  return {
    opacity: { inputRange: [done, done + RAIL_SPAN * 0.5, done + RAIL_SPAN], outputRange: [1, 1, 0] },
    scale: { inputRange: [done, done + RAIL_SPAN * 0.4, done + RAIL_SPAN], outputRange: [1, RAIL_OVERSHOOT, RAIL_FROM_SCALE] },
  };
}

/** A binding's value at `openness` (what `interpolate` gives, for tests and for reading a frame). */
export function foldValue(keys: FoldKeys, openness: number): number {
  const { inputRange: input, outputRange: output } = keys;
  if (openness <= input[0]!) return output[0]!;
  for (let i = 1; i < input.length; i++) {
    if (openness <= input[i]!) {
      const span = input[i]! - input[i - 1]!;
      const u = span === 0 ? 1 : (openness - input[i - 1]!) / span;
      return output[i - 1]! + (output[i]! - output[i - 1]!) * u;
    }
  }
  return output[output.length - 1]!;
}
