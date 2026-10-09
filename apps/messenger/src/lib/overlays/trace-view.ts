import { forgetStored, readStored, writeStored } from "../storage.ts";

/**
 * What fills the flow pane: the trace, the board of tickets, or the spec. One at a time, each with
 * the whole pane — none of them is a strip beside another.
 *
 * The choice is the viewer's and outlives the pane: a board tab that is not in front is unmounted,
 * and coming back to it, or opening another plan, finds the view you left. It is per-browser, like
 * the minimap. A message asking for its card is the one thing that brings the trace back by itself.
 */
export type TraceViewKind = "trace" | "board" | "spec";

const STORAGE_KEY = "real-bot-trace-view";
/** Where the pane has always opened: on the trace. */
export const TRACE_VIEW_DEFAULT: TraceViewKind = "trace";

export function loadTraceView(): TraceViewKind {
  const raw = readStored(STORAGE_KEY);
  return raw === "trace" || raw === "board" || raw === "spec" ? raw : TRACE_VIEW_DEFAULT;
}

export function saveTraceView(view: TraceViewKind): void {
  writeStored(STORAGE_KEY, view);
}

export function forgetTraceView(): void {
  forgetStored(STORAGE_KEY);
}
