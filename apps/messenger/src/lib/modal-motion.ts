import { cubicIn } from "svelte/easing";
import { pageSlide } from "./mobile-page-slide.ts";

/** How long a dialog takes to fade away on a wider window. */
export const MODAL_OUT_MS = 140;

function fading(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  // The component tests' DOM: its animations never finish, so a fading dialog would stay in the tree.
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("HappyDOM")) return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Use as `out:modalOut` on a dialog's backdrop. A dialog arrives with the CSS animations in
 * `modals.css` (the backdrop fades in, the card scales up); before this it vanished the moment it
 * closed. Now it fades out with its backdrop, quicker than it came. On a phone a dialog that is a
 * page (`page-on-phone`) walks back out the way it came in instead, exactly as `pageSlide`;
 * `instant` keeps that page still, as it does for `pageSlide`.
 */
export function modalOut(
  node: Element,
  params: { instant?: boolean } = {},
): { duration: number; easing: (t: number) => number; css: (t: number) => string } {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 680px)").matches) {
    return pageSlide(node, params);
  }
  if (!fading()) return { duration: 0, easing: cubicIn, css: () => "" };
  return { duration: MODAL_OUT_MS, easing: cubicIn, css: (t: number) => `opacity: ${t.toFixed(3)}` };
}
