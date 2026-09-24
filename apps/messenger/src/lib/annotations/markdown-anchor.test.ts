/**
 * Rendered Markdown ↔ source text ranges, on a real (happy-dom) DOM built from the preview's own
 * renderer: a selection becomes a source-line anchor, an anchor becomes DOM ranges again.
 */
import { afterEach, expect, test } from "bun:test";
import { textRangeFromSelection, validateAnchor, type Annotation, type TextRangeAnchor } from "@real-bot/protocol";
import { renderMarkdown } from "../markdown.ts";
import {
  anchorFromRange,
  clampRange,
  createHighlightPainter,
  highlightName,
  mapRendered,
  rangesForAnchor,
  rangesForRow,
  type HighlightEnv,
  type HighlightLike,
} from "./markdown-anchor.ts";

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

/** The preview's body as MarkdownBody leaves it, code headers included. */
function mount(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "md-body";
  root.innerHTML = renderMarkdown(source, { sourceLines: true });
  for (const pre of root.querySelectorAll("pre")) {
    const header = document.createElement("div");
    header.className = "code-header";
    header.innerHTML = '<span class="code-lang">ts</span><button type="button" class="code-copy-btn"><span>复制代码</span></button>';
    pre.insertBefore(header, pre.firstChild);
  }
  document.body.appendChild(root);
  mounted.push(root);
  return root;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) out.push(child as Text);
      else walk(child);
    }
  };
  walk(root);
  return out;
}

/** A range from the start of `from` to the end of `to` (both looked up in text node order). */
function select(root: HTMLElement, from: string, to: string = from): Range {
  const nodes = textNodes(root);
  const startNode = nodes.findIndex((node) => node.data.includes(from));
  if (startNode < 0) throw new Error(`no text ${from}`);
  const range = document.createRange();
  range.setStart(nodes[startNode]!, nodes[startNode]!.data.indexOf(from));
  const startAt = nodes[startNode]!.data.indexOf(from);
  for (let k = startNode; k < nodes.length; k += 1) {
    const at = nodes[k]!.data.indexOf(to, k === startNode ? startAt : 0);
    if (at >= 0) {
      range.setEnd(nodes[k]!, at + to.length);
      return range;
    }
  }
  throw new Error(`no text ${to}`);
}

const squash = (text: string): string => text.replace(/\s+/g, "");
const shown = (ranges: Range[]): string => squash(ranges.map((r) => r.toString()).join(""));

function sourceSlice(source: string, a: TextRangeAnchor): string {
  return textRangeFromSelection(source, a).quote;
}

function expectValid(anchor: TextRangeAnchor | null): TextRangeAnchor {
  expect(anchor).not.toBeNull();
  const check = validateAnchor("text_range", anchor);
  expect(check.ok).toBe(true);
  return anchor!;
}

test("a selection inside a paragraph with bold and a link maps to the exact source columns", () => {
  const source = ["# Notes", "", "See **the bold part** and [a link](https://example.com/x) here."].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  const anchor = expectValid(anchorFromRange(map, select(root, "bold", "link")));
  const line = source.split("\n")[2]!;
  expect(anchor).toMatchObject({
    start_line: 3,
    start_col: line.indexOf("bold") + 1,
    end_line: 3,
    end_col: line.indexOf("link]") + "link".length + 1,
    view: "rendered",
  });
  // Quote and affixes come from the source, as the source view would have taken them.
  expect(anchor.quote).toBe("bold part** and [a link");
  expect(anchor.prefix.endsWith("See **the ")).toBe(true);
  expect(anchor.suffix.startsWith("](https://example.com/x) here.")).toBe(true);

  const word = expectValid(anchorFromRange(map, select(root, "bold")));
  expect(word.quote).toBe("bold");
  expect(sourceSlice(source, word)).toBe("bold");
});

test("inline code, entities and escapes map back to what was written", () => {
  const source = "Use `npm run dev` &amp; keep \\*this\\* as is.";
  const root = mount(source);
  const map = mapRendered(root, source);
  expect(expectValid(anchorFromRange(map, select(root, "run dev"))).quote).toBe("run dev");
  expect(expectValid(anchorFromRange(map, select(root, "& keep"))).quote).toBe("&amp; keep");
  expect(expectValid(anchorFromRange(map, select(root, "*this*"))).quote).toBe("\\*this\\*");
});

test("a selection across two paragraphs unions their lines", () => {
  const source = ["First paragraph ends here.", "", "Second one starts there."].join("\n");
  const root = mount(source);
  const anchor = expectValid(anchorFromRange(mapRendered(root, source), select(root, "ends", "starts")));
  expect(anchor).toMatchObject({ start_line: 1, start_col: 17, end_line: 3, end_col: 18 });
  expect(anchor.quote).toBe("ends here.\n\nSecond one starts");
});

