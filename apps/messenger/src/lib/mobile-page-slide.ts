import { cubicOut } from "svelte/easing";

/**
 * A phone screen arrives from the right and leaves the same way it came: Back is the reverse of
 * entering, so the two read as one gesture and its undo.
 *
 * That symmetry is the whole point, and it is why there is no notion of direction here. Deciding
 * left-or-right by which destination you came from meant something had to remember the previous
 * one, and everything that closes a screen without going through the tab bar — Back, a ✕, a
 * deleted session — left that memory stale and slid the wrong way.
 *
 * The screen underneath does not move. Only the one on top travels, which is what makes it read
 * as a page being put down and picked back up rather than two pages sliding past each other.
 */
export const MOBILE_PAGE_MS = 220;

/** How far off-screen the page sits at the far end of the transition, in its own widths. */
export const MOBILE_PAGE_OFFSET = 100;

function sliding(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(max-width: 680px)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Use as `transition:pageSlide` — one directive, because in and out are the same path walked in
 * opposite directions. Wider windows and reduced motion get a zero-length transition, so the
 * page just appears and whatever CSS animation belongs to that layout is left alone.
 */
export function pageSlide(_node: Element): {
  duration: number;
  easing: (t: number) => number;
  css: (t: number) => string;
} {
  if (!sliding()) return { duration: 0, easing: cubicOut, css: () => "" };
  return {
    duration: MOBILE_PAGE_MS,
    easing: cubicOut,
    css: (t: number) => `transform: translateX(${((1 - t) * MOBILE_PAGE_OFFSET).toFixed(3)}%)`,
  };
}
