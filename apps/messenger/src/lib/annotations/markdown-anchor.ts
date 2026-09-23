/**
 * Markdown 渲染态划词（#25）的 DOM 一侧：渲染出来的字 ↔ 源文的行列。
 * - `mapRendered`：收集渲染区里的文字节点（代码块的 `.code-header` 这类外壳不算），和 `projectVisible` 的
 *   投影逐字对齐；一个字只和行号落在它所在块（`data-src-start/end`）里的源文字配对。
 * - `anchorFromRange`：选区 → `text_range` 锚点（`view: "rendered"`）。对得上就是源文里的精确行列，引文和
 *   前后缀取自源文，和源码视图里划出来的一样；对不上就退到覆盖它的块的整行，引文用选中的字。
 * - `rangesForAnchor` / `rangesForRow`：锚点 → 一组 DOM Range，交给 CSS Custom Highlight API 去画，不动 DOM。
 * - `createHighlightPainter`：把几组 Range 挂进 `CSS.highlights`；不支持的环境（happy-dom、旧 WebKit）什么也不做。
 */
import {
  ANNOTATION_QUOTE_MAX,
  relocateTextRange,
  textRangeFromSelection,
  type Annotation,
  type AnnotationStale,
  type TextRangeAnchor,
} from "@real-bot/protocol";
import { SRC_END_ATTR, SRC_START_ATTR, lineStarts, projectVisible, type SourceLines, type VisibleProjection } from "./markdown-lines.ts";

/** Chrome inside the rendered body that is not the document's text: code headers, icons, thumbnails. */
export const RENDERED_CHROME = ".code-header, .md-external-icon, svg, button, img, [data-annotator-chrome]";

/** The rendered body's text, node by node, and its visible characters with their blocks. */
export type RenderedText = {
  root: HTMLElement;
  nodes: Text[];
  nodeIndex: Map<Text, number>;
  /** Where each node starts in `text`. */
  starts: number[];
  text: string;
  /** The non-whitespace characters of `text`, in order. */
  chars: string;
  /** `pos[j]`: where `chars[j]` sits in `text`. */
  pos: number[];
  /** The source lines of the innermost block around `chars[j]`; 0 when it is in none. */
  blockStart: Int32Array;
  blockEnd: Int32Array;
};

/** Both sides and how their characters pair up. */
export type RenderedMap = {
  source: string;
  lineStarts: number[];
  projection: VisibleProjection;
  dom: RenderedText;
  /** Rendered character → projection character, −1 when it has no partner. */
  toSource: Int32Array;
  /** Projection character → rendered character, −1 when it is not on screen. */
  toDom: Int32Array;
};

/** A selection's ends, as `Range` and `StaticRange` both have them. */
export type RangeLike = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };

/** A stretch of the rendered text, as offsets into `RenderedText.text`. */
export type RenderedSpan = { from: number; to: number };

const WHITESPACE = /\s/;
const PRECEDING = 2;
const FOLLOWING = 4;
const CONTAINS = 8;

function collectText(parent: Node, out: Text[]): void {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) out.push(child as Text);
    else if (child.nodeType === 1 && !(child as Element).matches(RENDERED_CHROME)) collectText(child, out);
  }
}

function blockOf(node: Text, root: Element, cache: Map<Element, SourceLines | null>): SourceLines | null {
  const el = node.parentElement?.closest(`[${SRC_START_ATTR}]`);
  if (!el || !root.contains(el)) return null;
  const known = cache.get(el);
  if (known !== undefined) return known;
  const start = Number(el.getAttribute(SRC_START_ATTR));
  const end = Number(el.getAttribute(SRC_END_ATTR));
  const lines = Number.isInteger(start) && start >= 1 ? { start, end: Number.isInteger(end) && end >= start ? end : start } : null;
  cache.set(el, lines);
  return lines;
}

/** Read the rendered body: its text nodes (chrome left out) and every visible character's block. */
export function indexRendered(root: HTMLElement): RenderedText {
  const nodes: Text[] = [];
  collectText(root, nodes);
  const starts: number[] = [];
  const parts: string[] = [];
  const chars: string[] = [];
  const pos: number[] = [];
  const blockStart: number[] = [];
  const blockEnd: number[] = [];
  const cache = new Map<Element, SourceLines | null>();
  let offset = 0;
  for (const node of nodes) {
    const data = node.data;
    starts.push(offset);
    parts.push(data);
    const block = blockOf(node, root, cache);
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i]!;
      if (WHITESPACE.test(ch)) continue;
      chars.push(ch);
      pos.push(offset + i);
      blockStart.push(block?.start ?? 0);
      blockEnd.push(block?.end ?? 0);
    }
    offset += data.length;
  }
  return {
    root,
    nodes,
    nodeIndex: new Map(nodes.map((node, k) => [node, k])),
    starts,
    text: parts.join(""),
    chars: chars.join(""),
    pos,
    blockStart: Int32Array.from(blockStart),
    blockEnd: Int32Array.from(blockEnd),
  };
}

