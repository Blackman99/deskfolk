import type { TicketStatus } from "@real-bot/protocol";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import type { TraceFocus } from "./task-trace.ts";

/**
 * The parts of a job's one tab (ADR 0086): its tickets (`board`: the rail, or the board opened out),
 * its trace, and its spec. A wide job has all three side by side; a narrow one — a phone, a narrow
 * pane — has one at a time behind the switch in its title row, and that choice is the viewer's and
 * outlives the page, per-browser like the minimap. A message asking for its card is the one thing
 * that brings the trace back by itself.
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
 * What a tab was asked to show as it is brought up: a ticket to pick, a column to let through, a
 * card to land on. The request travels with the tab, and is acted on once.
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