test("nested list items and front matter keep their own source lines", () => {
  const source = ["---", "title: Plan", "---", "- one", "- two", "  - nested **item**", "- three"].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  expect(expectValid(anchorFromRange(map, select(root, "nested", "item")))).toMatchObject({ start_line: 6, start_col: 5, end_line: 6, end_col: 18, quote: "nested **item" });
  expect(expectValid(anchorFromRange(map, select(root, "Plan")))).toMatchObject({ start_line: 2, start_col: 8, end_line: 2, end_col: 12, quote: "Plan" });
});

test("a selection inside one table cell maps to its row line; across cells it stays on the table's lines", () => {
  const source = ["| 镜号 | 判 |", "| --- | --- |", "| 1A | 本轮**可作** |", "| 2A | 未过 |"].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  expect(expectValid(anchorFromRange(map, select(root, "本轮", "可作")))).toMatchObject({ start_line: 3, end_line: 3, quote: "本轮**可作" });
  const across = expectValid(anchorFromRange(map, select(root, "1A", "未过")));
  expect(across.start_line).toBe(3);
  expect(across.end_line).toBe(4);
});

test("code blocks map inside the code, and the code header chrome is not text", () => {
  const source = ["Intro", "", "```ts", "const answer = 42;", "export { answer };", "```"].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  expect(map.dom.text).not.toContain("复制代码");
  expect(expectValid(anchorFromRange(map, select(root, "answer = 42")))).toMatchObject({ start_line: 4, start_col: 7, end_line: 4, end_col: 18 });

  // From the header's label into the code: the header adds nothing.
  const pre = root.querySelector("pre")!;
  const range = document.createRange();
  range.setStart(pre.querySelector(".code-lang")!.firstChild!, 0);
  const code = textNodes(pre.querySelector("code")!);
  range.setEnd(code[0]!, "const".length);
  const fromHeader = expectValid(anchorFromRange(map, range));
  expect(fromHeader).toMatchObject({ start_line: 4, start_col: 1, end_line: 4, end_col: 6, quote: "const" });

  // From the paragraph above across the code block's edge.
  const edge = expectValid(anchorFromRange(map, select(root, "Intro", "const answer")));
  expect(edge).toMatchObject({ start_line: 1, end_line: 4 });
  expect(edge.quote).not.toContain("复制代码");
});

test("text the source does not explain falls back to the whole block lines with the selected text as quote", () => {
  const source = ["Alpha beta gamma.", "", "Delta."].join("\n");
  const root = mount(source);
  // Something rendered that is not in the source (a chip's avatar letter, say) inside the selection.
  const strong = document.createElement("span");
  strong.textContent = "Ω";
  const p = root.querySelector("p")!;
  const text = p.firstChild as Text;
  text.splitText("Alpha ".length);
  p.insertBefore(strong, p.childNodes[1]!);
  const map = mapRendered(root, source);
  const anchor = expectValid(anchorFromRange(map, select(root, "Alpha", "gamma")));
  expect(anchor).toMatchObject({ start_line: 1, start_col: 1, end_line: 1, end_col: "Alpha beta gamma.".length + 1, view: "rendered" });
  expect(anchor.quote).toBe("Alpha Ωbeta gamma");
  // And it is drawn on its quote, not on the whole block.
  expect(shown(rangesForAnchor(map, anchor))).toBe("AlphaΩbetagamma");
});

test("blank and empty selections make no anchor", () => {
  const source = "One.\n\nTwo.";
  const root = mount(source);
  const map = mapRendered(root, source);
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(root, 0);
  expect(anchorFromRange(map, range)).toBeNull();
  const between = root.childNodes[1]!; // the "\n" between the paragraphs
  const blank = document.createRange();
  blank.setStart(between, 0);
  blank.setEnd(between, (between as Text).data.length);
  expect(anchorFromRange(map, blank)).toBeNull();
});

test("anchor → ranges → anchor round-trips on the rendered text", () => {
  const source = [
    "# Title here",
    "",
    "Para with **bold** and `code` and [link](https://a.b/c).",
    "",
    "- item one",
    "  - nested *two*",
    "",
    "> quoted text",
    "",
    "| a | b |",
    "|---|---|",
    "| cell one | cell two |",
    "",
    "```js",
    "let x = 1;",
    "```",
  ].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  const cases: Array<[string, string]> = [
    ["Title", "here"],
    ["bold", "link"],
    ["nested", "two"],
    ["quoted", "text"],
    ["cell", "two"],
    ["x = 1", "x = 1"],
    ["with", "quoted"],
  ];
  for (const [from, to] of cases) {
    const range = select(root, from, to);
    const anchor = expectValid(anchorFromRange(map, range));
    expect(shown(rangesForAnchor(map, anchor))).toBe(squash(range.toString()));
  }
});

