/** The editor's line endings: `\r\n` and a lone `\r` fold to `\n`; a text without `\r` is left as it is. */
import { expect, test } from "nsh/test";
import { foldLineEndings } from "./artifact-code-editor";

test("carriage returns fold to line feeds", () => {
  expect(foldLineEndings("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  expect(foldLineEndings("\r\r\n")).toBe("\n\n");
});

test("a text with none is the same string", () => {
  const text = "a\nb\n".repeat(1000);
  expect(foldLineEndings(text)).toBe(text);
  expect(foldLineEndings("")).toBe("");
});