const RESYNC_WINDOW = 32;
const RESYNC_RUN = 3;

/**
 * Pair the two character sequences in order. They are nearly always equal; where they are not
 * (a chip's avatar letter, a tag the sanitizer emptied) skip ahead on either side to the nearest
 * point where a few characters agree again. A pair must also agree on lines: the source character
 * has to sit inside the rendered character's block.
 */
function align(map: { p: string; pLine: Int32Array; d: string; ds: Int32Array; de: Int32Array }): { toSource: Int32Array; toDom: Int32Array } {
  const { p, pLine, d, ds, de } = map;
  const toSource = new Int32Array(d.length).fill(-1);
  const toDom = new Int32Array(p.length).fill(-1);
  const same = (i: number, j: number): boolean => p[i] === d[j] && (ds[j] === 0 || (pLine[i]! >= ds[j]! && pLine[i]! <= de[j]!));
  const run = (i: number, j: number): boolean => {
    for (let k = 0; k < RESYNC_RUN; k += 1) {
      if (i + k >= p.length || j + k >= d.length) return k > 0;
      if (!same(i + k, j + k)) return false;
    }
    return true;
  };
  let i = 0;
  let j = 0;
  while (i < p.length && j < d.length) {
    if (same(i, j)) {
      toSource[j] = i;
      toDom[i] = j;
      i += 1;
      j += 1;
      continue;
    }
    // Whole stretches one side has and the other does not: move the side that is behind in lines.
    if (ds[j] !== 0 && pLine[i]! < ds[j]!) {
      i += 1;
      continue;
    }
    if (ds[j] !== 0 && pLine[i]! > de[j]!) {
      j += 1;
      continue;
    }
    let moved = false;
    search: for (let total = 1; total <= 2 * RESYNC_WINDOW; total += 1) {
      for (let di = Math.max(0, total - RESYNC_WINDOW); di <= Math.min(total, RESYNC_WINDOW); di += 1) {
        const dj = total - di;
        if (run(i + di, j + dj)) {
          i += di;
          j += dj;
          moved = true;
          break search;
        }
      }
    }
    if (!moved) {
      i += 1;
      j += 1;
    }
  }
  return { toSource, toDom };
}

/** Index the rendered body and pair it with the source it was rendered from. */
export function mapRendered(root: HTMLElement, source: string | VisibleProjection): RenderedMap {
  const projection = typeof source === "string" ? projectVisible(source) : source;
  const starts = lineStarts(projection.source);
  const pLine = new Int32Array(projection.chars.length);
  let line = 1;
  for (let i = 0; i < projection.from.length; i += 1) {
    const at = projection.from[i]!;
    while (line < starts.length && starts[line]! <= at) line += 1;
    pLine[i] = line;
  }
  const dom = indexRendered(root);
  const { toSource, toDom } = align({ p: projection.chars, pLine, d: dom.chars, ds: dom.blockStart, de: dom.blockEnd });
  return { source: projection.source, lineStarts: starts, projection, dom, toSource, toDom };
}

function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether a text node lies wholly before a boundary point. */
function nodeBeforePoint(node: Text, container: Node, offset: number): boolean {
  if (container.nodeType !== 1 && container.nodeType !== 9 && container.nodeType !== 11) {
    return (container.compareDocumentPosition(node) & PRECEDING) !== 0;
  }
  const children = container.childNodes;
  if (offset < children.length) {
    const ref = children[offset]!;
    return (ref.compareDocumentPosition(node) & PRECEDING) !== 0;
  }
  return container.contains(node) || (container.compareDocumentPosition(node) & PRECEDING) !== 0;
}

/**
 * A boundary point as an offset into the rendered text. A point inside chrome (a code header)
 * lands where the chrome would have been: right before the text that follows it.
 */
