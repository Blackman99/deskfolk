/**
 * Block lines in the rendered preview (`renderMarkdown(…, { sourceLines: true })`) and the visible
 * projection the rendered-view annotations align against.
 */
import { expect, test } from "bun:test";
import { renderMarkdown } from "../markdown.ts";
import { lineStarts, lineAt, projectVisible, splitFrontMatter } from "./markdown-lines.ts";

/** The `data-src-*` of every marked element, as `tag:start-end` in document order. */
function blocks(source: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source, { sourceLines: true });
  return [...host.querySelectorAll("[data-src-start]")].map(
    (el) => `${el.tagName.toLowerCase()}:${el.getAttribute("data-src-start")}-${el.getAttribute("data-src-end")}`,
  );
}

/** The source text a projected character came from. */
function sourceOf(source: string, needle: string): string[] {
  const p = projectVisible(source);
  const at = p.chars.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return [...needle].map((_, k) => p.source.slice(p.from[at + k]!, p.to[at + k]!));
}

test("headings and paragraphs carry their source lines; a paragraph spans its soft breaks", () => {
  const source = ["# Title", "", "First line", "second line", "", "Setext", "===", "", "## Tail ##"].join("\n");
  expect(blocks(source)).toEqual(["h1:1-1", "p:3-4", "h1:6-7", "h2:9-9"]);
});

test("leading blank lines push every block down", () => {
  expect(blocks("\n\n\npara")).toEqual(["p:4-4"]);
});

test("a list and each item carry lines, nested lists count on from their parent item", () => {
  const source = ["- one", "- two", "  - two.a", "    wrapped", "  - two.b", "    1. deep", "- three"].join("\n");
  expect(blocks(source)).toEqual(["ul:1-7", "li:1-1", "li:2-6", "ul:3-6", "li:3-4", "li:5-6", "ol:6-6", "li:6-6", "li:7-7"]);
});

test("a loose ordered list keeps paragraph lines inside items; the blank line after an item is not its own", () => {
  const source = ["1. one", "", "2. two", "   more"].join("\n");
  expect(blocks(source)).toEqual(["ol:1-4", "li:1-1", "p:1-1", "li:3-4", "p:3-4"]);
});

test("a table carries its lines, and each row its own line (the delimiter row is skipped)", () => {
  const source = ["intro", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
  expect(blocks(source)).toEqual(["p:1-1", "table:3-6", "tr:3-3", "tr:5-5", "tr:6-6"]);
});

test("fenced and indented code blocks carry their fence lines", () => {
  const source = ["text", "", "```ts", "const a = 1", "const b = 2", "```", "", "    indented", "    code"].join("\n");
  expect(blocks(source)).toEqual(["p:1-1", "pre:3-6", "pre:8-9"]);
});

test("blockquotes carry lines, and so do the blocks inside them", () => {
  const source = ["> quoted", "> still", "lazy", "", "> - item", ">", "> ```", "> code", "> ```"].join("\n");
  expect(blocks(source)).toEqual(["blockquote:1-3", "p:1-3", "blockquote:5-9", "ul:5-5", "li:5-5", "pre:7-9"]);
});

test("lazy lines in quotes keep their own lines, though marked lexes a quote a chunk at a time", () => {
  // The break joining two chunks is in no token's raw: the table is on lines 2–3, not 1–2.
  expect(blocks(["> > dq", "--- | ---", "--- | ---", "", "after"].join("\n"))).toEqual([
    "blockquote:1-3",
    "blockquote:1-3",
    "p:1-1",
    "table:2-3",
    "tr:2-2",
    "p:5-5",
  ]);
  // A list re-read with the quote's lazy lines comes back with a blank line the source lacks.
  expect(blocks([">   - dlq", "Ref [t][ref] [x]", "> | t | u |", "    1. deep", "- item"].join("\n"))).toEqual([
    "blockquote:1-4",
    "ul:1-2",
    "li:1-2",
    "p:3-4",
    "ul:5-5",
    "li:5-5",
  ]);
  expect(blocks(["> - list in quote", "lazy line", "", "after"].join("\n"))).toEqual(["blockquote:1-2", "ul:1-2", "li:1-2", "p:4-4"]);
});

test("a raw HTML block is wrapped so it has lines, and cannot forge its own", () => {
  const source = ["para", "", '<div data-src-start="99" class="x">', '<b>bold</b> text<p/data-src-end=98>', "</div>", "", "after"].join("\n");
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source, { sourceLines: true });
  expect(blocks(source)).toEqual(["p:1-1", "div:3-5", "p:7-7"]);
  const wrap = host.querySelector(".md-html-block");
  expect(wrap?.textContent).toContain("bold text");
  expect(host.innerHTML).not.toContain('"99"');
  expect(host.innerHTML).not.toContain('"98"');
  expect(host.querySelectorAll("div")).toHaveLength(1);
});

