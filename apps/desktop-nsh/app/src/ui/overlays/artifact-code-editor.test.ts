/**
 * The editor's line endings: `\r\n` and a lone `\r` fold to `\n`; a text without `\r` is left as it is.
 * A file read again goes into the editor as one edit of the span that changed (`changedSpan`).
 */
import { expect, test } from "nsh/test";
import type { EditorEdit, EditorPosition } from "nsh/base";
import { changedSpan, foldLineEndings } from "./artifact-code-editor";

test("carriage returns fold to line feeds", () => {
  expect(foldLineEndings("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  expect(foldLineEndings("\r\r\n")).toBe("\n\n");
});

test("a text with none is the same string", () => {
  const text = "a\nb\n".repeat(1000);
  expect(foldLineEndings(text)).toBe(text);
  expect(foldLineEndings("")).toBe("");
});

/** What the Editor makes of `edit` on `text`: its positions as offsets, the span replaced. */
function apply(text: string, edit: EditorEdit): string {
  const lines = text.split("\n");
  const offset = (at: EditorPosition) => lines.slice(0, at.line).reduce((sum, line) => sum + line.length + 1, 0) + at.column;
  return text.slice(0, offset(edit.range.start)) + edit.text + text.slice(offset(edit.range.end));
}

test("the same text is no edit", () => {
  expect(changedSpan("a\nb\n", "a\nb\n")).toBeNull();
  expect(changedSpan("", "")).toBeNull();
});

test("a change is the span between what the two share at the start and at the end", () => {
  expect(changedSpan("one\ntwo\nthree\n", "one\n2\nthree\n")).toEqual({
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
    text: "2",
  });
  // Lines added at the end (a log a Bot writes to): an insertion where the old text ended.
  expect(changedSpan("a\nb\n", "a\nb\nc\nd\n")).toEqual({
    range: { start: { line: 2, column: 0 }, end: { line: 2, column: 0 } },
    text: "c\nd\n",
  });
  // Lines taken out.
  expect(changedSpan("a\nb\nc\n", "a\nc\n")).toEqual({
    range: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } },
    text: "",
  });
});

test("every edit makes the new text out of the old", () => {
  const cases: Array<[string, string]> = [
    ["", "hello\n"],
    ["hello\n", ""],
    ["abc", "abXc"],
    ["aaaa", "aa"],
    ["x\ny\nz", "x\nY\nY\nz"],
    ["same start, other end", "same start, new end\n"],
    ["😀 face", "😁 face"],
    ["a😀b", "a😀😀b"],
    ["tail 😀", "tail 😁"],
  ];
  for (const [before, after] of cases) {
    const edit = changedSpan(before, after);
    expect(edit).not.toBeNull();
    expect(apply(before, edit!)).toBe(after);
  }
});

test("a pair of UTF-16 halves is never split", () => {
  // 😀 and 😁 share their high half: the edit takes the whole character.
  const edit = changedSpan("😀", "😁")!;
  expect(edit.range.start).toEqual({ line: 0, column: 0 });
  expect(edit.range.end).toEqual({ line: 0, column: 2 });
  expect(edit.text).toBe("😁");
});

test("a large file is compared in pieces, to the same edit", () => {
  const line = "the quick brown fox jumps over the lazy dog\n";
  const before = line.repeat(5000);
  const after = `${line.repeat(2500)}changed\n${line.repeat(2500)}appended\n`;
  const edit = changedSpan(before, after)!;
  expect(apply(before, edit)).toBe(after);
  expect(edit.range.start.line).toBe(2500);
});