export function offsetAt(dom: RenderedText, container: Node, offset: number): number {
  if (container.nodeType === 3) {
    const k = dom.nodeIndex.get(container as Text);
    if (k !== undefined) return dom.starts[k]! + Math.min(Math.max(0, offset), (container as Text).data.length);
  }
  let lo = 0;
  let hi = dom.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nodeBeforePoint(dom.nodes[mid]!, container, offset)) lo = mid + 1;
    else hi = mid;
  }
  return lo < dom.nodes.length ? dom.starts[lo]! : dom.text.length;
}

/** Which child of `ancestor` holds `el` (or is it). */
function childIndexToward(ancestor: Node, el: Node): number {
  let node: Node | null = el;
  while (node && node.parentNode !== ancestor) node = node.parentNode;
  return node ? Array.prototype.indexOf.call(ancestor.childNodes, node) : -1;
}

/** Keep a selection to the part inside `el`; null when it does not reach into it. */
export function clampRange(range: RangeLike, el: Element): RangeLike | null {
  let { startContainer, startOffset, endContainer, endOffset } = range;
  if (!el.contains(startContainer)) {
    const rel = el.compareDocumentPosition(startContainer);
    const before = rel & CONTAINS ? startOffset <= childIndexToward(startContainer, el) : (rel & PRECEDING) !== 0;
    if (!before) return null;
    startContainer = el;
    startOffset = 0;
  }
  if (!el.contains(endContainer)) {
    const rel = el.compareDocumentPosition(endContainer);
    const after = rel & CONTAINS ? endOffset > childIndexToward(endContainer, el) : (rel & FOLLOWING) !== 0;
    if (!after) return null;
    endContainer = el;
    endOffset = el.childNodes.length;
  }
  return { startContainer, startOffset, endContainer, endOffset };
}

function lineCol(map: RenderedMap, offset: number): { line: number; col: number } {
  const line = lowerBound(map.lineStarts, offset + 1);
  return { line, col: offset - map.lineStarts[line - 1]! + 1 };
}

function lineLength(map: RenderedMap, line: number): number {
  const start = map.lineStarts[line - 1];
  if (start === undefined) return 0;
  const next = map.lineStarts[line];
  return (next === undefined ? map.source.length + 1 : next) - 1 - start;
}

function offsetOf(map: RenderedMap, line: number, col: number): number {
  const at = Math.min(Math.max(1, line), map.lineStarts.length);
  return map.lineStarts[at - 1]! + Math.min(Math.max(0, col - 1), lineLength(map, at));
}

function clip(text: string): string {
  const chars = [...text];
  return chars.length <= ANNOTATION_QUOTE_MAX ? text : chars.slice(0, ANNOTATION_QUOTE_MAX).join("");
}