test("an anchor made in the source view is drawn on the rendered text without its markup", () => {
  const source = "Plain **strong words** end.";
  const root = mount(source);
  const map = mapRendered(root, source);
  const col = source.indexOf("**strong") + 1;
  const anchor = textRangeFromSelection(source, { start_line: 1, start_col: col, end_line: 1, end_col: col + "**strong words**".length });
  expect(shown(rangesForAnchor(map, anchor))).toBe("strongwords");
});

test("stale rows: moved ones are drawn where they went, missing ones not at all", () => {
  const source = ["Intro line.", "", "The moved sentence."].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  const old: TextRangeAnchor = { start_line: 1, start_col: 1, end_line: 1, end_col: 6, quote: "moved", prefix: "The ", suffix: " sentence." };
  const row = (stale: Annotation["stale"]) => ({ anchor_kind: "text_range" as const, anchor: old, stale });
  expect(shown(rangesForRow(map, row({ kind: "moved", start_line: 3, start_col: 5, end_line: 3, end_col: 10 })))).toBe("moved");
  expect(shown(rangesForRow(map, row({ kind: "changed" })))).toBe("moved");
  expect(rangesForRow(map, row({ kind: "missing" }))).toEqual([]);
  expect(rangesForRow(map, { anchor_kind: "image_region", anchor: { x: 0, y: 0, w: 1, h: 1, natural_width: 1, natural_height: 1 }, stale: null })).toEqual([]);
});

test("a selection that runs out of the body is kept to the body", () => {
  const source = "Inside text.";
  const root = mount(source);
  const outside = document.createElement("p");
  outside.textContent = "Outside";
  document.body.appendChild(outside);
  mounted.push(outside);
  const range = document.createRange();
  range.setStart(root.querySelector("p")!.firstChild!, "Inside ".length);
  range.setEnd(outside.firstChild!, 3);
  const clamped = clampRange(range, root);
  expect(clamped).not.toBeNull();
  expect(expectValid(anchorFromRange(mapRendered(root, source), clamped!)).quote).toBe("text.");
  const away = document.createRange();
  away.setStart(outside.firstChild!, 0);
  away.setEnd(outside.firstChild!, 3);
  expect(clampRange(away, root)).toBeNull();
});

test("the painter adds and removes only its own ranges, and names highlights by status", () => {
  const registry = new Map<string, HighlightLike>();
  const env: HighlightEnv = {
    registry,
    create: () => {
      const set = new Set<AbstractRange>();
      return {
        priority: 0,
        add: (r) => set.add(r),
        delete: (r) => set.delete(r),
        get size() {
          return set.size;
        },
      };
    },
  };
  const a = createHighlightPainter(env);
  const b = createHighlightPainter(env);
  expect(a.supported).toBe(true);
  const r1 = document.createRange();
  const r2 = document.createRange();
  a.paint(new Map([["rb-md-annot-open", [r1]]]));
  b.paint(new Map([["rb-md-annot-open", [r2]], ["rb-md-annot-pending", [r2]]]));
  expect(registry.get("rb-md-annot-open")?.size).toBe(2);
  expect(registry.get("rb-md-annot-pending")?.priority).toBeGreaterThan(registry.get("rb-md-annot-open")!.priority);
  a.clear();
  expect(registry.get("rb-md-annot-open")?.size).toBe(1);
  b.clear();
  expect(registry.size).toBe(0);

  expect(createHighlightPainter(null).supported).toBe(false);
  expect(() => createHighlightPainter(null).paint(new Map([["x", [r1]]]))).not.toThrow();

  expect(highlightName({ status: "open", stale: null })).toBe("rb-md-annot-open");
  expect(highlightName({ status: "draft", stale: { kind: "changed" } })).toBe("rb-md-annot-draft-stale");
  expect(highlightName({ status: "resolved", stale: undefined })).toBe("rb-md-annot-resolved");
});

