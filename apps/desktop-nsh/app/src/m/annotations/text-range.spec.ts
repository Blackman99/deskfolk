import { expect, test } from "bun:test";
import type { Annotation } from "@real-bot/protocol";
import { anchorFromSelection, decorationClass, isEmptyRange, rangeForAnnotation, wholeLineRange } from "./text-range.ts";

const TEXT = "# Title\n\nfirst paragraph\n\nsecond paragraph\n";

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "report.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 1, end_line: 3, end_col: 16, quote: "first paragraph", prefix: "# Title\n\n", suffix: "\n\nsecond" },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "太长",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

test("a selection becomes an anchor with the quote and its affixes, and comes back as the same range", () => {
  const anchor = anchorFromSelection(TEXT, { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 16 });
  expect(anchor).toEqual({ start_line: 3, start_col: 1, end_line: 3, end_col: 16, quote: "first paragraph", prefix: "# Title\n\n", suffix: "\n\nsecond paragraph\n" });
  expect(rangeForAnnotation(row({ anchor }))).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 16 });
});

test("a tap on a line number selects that whole line, clamped to the file", () => {
  expect(wholeLineRange(TEXT, 3)).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 16 });
  expect(wholeLineRange(TEXT, 99)).toEqual({ startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 });
  expect(isEmptyRange({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 })).toBe(true);
});

test("a moved annotation is drawn where the daemon found it; a changed one is looked up in the buffer; a missing one is not drawn", () => {
  expect(rangeForAnnotation(row({ stale: { kind: "moved", start_line: 5, start_col: 1, end_line: 5, end_col: 16 } }))).toEqual({
    startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 16,
  });
  expect(rangeForAnnotation(row({ stale: { kind: "changed" } }), "intro\n\n# Title\n\nfirst paragraph\n")).toEqual({
    startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 16,
  });
  expect(rangeForAnnotation(row({ stale: { kind: "changed" } }), "nothing here")).toBeNull();
  expect(rangeForAnnotation(row({ stale: { kind: "missing" } }))).toBeNull();
  expect(rangeForAnnotation(row({ anchor_kind: "image_region", anchor: { x: 0, y: 0, w: 1, h: 1, natural_width: 1, natural_height: 1 } }))).toBeNull();
});

test("the decoration class names the status and staleness", () => {
  expect(decorationClass(row())).toBe("rb-annot rb-annot-open");
  expect(decorationClass(row({ status: "draft" }))).toBe("rb-annot rb-annot-draft");
  expect(decorationClass(row({ status: "resolved", stale: { kind: "changed" } }))).toBe("rb-annot rb-annot-resolved is-stale");
});
