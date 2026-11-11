/**
 * The window's width breakpoints, cached. `windowSize()` changes on every frame of a live resize;
 * a reader of `windowSize().width <= 680` ran again on each of them, and with a hundred-odd such
 * readers (classes, layouts, `matchMedia` in the mirrored logic) a resize re-ran the app's effects
 * for every frame and NSH's layout fell seconds behind the window. A breakpoint here is a `computed`
 * boolean: its readers hear only when the window crosses it.
 *
 * The computeds are made when this module loads, outside any component, so no component's end can
 * dispose one another still reads. A width not listed falls back to reading the window directly
 * (and says so once): add it to `BREAKPOINTS` instead.
 */
import { computed, windowSize, type Accessor } from "nsh";

/** Every width the app asks about (`<=`), in points: the phone layout (680), the settings' and the menus' (720), and the forms'. */
const BREAKPOINTS = [360, 520, 540, 600, 680, 720, 760] as const;

const atMost = new Map<number, Accessor<boolean>>(BREAKPOINTS.map((width) => [width, computed(() => windowSize().width <= width)]));
const warned = new Set<number>();

/** True while the window is at most `width` points wide; its readers update only when that flips. */
export function widthAtMost(width: number): boolean {
  const cached = atMost.get(width);
  if (cached) return cached();
  if (!warned.has(width)) {
    warned.add(width);
    console.warn(`viewport: ${width} is not a cached breakpoint; every resize frame re-runs its readers`);
  }
  return windowSize().width <= width;
}

/** The phone layout's breakpoint (`NARROW_MAX_WIDTH`, 680 points). */
export const narrowViewport = (): boolean => widthAtMost(680);
