/**
 * Which shape the messenger is in.
 *
 * The workbench is a desktop thing. Below the narrow breakpoint, and on a paired phone, the app
 * stays exactly what it has always been: one screen at a time, with a back stack.
 *
 * The gate is `!HOSTED_MESSENGER && !narrow`, not `isDesktopShell && !narrow`. Contributing asks
 * for UI to be checked in a running browser, and `isDesktopShell` — which looks for Tauri's
 * globals — would put the dev browser on the phone path, so the feature could not be verified the
 * way the repository says to verify it. A paired phone keeps today's shell verbatim, and so does
 * the hosted messenger at a phone's width. At a tablet's width it keeps the columns without the
 * panes, which is why folding the list to its rail goes by `sidebarFolds` here and not by this.
 *
 * "Narrow" is read from the same media query the stylesheet uses rather than from a measured
 * width: an element that has not been laid out yet reports zero, and a workbench that appears for
 * one frame on a phone because of that is worse than one that appears a frame late.
 */
import { HOSTED_MESSENGER } from "../remote/mode.ts";

/** The one breakpoint that cuts across panes, matching `styles/responsive.css`. */
export const NARROW_MAX_WIDTH = 680;
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

/**
 * `hosted` is a parameter only so a test can ask about the client this machine is not building;
 * the app always passes the compiled constant.
 */
export function isWorkbenchSurface(narrow: boolean, hosted = HOSTED_MESSENGER): boolean {
  return !hosted && !narrow;
}

/**
 * Whether the session list can fold down to its rail of avatars. Deliberately not
 * `isWorkbenchSurface`: folding is about the list being a column of the shell, not about the panes,
 * so the paired client on a tablet — which keeps the columns and not the workbench — folds it too.
 * At or below the breakpoint the list is a screen of its own, and there is nothing to fold.
 */
export function sidebarFolds(narrow: boolean): boolean {
  return !narrow;
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
