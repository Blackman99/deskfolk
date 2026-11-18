import type { Turn } from "@real-bot/protocol";
import type { ApiError } from "../api.ts";
import type { AskDraftRecord, SendAskResult } from "./types.ts";

export function pendingAskIdOf(turn: Pick<Turn, "status" | "id"> & { pending_ask_id?: string | null }): string | null {
  if (turn.status !== "waiting_ask") return null;
  return typeof turn.pending_ask_id === "string" && turn.pending_ask_id.length > 0 ? turn.pending_ask_id : null;
}

export function isExactPendingAsk(
  message: { id: string; kind: string; turn_id: string | null },
  turns: readonly (Pick<Turn, "id" | "status"> & { pending_ask_id?: string | null })[],
  capability: boolean,
): boolean {
  if (message.kind !== "ask" || !message.turn_id) return false;
  const turn = turns.find((row) => row.id === message.turn_id);
  if (!turn || turn.status !== "waiting_ask") return false;
  if (!capability) return false;
  return pendingAskIdOf(turn) === message.id;
}

export function askEndedCopy(
  capability: boolean,
  pendingAskId: string | null | undefined,
  messageId: string,
): "ended" | "waiting_other" | null {
  if (!capability) return "ended";
  if (pendingAskId == null) return "ended";
  if (pendingAskId !== messageId) return "waiting_other";
  return null;
}

/** A retry keeps its request id only while the answer it carries is the same one. */
export function nextDraftVersion(
  current: AskDraftRecord | undefined,
  body: string,
  selected: readonly string[] = current?.selected ?? [],
): AskDraftRecord {
  const same = current?.body === body && sameLabels(current.selected, selected);
  return {
    askId: current?.askId ?? "",
    body,
    selected: [...selected],
    version: (current?.version ?? 0) + 1,
    error: current?.error ?? null,
    ended: current?.ended ?? false,
    requestId: same ? current?.requestId : undefined,
  };
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * Ticking a choice. Single-select swaps (ticking the one already chosen clears it); multi-select
 * toggles. Kept in the question's order, so the draft reads the way the card does.
 */
export function toggleAskChoice(
  options: readonly { label: string }[],
  multiSelect: boolean,
  selected: readonly string[],
  label: string,
): string[] {
  const on = selected.includes(label);
  if (!multiSelect) return on ? [] : [label];
  const next = on ? selected.filter((l) => l !== label) : [...selected, label];
  return options.map((option) => option.label).filter((l) => next.includes(l));
}

export function recordAskError(current: AskDraftRecord | undefined, askId: string, body: string, error: string): AskDraftRecord {
  return {
    askId,
    body,
    selected: current?.selected ?? [],
    version: current?.version ?? 1,
    error,
    ended: current?.ended ?? false,
    requestId: current?.requestId,
  };
}

export function clearAskIfMatching(
  current: AskDraftRecord | undefined,
  submittedVersion: number,
  stillCurrent: boolean,
): AskDraftRecord | undefined {
  if (!current) return undefined;
  if (!stillCurrent) return current;
  if (current.version !== submittedVersion) return current;
  return undefined;
}

export function classifySendAskFailure(error: ApiError, _stillCurrentAsk?: boolean): SendAskResult {
  if (error.status === 422 || error.status === 409) {
    return { status: "rejected", error };
  }
  if (error.code === "request_unknown" || error.code === "request_pending") {
    return { status: "unknown", request_id: error.requestId, error };
  }
  return { status: "rejected", error };
}

export function askSubmitAllowed(
  connected: boolean,
  busy: boolean,
  body: string,
  pendingAskId: string | null | undefined,
  askId: string,
  capability: boolean,
  selectedCount = 0,
): SendAskResult | null {
  const text = body.trim();
  if (!text && selectedCount === 0) return { status: "not_submitted", reason: "empty" };
  if (!connected) return { status: "not_submitted", reason: "disconnected" };
  if (busy) return { status: "not_submitted", reason: "busy" };
  if (!capability || pendingAskId !== askId) return { status: "not_submitted", reason: "stale_ask" };
  return null;
}
