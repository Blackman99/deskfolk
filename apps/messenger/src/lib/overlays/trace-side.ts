import { forgetStored, readStored, writeStored } from "../storage.ts";

/**
 * What opens beside the flow on a wide board: the plan's spec, its tickets, or nothing.
 *
 * One at a time, and beside the board rather than over it. The choice is the viewer's and outlives
 * the pane: a board tab that is not in front is unmounted, and one you closed the panel on should
 * come back closed. It is per-browser, like the preview's width.
 */
export type TraceSide = "spec" | "tickets" | null;

const STORAGE_KEY = "real-bot-trace-side";
/** The tickets, as the rail beside the board always was; the spec is a press away. */
export const TRACE_SIDE_DEFAULT: TraceSide = "tickets";

export function loadTraceSide(): TraceSide {
  const raw = readStored(STORAGE_KEY);
  if (raw === "spec" || raw === "tickets") return raw;
  if (raw === "none") return null;
  return TRACE_SIDE_DEFAULT;
}

export function saveTraceSide(side: TraceSide): void {
  writeStored(STORAGE_KEY, side ?? "none");
}

export function forgetTraceSide(): void {
  forgetStored(STORAGE_KEY);
}
