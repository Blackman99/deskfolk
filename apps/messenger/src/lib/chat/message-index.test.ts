import { expect, test } from "bun:test";
import { aMessage } from "../test-fixtures.ts";
import { activeIndexMark, indexPreview, messageIndexMarks } from "./message-index.ts";
import type { TranscriptItem } from "./transcript.ts";

function items(): TranscriptItem[] {
  return (["user", "bot", "ask", "approval", "system", "profile_change"] as const).map((kind, index) => ({
    type: "message", message: aMessage({ id: `m${index}`, kind, body: kind }),
  }));
}

test("all visible message kinds have individual anchors", () => {
  const marks = messageIndexMarks(items());
  expect(marks.map((mark) => mark.kind)).toEqual(["user", "bot", "ask", "approval", "system"]);
  expect(marks.map((mark) => mark.index)).toEqual([0, 1, 2, 3, 4]);
});

test("previews update when a message changes without changing its identity", () => {
  const transcript = items();
  const old = messageIndexMarks(transcript);
  if (transcript[1]?.type === "message") transcript[1].message.body = "updated reply";
  expect(messageIndexMarks(transcript)[1]?.preview).toBe("updated reply");
  expect(old[1]?.preview).toBe("bot");
});

test("all loaded messages remain indexed beyond the mounting window", () => {
  const transcript: TranscriptItem[] = Array.from({ length: 500 }, (_, i) => ({
    type: "message", message: aMessage({ id: `m${i}`, kind: "bot" }),
  }));
  expect(messageIndexMarks(transcript)).toHaveLength(500);
});

test("previews fold whitespace and keep emoji intact", () => {
  expect(indexPreview("  a\n b ")).toBe("a b");
  expect(indexPreview("😀😀😀", 2)).toBe("😀😀…");
});

test("current anchor follows the visible message with jump margin", () => {
  const marks = messageIndexMarks(items());
  const positions = new Map([["m0", 20], ["m1", 400], ["m2", 900]]);
  expect(activeIndexMark(marks, positions, 0)).toBe("m0");
  expect(activeIndexMark(marks, positions, 376)).toBe("m1");
  expect(activeIndexMark(marks, positions, 0, true)).toBe("m4");
});
