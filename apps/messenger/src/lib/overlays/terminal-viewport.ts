import { keyboardInset } from "../chat/composer-inset.ts";

type VisualViewportLike = { height: number; offsetTop: number; scale?: number };

/**
 * Where the phone's terminal page sits while a software keyboard is up: the part of the screen
 * the keyboard leaves.
 *
 * On iOS the keyboard shrinks the visual viewport and leaves the layout viewport alone, so a page
 * pinned to the layout viewport keeps its key bar behind the keyboard — the one moment it is
 * needed — and iOS then scrolls to bring the cursor into view and takes the header off the top.
 * Following the visual viewport keeps both on screen and hands the terminal fewer rows instead.
 *
 * Null when no keyboard is up, and while pinch-zoomed: the visible area is then a lens over the
 * page, not room the page should shrink into.
 */
export function keyboardViewport(
  innerHeight: number,
  viewport?: VisualViewportLike | null,
): { top: number; height: number } | null {
  if (!viewport || (viewport.scale ?? 1) > 1.01) return null;
  if (keyboardInset(innerHeight, viewport) === 0) return null;
  return { top: Math.round(viewport.offsetTop), height: Math.round(viewport.height) };
}
