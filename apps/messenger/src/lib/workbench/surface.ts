/**
 * Which shape the messenger is in.
 *
 * The workbench is a desktop thing. Below the narrow breakpoint, and on a paired phone, the app
 * stays exactly what it has always been: one screen at a time, with a back stack.
 *
 * The gate is `!HOSTED_MESSENGER && !narrow`, not `isDesktopShell && !narrow`. Contributing asks
 * for UI to be checked in a running browser, and `isDesktopShell` — which looks for Tauri's
 * globals — would put the dev browser on the phone path, so the feature could not be verified the
 * way the repository says to verify it. A paired phone and the hosted messenger are
 * `HOSTED_MESSENGER` and keep today's shell verbatim.
 *
 * "Narrow" is read from the same media query the stylesheet uses rather than from a measured
 * width: an element that has not been laid out yet reports zero, and a workbench that appears for
 * one frame on a phone because of that is worse than one that appears a frame late.
 */
import { HOSTED_MESSENGER } from "../remote/mode.ts";

/** The one breakpoint that cuts across panes, matching `styles/responsive.css`. */
export const NARROW_MAX_WIDTH = 680;
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

export function isWorkbenchSurface(narrow: boolean): boolean {
  return !HOSTED_MESSENGER && !narrow;
}

/** Follow the breakpoint. Returns a function that stops following. */
export function watchNarrow(onChange: (narrow: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    onChange(false);
    return () => {};
  }
  const query = window.matchMedia(NARROW_QUERY);
  onChange(query.matches);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}
