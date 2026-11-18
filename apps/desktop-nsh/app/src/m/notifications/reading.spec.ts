import { expect, test } from "bun:test";
import {
  desktopReadingMode,
  inboxRowReadingReady,
  mergeRowClocks,
  pickReadThrough,
  rowsReadyToMark,
  shouldSubmitBoundedRead,
  transcriptReadingReady,
  TRANSCRIPT_VISIBLE_MS,
} from "./reading.ts";

const foreground = {
  visibility: "visible" as const,
  hasFocus: true,
  connected: true,
  snapshotReady: true,
  overlayBlocksTranscript: false,
};

test("desktop without native_reading_v1 never auto-reads", () => {
  expect(desktopReadingMode(true, { native_reading_v1: false, native_delivery_v1: false })).toBe("explicit_only");
  expect(transcriptReadingReady(foreground, "explicit_only")).toBe(false);
  expect(inboxRowReadingReady(foreground, true, "explicit_only")).toBe(false);
});

test("browser PWA auto-reads only when focused, visible, connected, and unobstructed", () => {
  expect(transcriptReadingReady(foreground, "auto")).toBe(true);
  expect(transcriptReadingReady({ ...foreground, overlayBlocksTranscript: true }, "auto")).toBe(false);
  expect(transcriptReadingReady({ ...foreground, hasFocus: false }, "auto")).toBe(false);
  expect(transcriptReadingReady({ ...foreground, snapshotReady: false }, "auto")).toBe(false);
});

test("desktop auto mode still needs native window facts", () => {
  expect(transcriptReadingReady(foreground, "auto", { visible: true, focused: true, minimized: false })).toBe(true);
  expect(transcriptReadingReady(foreground, "auto", { visible: true, focused: false, minimized: false })).toBe(false);
  expect(transcriptReadingReady(foreground, "auto", { visible: true, focused: true, minimized: true })).toBe(false);
});

test("read-through only submits a rendered at-latest bound after the hold", () => {
  const rows = [
    { messageId: "m1", seq: 1 },
    { messageId: "m3", seq: 3 },
    { messageId: "m2", seq: 2 },
  ];
  expect(pickReadThrough(rows, false, TRANSCRIPT_VISIBLE_MS)).toBeNull();
  expect(pickReadThrough(rows, true, TRANSCRIPT_VISIBLE_MS - 1)).toBeNull();
  expect(pickReadThrough(rows, true, TRANSCRIPT_VISIBLE_MS)?.messageId).toBe("m3");
  expect(shouldSubmitBoundedRead(true, "m3")).toBe(true);
  expect(shouldSubmitBoundedRead(false, "m3")).toBe(false);
  expect(shouldSubmitBoundedRead(true, null)).toBe(false);
});

test("inbox rows mark after one second visible and drop clocks that left the viewport", () => {
  const first = mergeRowClocks(new Map(), ["a", "b"], 1000);
  expect(rowsReadyToMark(["a", "b"], first, 1500, true)).toEqual([]);
  expect(rowsReadyToMark(["a", "b"], first, 2000, true)).toEqual(["a", "b"]);
  expect(rowsReadyToMark(["a", "b"], first, 2000, false)).toEqual([]);
  const next = mergeRowClocks(first, ["b"], 3000);
  expect(next.has("a")).toBe(false);
  expect(next.get("b")).toBe(1000);
});