test("a line attribute glued to a quoted value, written in capitals, or inline, is defused too", () => {
  const source = [
    "<div>",
    '<p title="x"data-src-start="99" DATA-SRC-END=\'98\'>forged</p>',
    "</div>",
    "",
    'Inline <hr data-src-start="97" data-src-end="96"> rule.',
  ].join("\n");
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source, { sourceLines: true });
  expect(blocks(source)).toEqual(["div:1-3", "p:5-5"]);
  // No element carries a line the renderer did not write.
  const forged = [...host.querySelectorAll("*")].filter((el) =>
    [...el.attributes].some((attr) => /^data-src-(start|end)$/i.test(attr.name) && /^9\d$/.test(attr.value)),
  );
  expect(forged).toEqual([]);
  expect(host.querySelector(".md-html-block p")?.textContent).toBe("forged");
  expect(host.querySelector("hr")).not.toBeNull();
});

test("leading YAML front matter shows as a yaml block, and the lines after it count on", () => {
  const source = ["---", "title: Plan", "tags: [a, b]", "---", "# Heading", "", "Body"].join("\n");
  expect(blocks(source)).toEqual(["pre:1-4", "h1:5-5", "p:7-7"]);
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source, { sourceLines: true });
  expect(host.querySelector("pre code")?.className).toBe("language-yaml");
  expect(host.querySelector("pre code")?.textContent).toContain("title: Plan");
});

test("a rule and a heading at the top are not front matter", () => {
  expect(splitFrontMatter("---\nJust a thought\n---\n")).toBeNull();
  expect(splitFrontMatter("---\ntitle: x\n---\nbody")?.lines).toBe(3);
  expect(splitFrontMatter("---\n---\nbody")?.lines).toBe(2);
});

test("CRLF sources count lines the way the source view does", () => {
  expect(blocks("# A\r\n\r\npara\r\nmore")).toEqual(["h1:1-1", "p:3-4"]);
});

test("chat bubbles render exactly as before: no line attributes, no wrappers, front matter untouched", () => {
  const source = "---\ntitle: x\n---\n# Hi\n\n<div>raw</div>\n\n| a |\n| - |\n| 1 |";
  const plain = renderMarkdown(source);
  expect(plain).not.toContain("data-src-");
  expect(plain).not.toContain("md-html-block");
  expect(plain).not.toContain("language-yaml");
  // The same text under the two options is two different cache entries.
  expect(renderMarkdown(source, { sourceLines: true })).toContain("data-src-start");
  expect(renderMarkdown(source)).toBe(plain);
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

test("raw HTML keeps only its text, never the tags or a script body", () => {
  const p = projectVisible("<div>\n<b>kept</b> <script>gone()</script>\n</div>");
  expect(p.chars).toBe("kept");
});

/** Rendered HTML as the browser builds it, with the line marks and HTML-block wrappers taken off again. */
function withoutLines(html: string): string {
  const host = document.createElement("div");
  host.innerHTML = html;
  for (const wrap of [...host.querySelectorAll(".md-html-block")]) wrap.replaceWith(...wrap.childNodes);
  for (const el of host.querySelectorAll("[data-src-start]")) {
    el.removeAttribute("data-src-start");
    el.removeAttribute("data-src-end");
  }
  host.normalize();
  // The wrapper brings a line break of its own; whitespace at tag edges is not what is compared.
  return host.innerHTML.replace(/\s*</g, "<").replace(/>\s*/g, ">").replace(/\s+/g, " ").trim();
}

test("apart from the line marks, the preview renders what a chat bubble renders, raw HTML that spans blocks included", () => {
  const sources = [
    // The README way of centering: the opening and closing tags are blocks of their own.
    ['<div align="center">', "", "# Title", "", "Text **b**", "", "```js", "let a = 1;", "```", "", "</div>", "", "After para."],
    ["<details>", "<summary>More</summary>", "", "- a", "- b", "", "</details>", "", "Tail."],
    ["<blockquote>", "", "quoted **md**", "", "</blockquote>", "", "Then."],
    ['<p align="center">', '  <img src="x.png">', "</p>", "", "# Next"],
    ["<div>", "<b>html</b> text", "</div>", "", "<div><p>one</p><p>two</p></div>", "", "para"],
    ["- item", "", "  <div>in item</div>", "", "> <div>", "> quoted html", "> </div>"],
  ].map((lines) => lines.join("\n"));
  for (const source of sources) {
    const lined = renderMarkdown(source, { sourceLines: true });
    expect(lined).not.toContain("rb-");
    expect(withoutLines(lined)).toBe(withoutLines(renderMarkdown(source)));
  }
  // The centered title stays a title: nothing after it ends up inside it.
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(sources[0]!, { sourceLines: true });
  expect(host.querySelector("h1")?.textContent).toBe("Title");
  expect(host.querySelector("h1")?.getAttribute("data-src-start")).toBe("3");
  expect(host.querySelector("pre")?.getAttribute("data-src-start")).toBe("7");
  expect(host.querySelector("p:last-child")?.textContent).toBe("After para.");
});
