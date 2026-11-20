/**
 * The size of the window the app is in, read in one place (`viewportSize`), and its width
 * breakpoints, cached. Nothing else in the app reads NSH's `windowSize()`
 * (`scripts/viewport-reads.test.ts`).
 *
 * The size changes on every frame of a live resize; a reader of `width <= 680` ran again on each of
 * them, and with a hundred-odd such readers (classes, layouts, `matchMedia` in the mirrored logic) a
 * resize re-ran the app's effects for every frame and NSH's layout fell seconds behind the window. A
 * breakpoint here is a `computed` boolean: its readers hear only when the window crosses it.
 *
 * The computeds are made when this module loads, outside any component, so no component's end can
 * dispose one another still reads. A width not listed falls back to reading the window directly
 * (and says so once): add it to `BREAKPOINTS` instead.
 */
import { computed, windowSize, type Accessor, type Size } from "nsh";

/** The window's size in points (reactive). */
export function viewportSize(): Size {
  return windowSize();
}

/** Every width the app asks about (`<=`), in points: the phone layout (680), the settings' and the menus' (720), and the forms'. */
const BREAKPOINTS = [360, 520, 540, 600, 680, 720, 760] as const;

const atMost = new Map<number, Accessor<boolean>>(BREAKPOINTS.map((width) => [width, computed(() => viewportSize().width <= width)]));
const warned = new Set<number>();

/** True while the window is at most `width` points wide; its readers update only when that flips. */
export function widthAtMost(width: number): boolean {
  const cached = atMost.get(width);
  if (cached) return cached();
  if (!warned.has(width)) {
    warned.add(width);
    console.warn(`viewport: ${width} is not a cached breakpoint; every resize frame re-runs its readers`);
  }
  return viewportSize().width <= width;
}

/** The phone layout's breakpoint (`NARROW_MAX_WIDTH`, 680 points). */
export const narrowViewport = (): boolean => widthAtMost(680);
