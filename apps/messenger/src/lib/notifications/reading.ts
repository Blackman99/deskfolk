import { STREAM_NEAR_BOTTOM_PX } from "../chat/stream-scroll.ts";
import type { NativeNotificationCapabilities, NativeReadingFacts } from "./types.ts";

export const ROW_VISIBLE_MS = 1000;
export const TRANSCRIPT_VISIBLE_MS = 1000;
export const READ_SUBMIT_DEBOUNCE_MS = 1000;
export const PRESENCE_HEARTBEAT_MS = 5000;
export const PRESENCE_LEASE_MS = 10_000;

export type PageReadingFacts = {
  visibility: DocumentVisibilityState;
  hasFocus: boolean;
  connected: boolean;
  snapshotReady: boolean;
  overlayBlocksTranscript: boolean;
};

export type DesktopReadingMode = "auto" | "explicit_only";

export function desktopReadingMode(
  isDesktopShell: boolean,
  native: NativeNotificationCapabilities,
): DesktopReadingMode {
  if (!isDesktopShell) return "auto";
  return native.native_reading_v1 ? "auto" : "explicit_only";
}

export function pageIsForeground(facts: PageReadingFacts): boolean {
  return facts.visibility === "visible" && facts.hasFocus && facts.connected && facts.snapshotReady;
}

export function transcriptReadingReady(
  facts: PageReadingFacts,
  mode: DesktopReadingMode,
  native?: NativeReadingFacts | null,
): boolean {
  if (!pageIsForeground(facts) || facts.overlayBlocksTranscript) return false;
  if (mode === "explicit_only") return false;
  if (native) return native.visible && native.focused && !native.minimized;
  return true;
}

export function inboxRowReadingReady(
  facts: Omit<PageReadingFacts, "overlayBlocksTranscript">,
  inboxOpen: boolean,
  mode: DesktopReadingMode,
  native?: NativeReadingFacts | null,
): boolean {
  if (!inboxOpen || !pageIsForeground({ ...facts, overlayBlocksTranscript: false })) return false;
  if (mode === "explicit_only") return false;
  if (native) return native.visible && native.focused && !native.minimized;
  return true;
}

export function atLatestFromScroll(
  nearBottom: boolean,
  thresholdPx: number = STREAM_NEAR_BOTTOM_PX,
): boolean {
  void thresholdPx;
  return nearBottom;
}

export type VisibleBound = { messageId: string; seq?: number | null };

export function pickReadThrough(
  rendered: readonly VisibleBound[],
  atLatest: boolean,
  heldMs: number,
): VisibleBound | null {
  if (!atLatest || heldMs < TRANSCRIPT_VISIBLE_MS || rendered.length === 0) return null;
  let best: VisibleBound | null = null;
  for (const row of rendered) {
    if (!best) {
      best = row;
      continue;
    }
    const seq = row.seq ?? -1;
    const bestSeq = best.seq ?? -1;
    if (seq > bestSeq) best = row;
  }
  return best;
}

export function shouldSubmitBoundedRead(
  capability: boolean,
  throughMessageId: string | null | undefined,
): throughMessageId is string {
  return capability && typeof throughMessageId === "string" && throughMessageId.length > 0;
}

export type VisibleRowClock = { id: string; firstVisibleAt: number };

export function rowsReadyToMark(
  visibleIds: readonly string[],
  clocks: ReadonlyMap<string, number>,
  now: number,
  ready: boolean,
): string[] {
  if (!ready) return [];
  const out: string[] = [];
  for (const id of visibleIds) {
    const since = clocks.get(id);
    if (since != null && now - since >= ROW_VISIBLE_MS) out.push(id);
  }
  return out;
}

export function mergeRowClocks(
  previous: ReadonlyMap<string, number>,
  visibleIds: readonly string[],
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  const visible = new Set(visibleIds);
  for (const id of visible) next.set(id, previous.get(id) ?? now);
  return next;
}