test("a document using most of Markdown pairs every character, and every one points at itself in the source", () => {
  const source = [
    "---",
    "title: T",
    "---",
    "Setext *em* _em2_ ***both*** ~~del~~ ~single~",
    "======",
    "",
    "Café &eacute; &copy; &#169; &#x263A; a&b <kbd>Ctrl</kbd>+C \\_esc\\_ snake_case_name",
    "Hard break  ",
    "next line\\",
    "last <https://auto.link/x> and www.example.com and mail@x.io",
    "",
    "Ref [link text][ref] and [collapsed][] and ![img alt](a.png) and [![inner](b.png)](c)",
    "",
    "[ref]: https://x.y",
    "[collapsed]: https://z",
    "",
    "- [ ] todo **x**",
    "- [x] done",
    "-\ttab item",
    "\tcontinued",
    "",
    "1) one",
    "2) two",
    "   ```",
    "   in list",
    "   ```",
    "",
    "> quote",
    "> > nested quote",
    "> - list in quote",
    "",
    "| a | b \\| c | d |",
    "|:-|:-:|-:|",
    "| x | y | z |",
    "",
    "<details><summary>Sum</summary>",
    "",
    "Inside *details*",
    "",
    "</details>",
    "",
    "~~~python",
    "print('hi') # &amp;",
    "~~~",
    "",
    "    indented code",
    "",
    "Text with inbox/report.md path and `docs/plan.md` code path.",
    "",
    "***",
    "",
    "Final 中文 **加粗** 结尾。",
  ].join("\n");
  const map = mapRendered(mount(source), source);
  expect(map.dom.chars).toBe(map.projection.chars);
  expect([...map.toSource].every((i) => i >= 0)).toBe(true);
  const p = map.projection;
  for (let i = 0; i < p.chars.length; i += 1) {
    const piece = p.source.slice(p.from[i]!, p.to[i]!);
    // A character is itself in the source, or the entity / escape that wrote it.
    if (piece !== p.chars[i]) expect(piece[0] === "&" || piece[0] === "\\").toBe(true);
  }
});

test("every anchor a selection can make passes validateAnchor, and draws again", () => {
  const source = [
    "---",
    "title: Plan",
    "---",
    "# Title *one*",
    "",
    "Para with **bold**, `code`, [link](https://x.y) &amp; \\*esc\\*.",
    "Second line 中文🙂。",
    "",
    "- a",
    "  - b **c**",
    "    1. d",
    "-\ttab",
    "\t-\tnested tab",
    "",
    "> quote",
    "> > deep",
    "",
    "| h1 | h2 |",
    "|---|---|",
    "| `x\\|y` | **z** |",
    "",
    "<div>",
    "<b>html</b> text",
    "</div>",
    "",
    "```js",
    "let x = 1 < 2;",
    "```",
    "",
    "    indented",
    "",
    "Final.",
  ].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  const nodes = textNodes(root);
  // A fixed pseudo-random walk over boundary points, so a failure replays.
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let made = 0;
  for (let t = 0; t < 1500; t += 1) {
    const a = next(nodes.length);
    const b = next(nodes.length);
    const [s, e] = a <= b ? [a, b] : [b, a];
    const range = document.createRange();
    range.setStart(nodes[s]!, next(nodes[s]!.data.length + 1));
    range.setEnd(nodes[e]!, next(nodes[e]!.data.length + 1));
    if (range.collapsed) continue;
    const anchor = anchorFromRange(map, range);
    if (!anchor) continue;
    made += 1;
    const check = validateAnchor("text_range", anchor);
    if (!check.ok) throw new Error(`${check.reason}: ${JSON.stringify(anchor)}`);
    expect(anchor.view).toBe("rendered");
    expect(rangesForAnchor(map, anchor).length).toBeGreaterThan(0);
  }
  expect(made).toBeGreaterThan(1000);
});

test("a selection in a nested item after a tab maps to its exact source columns", () => {
  const source = ["- top", "-\ttab item", "\t-\tnested **words** here"].join("\n");
  const root = mount(source);
  const map = mapRendered(root, source);
  const anchor = expectValid(anchorFromRange(map, select(root, "nested", "words")));
  const line = source.split("\n")[2]!;
  expect(anchor).toMatchObject({ start_line: 3, start_col: line.indexOf("nested") + 1, end_line: 3, end_col: line.indexOf("words") + "words".length + 1, quote: "nested **words" });
  expect(shown(rangesForAnchor(map, anchor))).toBe("nestedwords");
});

