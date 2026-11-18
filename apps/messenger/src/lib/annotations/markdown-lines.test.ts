/** Source lines and the visible projection the rendered-view annotations align against. */
import { expect, test } from "bun:test";
import { Marked, type Token } from "marked";
import { lexWithSourceLines, lineStarts, lineAt, normalizeSource, projectVisible, sourceLinesOf, splitFrontMatter } from "./markdown-lines.ts";

/** The lexer and settings the app's Markdown annotator splits a file with (`markdown-blocks.ts`). */
const lexer = new Marked({ gfm: true, breaks: true });

/** The top-level blocks a file is cut into, as `kind:start-end` (blank lines skipped). */
function blocks(source: string): string[] {
  const tag = (token: Token): string => {
    if (token.type === "heading") return `h${(token as { depth: number }).depth}`;
    if (token.type === "paragraph") return "p";
    if (token.type === "list") return (token as { ordered: boolean }).ordered ? "ol" : "ul";
    if (token.type === "code") return "pre";
    return token.type;
  };
  return lexWithSourceLines(normalizeSource(source), (src) => lexer.lexer(src))
    .filter((token) => token.type !== "space")
    .map((token) => {
      const at = sourceLinesOf(token);
      return at ? `${tag(token)}:${at.start}-${at.end}` : `${tag(token)}:?`;
    });
}

/** The source text a projected character came from. */
function sourceOf(source: string, needle: string): string[] {
  const p = projectVisible(source);
  const at = p.chars.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return [...needle].map((_, k) => p.source.slice(p.from[at + k]!, p.to[at + k]!));
}

test("a rule and a heading at the top are not front matter", () => {
  expect(splitFrontMatter("---\nJust a thought\n---\n")).toBeNull();
  expect(splitFrontMatter("---\ntitle: x\n---\nbody")?.lines).toBe(3);
  expect(splitFrontMatter("---\n---\nbody")?.lines).toBe(2);
});

test("the projection drops markup and ties each visible character to its source", () => {
  const source = "Say **bold** and [the link](https://example.com/x) with `code` &amp; \\*stars\\*";
  const p = projectVisible(source);
  expect(p.chars).toBe("Saybold" + "andthelink" + "withcode&*stars*");
  expect(sourceOf(source, "bold")).toEqual(["b", "o", "l", "d"]);
  expect(sourceOf(source, "thelink").join("")).toBe("thelink");
  expect(sourceOf(source, "&")).toEqual(["&amp;"]);
  expect(sourceOf(source, "*stars*")[0]).toBe("\\*");
  // Nothing from the URL is visible.
  expect(p.chars).not.toContain("example");
});

test("the projection strips list markers, heading hashes, quote markers and table pipes", () => {
  const source = ["## Heading ##", "", "- item **one**", "  - nested", "", "> quoted", "", "| h1 | h2 |", "|----|----|", "| c1 | c\\|2 |"].join("\n");
  const p = projectVisible(source);
  expect(p.chars).toBe("Headingitemonenestedquotedh1h2c1c|2");
  expect(sourceOf(source, "nested").join("")).toBe("nested");
  const pipe = p.chars.indexOf("|");
  expect(p.source.slice(p.from[pipe]!, p.to[pipe]!)).toBe("|");
  // Every visible character is on the line it was written on.
  const starts = lineStarts(p.source);
  expect(lineAt(starts, p.from[p.chars.indexOf("q")]!)).toBe(6);
  expect(lineAt(starts, p.from[p.chars.indexOf("c1")]!)).toBe(10);
});

test("the projection keeps code verbatim and front matter as written", () => {
  const source = ["---", "title: x", "---", "```js", "a &amp; b", "```"].join("\n");
  const p = projectVisible(source);
  expect(p.chars).toBe("title:xa&amp;b");
  const starts = lineStarts(p.source);
  expect(lineAt(starts, p.from[p.chars.indexOf("a&")]!)).toBe(5);
});

test("a nested item after a tab keeps its words, though the lexer spread the tab into spaces", () => {
  const source = ["-\ttab", "\t-\tnested **tab**"].join("\n");
  const p = projectVisible(source);
  expect(p.chars).toBe("tabnestedtab");
  // Line 2, right after the second tab.
  expect(p.from[p.chars.indexOf("nested")]).toBe(source.indexOf("nested"));
  expect(sourceOf(source, "nestedtab").join("")).toBe("nestedtab");
});

test("numeric entities HTML cannot show become the replacement character, as the browser shows them", () => {
  const p = projectVisible("a &#0; b &#xD800; c &#9999999; d &#169;");
  expect(p.chars).toBe("a�b�c�d©");
});

test("headings and paragraphs carry their source lines; a paragraph spans its soft breaks", () => {
  const source = ["# Title", "", "First line", "second line", "", "Setext", "===", "", "## Tail ##"].join("\n");
  expect(blocks(source)).toEqual(["h1:1-1", "p:3-4", "h1:6-7", "h2:9-9"]);
});

test("leading blank lines push every block down", () => {
  expect(blocks("\n\n\npara")).toEqual(["p:4-4"]);
});

test("a list spans its items, nested ones included; a loose list the lines of its items", () => {
  expect(blocks(["- one", "- two", "  - two.a", "    wrapped", "  - two.b", "    1. deep", "- three"].join("\n"))).toEqual(["ul:1-7"]);
  expect(blocks(["1. one", "", "2. two", "   more"].join("\n"))).toEqual(["ol:1-4"]);
});

test("a table carries its lines, the delimiter row among them", () => {
  expect(blocks(["intro", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"))).toEqual(["p:1-1", "table:3-6"]);
});

test("fenced and indented code blocks carry their fence lines", () => {
  const source = ["text", "", "```ts", "const a = 1", "const b = 2", "```", "", "    indented", "    code"].join("\n");
  expect(blocks(source)).toEqual(["p:1-1", "pre:3-6", "pre:8-9"]);
});

test("blockquotes carry their lines, lazy ones included", () => {
  expect(blocks(["> quoted", "> still", "lazy", "", "> - item", ">", "> ```", "> code", "> ```"].join("\n"))).toEqual(["blockquote:1-3", "blockquote:5-9"]);
  // The break joining two chunks marked lexes a quote in is in no token's raw.
  expect(blocks(["> > dq", "--- | ---", "--- | ---", "", "after"].join("\n"))).toEqual(["blockquote:1-3", "p:5-5"]);
  expect(blocks([">   - dlq", "Ref [t][ref] [x]", "> | t | u |", "    1. deep", "- item"].join("\n"))).toEqual(["blockquote:1-4", "ul:5-5"]);
  expect(blocks(["> - list in quote", "lazy line", "", "after"].join("\n"))).toEqual(["blockquote:1-2", "p:4-4"]);
});

test("leading YAML front matter is a yaml block, and the lines after it count on", () => {
  expect(blocks(["---", "title: Plan", "tags: [a, b]", "---", "# Heading", "", "Body"].join("\n"))).toEqual(["pre:1-4", "h1:5-5", "p:7-7"]);
});

test("CRLF sources count lines the way the source view does", () => {
  expect(blocks("# A\r\n\r\npara\r\nmore")).toEqual(["h1:1-1", "p:3-4"]);
});