/** What the person selected, as they read it: line breaks kept, runs of spaces folded. */
function readable(text: string): string {
  return text
    .replace(/[ \t ]*\n\s*/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .trim();
}

/** The lines of the blocks a stretch of rendered characters runs through. */
function blockLines(map: RenderedMap, ja: number, jb: number): SourceLines | null {
  let start = 0;
  let end = 0;
  for (let j = ja; j <= jb; j += 1) {
    const s = map.dom.blockStart[j]!;
    if (s === 0) continue;
    const e = map.dom.blockEnd[j]!;
    if (start === 0 || s < start) start = s;
    if (e > end) end = e;
  }
  if (start === 0) return null;
  const last = map.lineStarts.length;
  return { start: Math.min(start, last), end: Math.min(Math.max(end, start), last) };
}

/**
 * A selection in the rendered body → a text range in the source. Exact when every selected
 * character pairs with the source in one unbroken run: those columns, with quote and affixes
 * from the source, the way the source view would have made it. Otherwise the whole lines of the
 * blocks it touches, with the selected text as the quote. Null for an empty or blank selection.
 */
export function anchorFromRange(map: RenderedMap, range: RangeLike): TextRangeAnchor | null {
  const { dom, projection } = map;
  const a = offsetAt(dom, range.startContainer, range.startOffset);
  const b = offsetAt(dom, range.endContainer, range.endOffset);
  if (b <= a) return null;
  const ja = lowerBound(dom.pos, a);
  const jb = lowerBound(dom.pos, b) - 1;
  if (ja > jb || ja >= dom.chars.length) return null;
  const pa = map.toSource[ja]!;
  const pb = map.toSource[jb]!;
  if (pa >= 0 && pb - pa === jb - ja && projection.chars.slice(pa, pb + 1) === dom.chars.slice(ja, jb + 1)) {
    const start = lineCol(map, projection.from[pa]!);
    const end = lineCol(map, projection.to[pb]!);
    const anchor = textRangeFromSelection(map.source, { start_line: start.line, start_col: start.col, end_line: end.line, end_col: end.col });
    return { ...anchor, view: "rendered" };
  }
  const lines = blockLines(map, ja, jb);
  if (!lines) return null;
  const whole = textRangeFromSelection(map.source, {
    start_line: lines.start,
    start_col: 1,
    end_line: lines.end,
    end_col: lineLength(map, lines.end) + 1,
  });
  // The quote here is what was read on screen, not the head of the source span, so the span's
  // fingerprint (measured from that head) would only mislead relocation.
  const { span_length: _length, span_hash: _hash, ...lined } = whole;
  return { ...lined, quote: clip(readable(dom.text.slice(a, b))), view: "rendered" };
}

type LineRange = { start_line: number; start_col: number; end_line: number; end_col: number };

/** Where an anchor sits in the source on screen: moved when the daemon says so, relocated when the file changed. */
function effectiveRange(anchor: TextRangeAnchor, stale: AnnotationStale | undefined, source: string): LineRange | null {
  if (stale?.kind === "missing") return null;
  if (stale?.kind === "moved") return { start_line: stale.start_line, start_col: stale.start_col, end_line: stale.end_line, end_col: stale.end_col };
  if (stale?.kind === "changed") return relocateTextRange(anchor, source);
  return anchor;
}

/** The first place the quote's visible characters appear among rendered characters `j0..j1`. */
function quoteSpan(map: RenderedMap, quote: string, j0: number, j1: number): RenderedSpan | null {
  const needle = quote.replace(/\s+/g, "");
  if (!needle || j1 < j0) return null;
  const at = map.dom.chars.slice(j0, j1 + 1).indexOf(needle);
  if (at < 0) return null;
  return { from: map.dom.pos[j0 + at]!, to: map.dom.pos[j0 + at + needle.length - 1]! + 1 };
}

/**
 * An anchor on screen, as a stretch of the rendered text. A range whose source text is still its
 * quote maps character by character; a block-level one (or one whose columns no longer hold its
 * quote) finds the quote inside those blocks, and failing that marks the blocks whole. A stale
 * range that cannot be relocated looks for its quote anywhere; `missing` is never drawn.
 */
export function spanForAnchor(map: RenderedMap, anchor: TextRangeAnchor, stale?: AnnotationStale): RenderedSpan | null {
  const { dom, projection } = map;
  const where = effectiveRange(anchor, stale, map.source);
  if (!where) {
    if (stale?.kind === "changed" && anchor.quote.trim()) return quoteSpan(map, anchor.quote, 0, dom.chars.length - 1);
    return null;
  }
  const s0 = offsetOf(map, where.start_line, where.start_col);
  const s1 = offsetOf(map, where.end_line, where.end_col);
  if (s1 > s0 && anchor.quote && clip(map.source.slice(s0, s1)) === anchor.quote) {
    const i0 = lowerBound(projection.from, s0);
    const i1 = lowerBound(projection.from, s1) - 1;
    let j0 = -1;
    let j1 = -1;
    for (let i = i0; i <= i1; i += 1) {
      const j = map.toDom[i]!;
      if (j < 0) continue;
      if (j0 < 0) j0 = j;
      j1 = j;
    }
    if (j0 >= 0) return { from: dom.pos[j0]!, to: dom.pos[j1]! + 1 };
  }
  const first = Math.min(where.start_line, where.end_line);
  const last = Math.max(where.start_line, where.end_line);
  let r0 = -1;
  let r1 = -1;
  for (let j = 0; j < dom.chars.length; j += 1) {
    const s = dom.blockStart[j]!;
    if (s === 0 || s > last || dom.blockEnd[j]! < first) continue;
    if (r0 < 0) r0 = j;
    r1 = j;
  }
  if (r0 < 0) return null;
  return quoteSpan(map, anchor.quote, r0, r1) ?? { from: dom.pos[r0]!, to: dom.pos[r1]! + 1 };
}

/** A stretch of rendered text as DOM ranges, one per text node, blank pieces left out. */
export function rangesForSpan(map: RenderedMap, span: RenderedSpan | null): Range[] {
  if (!span || span.to <= span.from) return [];
  const { nodes, starts, root } = map.dom;
  const doc = root.ownerDocument;
  const out: Range[] = [];
  let k = Math.max(0, lowerBound(starts, span.from + 1) - 1);
  for (; k < nodes.length; k += 1) {
    const start = starts[k]!;
    if (start >= span.to) break;
    const node = nodes[k]!;
    const end = start + node.data.length;
    if (end <= span.from || !node.isConnected) continue;
    const from = Math.max(0, span.from - start);
    const to = Math.min(node.data.length, span.to - start);
    if (to <= from || !/\S/.test(node.data.slice(from, to))) continue;
    const range = doc.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    out.push(range);
  }
  return out;
}

export function rangesForAnchor(map: RenderedMap, anchor: TextRangeAnchor, stale?: AnnotationStale): Range[] {
  return rangesForSpan(map, spanForAnchor(map, anchor, stale));
}

/** An annotation row's ranges; nothing for another kind or a missing file. */
export function rangesForRow(map: RenderedMap, row: Pick<Annotation, "anchor_kind" | "anchor" | "stale">): Range[] {
  if (row.anchor_kind !== "text_range") return [];
  return rangesForAnchor(map, row.anchor as TextRangeAnchor, row.stale ?? undefined);
}

export type RectLike = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** The boxes a set of ranges covers on screen; none where there is no layout (tests). */
export function rectsOf(ranges: readonly Range[]): RectLike[] {
  const out: RectLike[] = [];
  for (const range of ranges) {
    if (typeof range.getClientRects !== "function") continue;
    for (const rect of range.getClientRects()) if (rect.width > 0 || rect.height > 0) out.push(rect);
  }
  return out;
}

export function pointInRects(rects: readonly RectLike[], x: number, y: number, slop = 1): boolean {
  return rects.some((r) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop);
}

export const HIGHLIGHT_PENDING = "rb-md-annot-pending";
export const HIGHLIGHT_FLASH = "rb-md-annot-flash";

/** The highlight an annotation is painted with: its status, and `-stale` when the file moved on. */
export function highlightName(row: Pick<Annotation, "status" | "stale">): string {
  const status = row.status === "draft" ? "draft" : row.status === "resolved" ? "resolved" : "open";
  return `rb-md-annot-${status}${row.stale ? "-stale" : ""}`;
}

const PRIORITY: Record<string, number> = { resolved: 1, open: 2, draft: 3, pending: 4, flash: 5 };

function priorityOf(name: string): number {
  return PRIORITY[name.replace(/^rb-md-annot-/, "").replace(/-stale$/, "")] ?? 0;
}

/** Just enough of `Highlight` and `CSS.highlights` for the painter, so a test can hand in fakes. */
export type HighlightLike = { add(range: AbstractRange): unknown; delete(range: AbstractRange): unknown; readonly size: number; priority: number };
export type HighlightEnv = {
  registry: { get(name: string): HighlightLike | undefined; set(name: string, highlight: HighlightLike): unknown; delete(name: string): unknown };
  create: () => HighlightLike;
};

/** The browser's highlight registry, or null where the CSS Custom Highlight API is missing. */
export function browserHighlightEnv(): HighlightEnv | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightEnv["registry"] } }).CSS;
  const HighlightCtor = (globalThis as { Highlight?: new () => HighlightLike }).Highlight;
  if (!css?.highlights || typeof HighlightCtor !== "function") return null;
  return { registry: css.highlights, create: () => new HighlightCtor() };
}

