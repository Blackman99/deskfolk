import type { TicketStatus } from "@real-bot/protocol";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import type { TraceFocus } from "./task-trace.ts";

/**
 * What fills the flow pane: the trace, the board of tickets, or the spec. One at a time, each with
 * the whole pane — none of them is a strip beside another.
 *
 * On a wide window each view is a tab of its own, so they can sit side by side, float, or be closed
 * one by one. On a phone the job is one page and its switch picks the view; that choice is the
 * viewer's and outlives the page, per-browser like the minimap. A message asking for its card is
 * the one thing that brings the trace back by itself.
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

/** A view a tab names, read back from its parameters. Anything else is the trace, which every flow tab was. */
export function traceViewOf(raw: string | null | undefined): TraceViewKind {
  return raw === "board" || raw === "spec" ? raw : TRACE_VIEW_DEFAULT;
}

/**
 * What one view of a job asks another to show as it brings it up: the spec's ticket number brings
 * the board up on that card, the board's 「在流程里看」 the trace on its newest round. With each
 * view its own tab, the request travels with the tab rather than as state the views share.
 */
export type TraceViewAsk = {
  /** The ticket to pick: lit on the trace, in view on the board, held to on the spec. */
  ticket?: string | null;
  /** The board's column to bring up. */
  column?: TicketStatus | null;
  /** The card the trace comes up on. */
  focus?: TraceFocus | null;
};

/**
 * The requests each view has acted on, by conversation and view. A tab that is not in front is
 * unmounted, and the request it was opened with is still on it when it comes back; acting on it
 * again would take back whatever you picked since.
 */
const spentAsks = new Map<string, number>();

function askKey(sessionId: string, view: TraceViewKind): string {
  return `${sessionId}:${view}`;
}

export function askSpent(sessionId: string, view: TraceViewKind, token: number): boolean {
  return spentAsks.get(askKey(sessionId, view)) === token;
}

export function spendAsk(sessionId: string, view: TraceViewKind, token: number): void {
  spentAsks.set(askKey(sessionId, view), token);
}

/** For tests: no view has acted on anything yet. */
export function forgetSpentAsks(): void {
  spentAsks.clear();
}
