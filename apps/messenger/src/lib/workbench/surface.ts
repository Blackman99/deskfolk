/**
 * Which shape the messenger is in.
 *
 * The workbench is a desktop thing. Below the narrow breakpoint, and on a paired phone, the app
 * stays exactly what it has always been: one screen at a time, with a back stack.
 *
 * The gate is `!HOSTED_MESSENGER && wide`, not `isDesktopShell && wide`. Contributing asks for UI
 * to be checked in a running browser, and `isDesktopShell` — which looks for Tauri's globals —
 * would put the dev browser on the phone path, so the feature could not be verified the way the
 * repository says to verify it. A paired phone and the hosted messenger are `HOSTED_MESSENGER`
 * and keep today's shell verbatim.
 */
import { HOSTED_MESSENGER } from "../remote/mode.ts";

/** The one breakpoint that cuts across panes, matching `styles/responsive.css`. */
export const NARROW_MAX_WIDTH = 680;

export function isWorkbenchSurface(shellWidth: number): boolean {
  return !HOSTED_MESSENGER && shellWidth > NARROW_MAX_WIDTH;
}