export type HighlightPainter = {
  readonly supported: boolean;
  /** Replace everything this painter drew with these groups (highlight name → ranges). */
  paint: (groups: ReadonlyMap<string, readonly AbstractRange[]>) => void;
  clear: () => void;
};

/**
 * One painter per annotator. Highlights are registered by name for the whole document, so each
 * painter adds and removes only its own ranges and drops a name once nobody paints with it.
 */
export function createHighlightPainter(env: HighlightEnv | null = browserHighlightEnv()): HighlightPainter {
  let mine = new Map<string, readonly AbstractRange[]>();
  const paint = (groups: ReadonlyMap<string, readonly AbstractRange[]>): void => {
    if (!env) return;
    for (const [name, ranges] of mine) {
      const highlight = env.registry.get(name);
      if (!highlight) continue;
      for (const range of ranges) highlight.delete(range);
      if (highlight.size === 0) env.registry.delete(name);
    }
    mine = new Map();
    for (const [name, ranges] of groups) {
      if (ranges.length === 0) continue;
      let highlight = env.registry.get(name);
      if (!highlight) {
        highlight = env.create();
        highlight.priority = priorityOf(name);
        env.registry.set(name, highlight);
      }
      for (const range of ranges) highlight.add(range);
      mine.set(name, ranges);
    }
  };
  return { supported: env !== null, paint, clear: () => paint(new Map()) };
}
