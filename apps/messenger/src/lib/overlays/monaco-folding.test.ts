import { expect, test } from "bun:test";
import {
  bracketFolds,
  computeMatchingFolds,
  fenceFolds,
  headingFolds,
  indentFolds,
  regionFolds,
  tagFolds,
  type FoldingLineModel,
} from "./monaco-folding.ts";

function model(lang: string, text: string): FoldingLineModel {
  const lines = text.replace(/\n$/, "").split("\n");
  return {
    getLanguageId: () => lang,
    getLineCount: () => lines.length,
    getLineContent: (n) => lines[n - 1] ?? "",
  };
}

test("bracketFolds matches braces across lines and skips comments", () => {
  const src = model(
    "typescript",
    [
      "function foo() {",
      "  // }",
      "  return 1;",
      "}",
    ].join("\n"),
  );
  expect(bracketFolds(src)).toEqual([{ start: 1, end: 4 }]);
});

test("bracketFolds matches nested arrays and objects", () => {
  const src = model(
    "json",
    [
      "{",
      '  "items": [',
      "    1,",
      "    2",
      "  ]",
      "}",
    ].join("\n"),
  );
  expect(bracketFolds(src)).toEqual([
    { start: 2, end: 5 },
    { start: 1, end: 6 },
  ]);
});

test("tagFolds matches HTML elements and skips voids", () => {
  const src = model(
    "html",
    [
      "<div>",
      "  <img src='x'>",
      "  <p>hi</p>",
      "  <span>",
      "    x",
      "  </span>",
      "</div>",
    ].join("\n"),
  );
  expect(tagFolds(src)).toEqual([
    { start: 4, end: 6 },
    { start: 1, end: 7 },
  ]);
});

test("headingFolds and fenceFolds cover markdown sections", () => {
  const src = model(
    "markdown",
    [
      "# Title",
      "intro",
      "## Nested",
      "body",
      "# Next",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"),
  );
  expect(headingFolds(src)).toEqual([
    { start: 1, end: 4 },
    { start: 3, end: 4 },
    { start: 5, end: 8 },
  ]);
  expect(fenceFolds(src)).toEqual([{ start: 6, end: 8 }]);
});

test("indentFolds and regionFolds work on indented python", () => {
  const src = model(
    "python",
    [
      "def foo():",
      "  # region",
      "  x = 1",
      "  y = 2",
      "  # endregion",
      "z = 3",
    ].join("\n"),
  );
  expect(indentFolds(src)).toEqual([{ start: 1, end: 5 }]);
  expect(regionFolds(src)).toEqual([{ start: 2, end: 5 }]);
});

test("computeMatchingFolds unions matching blocks without duplicates", () => {
  const src = model(
    "typescript",
    [
      "export function run() {",
      "  if (true) {",
      "    return 1;",
      "  }",
      "}",
    ].join("\n"),
  );
  const ranges = computeMatchingFolds(src);
  expect(ranges).toContainEqual({ start: 1, end: 5 });
  expect(ranges).toContainEqual({ start: 2, end: 4 });
});

test("computeMatchingFolds folds markdown headings and html tags", () => {
  const md = model(
    "markdown",
    ["# A", "text", "## B", "more", "# C", "end"].join("\n"),
  );
  expect(computeMatchingFolds(md)).toContainEqual({ start: 1, end: 4 });
  const html = model("html", ["<section>", "  <p>x</p>", "</section>"].join("\n"));
  expect(computeMatchingFolds(html)).toContainEqual({ start: 1, end: 3 });
});