test("a selection past the end of a long document keeps its quote within the limit", () => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i} has some words in it.`).join("\n\n");
  const root = mount(long);
  const map = mapRendered(root, long);
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(root, root.childNodes.length);
  const anchor = expectValid(anchorFromRange(map, range));
  expect(anchor).toMatchObject({ start_line: 1, start_col: 1, end_line: 799 });
  expect([...anchor.quote].length).toBe(2000);
  expect(rangesForAnchor(map, anchor).length).toBeGreaterThan(0);
});

test("lazy lines in quotes, which marked hands back rewritten, still pair every character with its source", () => {
  const cases = [
    // A list that ends a quote, at the end of the file: its raw grows a line break the file lacks.
    ["> - list in quote", "lazy line"],
    // Trailing spaces moved past the line break.
    ["> - list in quote", "Hard break  ", "~~~", "code"],
    // A paragraph whose lazy lines come back with a blank line the source does not have.
    ["> quote", "    1. deep", "    indented", "|---|:-:|", "", "after"],
    // A nested quote's lazy line: its `>` gone from one side only.
    ["> > deep quote", "|---|:-:|", "> > deep again", "", "after"],
    // A list re-read with the lazy lines around it: raw no longer the source at all.
    ["> - list in quote", "  > nested q", "| c | `x` |", "", "after"],
  ].map((lines) => lines.join("\n"));
  for (const source of cases) {
    const root = mount(source);
    const map = mapRendered(root, source);
    expect(map.projection.chars).toBe(map.dom.chars);
    expect([...map.toSource].every((i) => i >= 0)).toBe(true);
    const p = map.projection;
    for (let i = 0; i < p.chars.length; i += 1) expect(p.source.slice(p.from[i]!, p.to[i]!)).toBe(p.chars[i]!);
  }
});

test("random documents: every character pairs, and every selection draws exactly what was selected", () => {
  const templates = [
    "# Heading *em* {w}",
    "Para {w} with **bold** and `code` and [link {w}](https://x.y/{w}).",
    "continued {w} line",
    "- item {w}",
    "  - nested {w} **b**",
    "    1. deep {w}",
    "-",
    "  foo {w}",
    "2) paren {w}",
    "> quote {w}",
    "> > deep quote {w}",
    "> - list in quote {w}",
    "  > nested q {w}",
    ">",
    "| h1 {w} | h2 |",
    "|---|:-:|",
    "| c {w} | `x\\|y` |",
    "```js",
    "let {w} = 1 < 2;",
    "```",
    "~~~",
    "    indented {w}",
    "<div>",
    "<b>html {w}</b> text",
    "</div>",
    "Setext {w}",
    "===",
    "---",
    "[ref]: https://x.y",
    "Ref [text {w}][ref] and [x]",
    "- [ ] task {w}",
    "&amp; entity {w} &copy; \\*esc\\*",
    "Hard break {w}  ",
    "中文 {w} **加粗** 结尾。",
    "",
    "",
    "\t-\tnested tab {w}",
    "<https://auto.link/{w}> and www.ex{w}.com",
    "> <div>",
    "> <b>quoted html {w}</b> text",
  ];
  let seed = 11;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let d = 0; d < 250; d += 1) {
    const count = 3 + next(16);
    const source = Array.from({ length: count }, (_, i) => templates[next(templates.length)]!.replace(/\{w\}/g, `w${d}_${i}`)).join("\n");
    const root = mount(source);
    const map = mapRendered(root, source);
    if (map.projection.chars !== map.dom.chars || [...map.toSource].some((i) => i < 0)) throw new Error(`unpaired: ${JSON.stringify(source)}`);
    // The document's own text nodes, chrome left out, so "what was selected" is what a reader sees.
    const nodes = map.dom.nodes;
    for (let t = 0; t < 12 && nodes.length > 0; t += 1) {
      const a = next(nodes.length);
      const b = next(nodes.length);
      const [s, e] = a <= b ? [a, b] : [b, a];
      const so = next(nodes[s]!.data.length + 1);
      const eo = next(nodes[e]!.data.length + 1);
      if (s === e && eo <= so) continue;
      const range = document.createRange();
      range.setStart(nodes[s]!, so);
      range.setEnd(nodes[e]!, eo);
      const anchor = anchorFromRange(map, range);
      if (!anchor) continue;
      const check = validateAnchor("text_range", anchor);
      if (!check.ok) throw new Error(`${check.reason}: ${JSON.stringify({ source, anchor })}`);
      const seen = s === e ? nodes[s]!.data.slice(so, eo) : nodes[s]!.data.slice(so) + nodes.slice(s + 1, e).map((n) => n.data).join("") + nodes[e]!.data.slice(0, eo);
      // Every character paired, so every anchor is exact: its quote is the source between its columns.
      expect(sourceSlice(source, anchor)).toBe(anchor.quote);
      expect(shown(rangesForAnchor(map, anchor))).toBe(squash(seen));
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(1500);
});
