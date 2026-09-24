import { expect, test } from "bun:test";
import { NARROW_MAX_WIDTH, NARROW_QUERY, isWorkbenchSurface, watchNarrow } from "./surface.ts";

test("the workbench is for wide windows and never for narrow ones", () => {
  expect(isWorkbenchSurface(false)).toBe(true);
  expect(isWorkbenchSurface(true)).toBe(false);
});

test("the breakpoint is the one the stylesheet uses", () => {
  // responsive.css owns the same number; a second opinion about it is how they drift.
  expect(NARROW_MAX_WIDTH).toBe(680);
  expect(NARROW_QUERY).toBe("(max-width: 680px)");
});

test("following the breakpoint reports what it is now and every change after", () => {
  const seen: boolean[] = [];
  let listener: ((event: { matches: boolean }) => void) | null = null;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === NARROW_QUERY,
    media: query,
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => (listener = fn),
    removeEventListener: () => (listener = null),
  })) as unknown as typeof window.matchMedia;
  try {
    const stop = watchNarrow((narrow) => seen.push(narrow));
    expect(seen).toEqual([true]);
    listener?.({ matches: false });
    expect(seen).toEqual([true, false]);
    stop();
    expect(listener).toBeNull();
  } finally {
    window.matchMedia = original;
  }
});

test("without matchMedia the app is treated as wide rather than left undecided", () => {
  const original = window.matchMedia;
  // @ts-expect-error -- deliberately removing it, the way a bare server render has none.
  window.matchMedia = undefined;
  try {
    const seen: boolean[] = [];
    watchNarrow((narrow) => seen.push(narrow));
    expect(seen).toEqual([false]);
  } finally {
    window.matchMedia = original;
  }
});
