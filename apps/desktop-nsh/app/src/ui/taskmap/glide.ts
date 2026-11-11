/**
 * Values that glide to where they are asked (the CSS `transition` the Svelte map leaned on): the
 * town's camera and a character's walk. `glide(target, ms)` gives a reader that follows `target()`
 * over `ms()` milliseconds on the map's curve, at once when `ms()` is 0 (a drag, a turn) or on its
 * first value.
 */
import { effect, signal, untracked } from "nsh";

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time 0..1. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 6; i++) {
      const err = X(s) - t;
      if (Math.abs(err) < 1e-4) break;
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    return Y(Math.min(1, Math.max(0, s)));
  };
}

/** The map's curve (`cubic-bezier(.3, .7, .3, 1)`). */
export const MAP_EASE = bezier(0.3, 0.7, 0.3, 1);

export function glide(target: () => readonly number[], ms: () => number): () => readonly number[] {
  const shown = signal<readonly number[] | null>(null);
  let raf = 0;
  effect(() => {
    const to = target();
    const dur = ms();
    const from = untracked(shown);
    cancelAnimationFrame(raf);
    if (!from || dur <= 0 || from.length !== to.length || from.every((v, i) => v === to[i])) {
      shown.set(to);
      return;
    }
    const t0 = performance.now();
    const start = [...from];
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / dur);
      const e = MAP_EASE(u);
      shown.set(to.map((v, i) => start[i]! + (v - start[i]!) * e));
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });
  return () => shown() ?? target();
}
