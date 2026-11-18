/**
 * PDF 页内区域（#27）的纯逻辑，PdfViewer 和 pdf.js 适配层共用：缩放档位与「适合宽度 / 适合页面」、
 * 按页尺寸排版和「现在是第几页」、画布像素上限与回收、从文字层取框内引文、查找的匹配与高亮切片、
 * 锚点 ⇄ 框。框的几何（拖、点、挪、改大小、裁图）在 region-box.ts，这里不重复。
 * 所有位置都按该页归一化到 0–1，缩放多少都不影响存下的锚点。
 */
import {
  ANNOTATION_QUOTE_MAX,
  validateAnchor,
  type Annotation,
  type PdfRegionAnchor,
} from "@real-bot/protocol";
import type { Handle, NormBox, NormPoint, Size } from "./region-box.ts";

/** pdf.js 的 100%：1 pt = 96/72 CSS px，和浏览器自带的 PDF 查看器一样。 */
export const PDF_TO_CSS_UNITS = 96 / 72;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** What + and − step through. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
/** What the zoom menu lists besides the two fits. */
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** Space between pages and around them, in CSS px. The layout model and the stylesheet share it. */
export const PAGE_GAP = 12;
/** One canvas never holds more than this many pixels (4096²): past it the page is drawn softer. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;
/** Pages kept drawn at once, and the pixels they may hold together (~160 MB of RGBA). */
export const MAX_RENDERED_PAGES = 10;
export const RENDER_BUDGET_PIXELS = 40_000_000;
/** Find stops counting here, so a one-letter query on a huge file stays bounded. */
export const FIND_MATCH_MAX = 5000;

export type ZoomMode = { kind: "fit-width" } | { kind: "fit-page" } | { kind: "scale"; value: number };

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** The zoom at which a page (sized at 100%) fills the width of the scroller, less the gutters. */
export function fitWidthZoom(page: Size, box: Size, gap = PAGE_GAP): number {
  if (page.width <= 0 || box.width <= 0) return 1;
  return clampZoom((box.width - 2 * gap) / page.width);
}

/** The zoom at which a whole page fits in the scroller. */
export function fitPageZoom(page: Size, box: Size, gap = PAGE_GAP): number {
  if (page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return clampZoom(Math.min((box.width - 2 * gap) / page.width, (box.height - 2 * gap) / page.height));
}

/** A zoom mode as a number, given the page it is fitted to and the scroller it is fitted in. */
export function resolveZoom(mode: ZoomMode, page: Size, box: Size, gap = PAGE_GAP): number {
  if (mode.kind === "fit-width") return fitWidthZoom(page, box, gap);
  if (mode.kind === "fit-page") return fitPageZoom(page, box, gap);
  return clampZoom(mode.value);
}

/**
 * What the fits measure against: the widest and the tallest page. A landscape page among portrait
 * ones then still fits the width, so "fit width" never leaves a sideways scrollbar.
 */
export function fitBasis(sizes: readonly Size[]): Size | null {
  if (sizes.length === 0) return null;
  let width = 0;
  let height = 0;
  for (const size of sizes) {
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  }
  return { width, height };
}

/** The next step up from `current`; a zoom between steps goes to the step above it. */
export function zoomIn(current: number): number {
  for (const step of ZOOM_STEPS) if (step > current + 1e-6) return step;
  return MAX_ZOOM;
}

export function zoomOut(current: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) if (ZOOM_STEPS[i]! < current - 1e-6) return ZOOM_STEPS[i]!;
  return MIN_ZOOM;
}

/** The zoom menu's value for a mode: the fit's name, or the number. */
export function zoomMenuValue(mode: ZoomMode): string {
  return mode.kind === "scale" ? String(clampZoom(mode.value)) : mode.kind;
}

export function parseZoomMenuValue(value: string): ZoomMode | null {
  if (value === "fit-width" || value === "fit-page") return { kind: value };
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? { kind: "scale", value: clampZoom(n) } : null;
}

export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Where every page sits in the scroller at a zoom: whole pixels, rounded down like pdf.js does. */
export type PageLayout = { tops: number[]; widths: number[]; heights: number[]; total: number };

export function pageLayout(sizes: readonly Size[], zoom: number, gap = PAGE_GAP): PageLayout {
  const tops: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = gap;
  for (const size of sizes) {
    const width = Math.max(1, Math.floor(size.width * zoom));
    const height = Math.max(1, Math.floor(size.height * zoom));
    tops.push(y);
    widths.push(width);
    heights.push(height);
    y += height + gap;
  }
  return { tops, widths, heights, total: y };
}

/**
 * The page on screen: the one showing the most of itself in the viewport; a tie goes to the upper
 * one. 1-based; 1 for an empty document.
 */
export function currentPageAt(layout: PageLayout, scrollTop: number, viewportHeight: number): number {
  const n = layout.tops.length;
  if (n === 0) return 1;
  const top = scrollTop;
  const bottom = scrollTop + Math.max(1, viewportHeight);
  // The first page whose bottom edge is below the viewport's top.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layout.tops[mid]! + layout.heights[mid]! <= top) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  let bestShown = -1;
  for (let i = lo; i < n && layout.tops[i]! < bottom; i += 1) {
    const shown = Math.min(bottom, layout.tops[i]! + layout.heights[i]!) - Math.max(top, layout.tops[i]!);
    if (shown > bestShown + 0.5) {
      best = i;
      bestShown = shown;
    }
  }
  return best + 1;
}

/** Scroll offset that puts a page's top just under the viewport's top edge. */
export function scrollTopForPage(layout: PageLayout, page: number, gap = PAGE_GAP): number {
  const i = Math.min(Math.max(1, Math.round(page)), Math.max(1, layout.tops.length)) - 1;
  return Math.max(0, (layout.tops[i] ?? 0) - gap);
}

/** Scroll offset that shows a point of a page (normalized y) a third of the way down the viewport. */
export function scrollTopForPoint(layout: PageLayout, page: number, y: number, viewportHeight: number): number {
  const i = page - 1;
  if (i < 0 || i >= layout.tops.length) return 0;
  return Math.max(0, layout.tops[i]! + y * layout.heights[i]! - viewportHeight / 3);
}

/** A page number typed into the box, or null when it is not one. */
export function parsePageNumber(input: string, numPages: number): number | null {
  const n = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(n) || numPages < 1) return null;
  return Math.min(Math.max(1, n), numPages);
}

/**
 * Device pixels per CSS pixel for one page's canvas: the screen's ratio, lowered so the canvas stays
 * under `maxPixels`. A zoomed-in page is then a little soft instead of a crashed tab.
 */
export function outputScaleFor(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxPixels = MAX_CANVAS_PIXELS): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  if (area * ratio * ratio <= maxPixels) return ratio;
  return Math.max(0.1, Math.sqrt(maxPixels / area));
}

/** Near pages in the order they should be drawn: the current one first, then outward. */
export function renderOrder(near: Iterable<number>, current: number): number[] {
  return [...new Set(near)].sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
}

export type RenderedPage = { page: number; pixels: number; lastUsed: number };

/**
 * Which drawn pages to let go: the least recently used ones that are not near the viewport, until
 * both the page count and the pixel total are within bounds. Near pages are never evicted.
 */
export function pickEvictions(
  rendered: readonly RenderedPage[],
  keep: ReadonlySet<number>,
  maxPages = MAX_RENDERED_PAGES,
  maxPixels = RENDER_BUDGET_PIXELS,
): number[] {
  let count = rendered.length;
  let pixels = rendered.reduce((sum, row) => sum + row.pixels, 0);
  const out: number[] = [];
  const candidates = rendered.filter((row) => !keep.has(row.page)).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const row of candidates) {
    if (count <= maxPages && pixels <= maxPixels) break;
    out.push(row.page);
    count -= 1;
    pixels -= row.pixels;
  }
  return out;
}

/**
 * Which way a run reads on screen, in degrees clockwise from left to right: 90 reads top to bottom
 * (a page shown turned a quarter clockwise, /Rotate 90), 180 upside down, 270 bottom to top.
 */
export type TextAngle = 0 | 90 | 180 | 270;

/**
 * One run of text on a page, where it is drawn (normalized to the page), which way it reads, and
 * whether a line ends after it. No `angle` is left to right; null is a run slanted off both axes,
 * whose box says nothing about where each character is.
 */
export type TextRun = { text: string; rect: NormBox; angle?: TextAngle | null; eol?: boolean };

/** What pdf.js `getTextContent()` hands back per item, in the fields used here. */
export type PdfTextItemLike = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
/** The part of a pdf.js `PageViewport` used here. */
export type ViewportLike = {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function normalizedBounds(points: number[][], viewport: ViewportLike): NormBox | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    x0 = Math.min(x0, x!);
    y0 = Math.min(y0, y!);
    x1 = Math.max(x1, x!);
    y1 = Math.max(y1, y!);
  }
  const left = clamp01(x0 / viewport.width);
  const top = clamp01(y0 / viewport.height);
  const right = clamp01(x1 / viewport.width);
  const bottom = clamp01(y1 / viewport.height);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

const NO_RECT: NormBox = { x: 0, y: 0, w: 0, h: 0 };

/** How far off an axis (sin of ~10°) a baseline may lean and still count as running along it. */
const AXIS_SLACK = Math.sin(Math.PI / 18);

/** The way a baseline runs on screen (y grows downward), snapped to an axis; null when it is slanted or has no length. */
function readingAngle(dx: number, dy: number): TextAngle | null {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len === 0) return null;
  if (Math.abs(dy) <= AXIS_SLACK * len) return dx > 0 ? 0 : 180;
  if (Math.abs(dx) <= AXIS_SLACK * len) return dy > 0 ? 90 : 270;
  return null;
}

/**
 * Text items as boxes on the page, without a text layer: each run goes from its baseline origin
 * along its direction for its width, from a fifth of its height below the baseline to 85% above
 * (glyph descent and ascent, near enough). Rotated pages and rotated text come out as their
 * on-screen bounding box, with the way the run reads on screen as `angle`. One run per item, in
 * the same order — find maps a match's item index straight into this list — so an item that
 * cannot be placed gets an empty box, which quotes skip.
 */
export function textRunsFromItems(items: readonly PdfTextItemLike[], viewport: ViewportLike): TextRun[] {
  const out: TextRun[] = [];
  for (const item of items) {
    const text = typeof item.str === "string" ? item.str : "";
    const eol = item.hasEOL === true;
    if (!Array.isArray(item.transform)) {
      out.push({ text, rect: NO_RECT, eol });
      continue;
    }
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len;
    const uy = b / len;
    const height = item.height > 0 ? item.height : Math.hypot(c, d);
    const width = Math.max(0, item.width);
    // "Up" is the baseline turned a quarter anticlockwise, in PDF space where y grows upward.
    const vx = -uy * height;
    const vy = ux * height;
    const bx = e - 0.2 * vx;
    const by = f - 0.2 * vy;
    const tx = e + 0.85 * vx;
    const ty = f + 0.85 * vy;
    const corners = [
      [bx, by],
      [bx + ux * width, by + uy * width],
      [tx + ux * width, ty + uy * width],
      [tx, ty],
    ].map(([x, y]) => viewport.convertToViewportPoint(x!, y!));
    // One unit along the baseline, on screen: the page's /Rotate and the text's own turn together.
    const [sx0 = Number.NaN, sy0 = Number.NaN] = viewport.convertToViewportPoint(e, f);
    const [sx1 = Number.NaN, sy1 = Number.NaN] = viewport.convertToViewportPoint(e + ux, f + uy);
    const angle = readingAngle(sx1 - sx0, sy1 - sy0);
    out.push({ text, rect: normalizedBounds(corners, viewport) ?? NO_RECT, angle, eol });
  }
  return out;
}

export type PdfLinkTarget = { rect: NormBox; url: string | null; dest: unknown };

/** The part of a pdf.js link annotation used here. */
export type PdfAnnotationLike = { subtype?: string; rect?: number[]; url?: string; dest?: unknown };

const SAFE_URL = /^(https?:|mailto:)/i;

/** A page's link annotations as boxes: web and mail links, and links to a place in the document. */
export function linkTargets(annotations: readonly PdfAnnotationLike[], viewport: ViewportLike): PdfLinkTarget[] {
  const out: PdfLinkTarget[] = [];
  for (const a of annotations) {
    if (a.subtype !== "Link" || !Array.isArray(a.rect) || a.rect.length < 4) continue;
    const url = typeof a.url === "string" && SAFE_URL.test(a.url.trim()) ? a.url.trim() : null;
    const dest = a.dest ?? null;
    if (!url && dest === null) continue;
    const [x1, y1, x2, y2] = a.rect as [number, number, number, number];
    const rect = normalizedBounds(
      [
        viewport.convertToViewportPoint(x1, y1),
        viewport.convertToViewportPoint(x2, y2),
        viewport.convertToViewportPoint(x1, y2),
        viewport.convertToViewportPoint(x2, y1),
      ],
      viewport,
    );
    if (!rect || rect.w <= 0 || rect.h <= 0) continue;
    out.push({ rect, url, dest });
  }
  return out;
}

/** A piece of a quote, in its run's reading frame (x along the line, y down to the next line). */
type Piece = { text: string; x0: number; x1: number; y0: number; y1: number };

/**
 * A box turned into the frame of text that reads at `angle`: the run then reads left to right
 * along x and its lines stack down y, so cutting and ordering work the same for every angle.
 * A quarter-turn page swaps the axes; 0 is the box itself.
 */
function inReadingFrame(box: NormBox, angle: TextAngle): NormBox {
  if (angle === 90) return { x: box.y, y: -(box.x + box.w), w: box.h, h: box.w };
  if (angle === 180) return { x: -(box.x + box.w), y: -(box.y + box.h), w: box.w, h: box.h };
  if (angle === 270) return { x: -(box.y + box.h), y: box.x, w: box.h, h: box.w };
  return box;
}

/**
 * The text under a box, in reading order: runs whose line the box covers at least half of (a box
 * grazing the line above does not quote it), cut to the characters under the box in proportion
 * to where it starts and ends along the run. Each run is read its own way on screen (`angle`):
 * on a page turned a quarter, a line runs down the page and the next line sits beside it. Lines
 * in order, first to last along the line; a visible gap within a line becomes one space, a new
 * line a line break. A slanted run (angle null) is quoted whole, and only when the box covers most
 * of it. Text reading different ways is quoted one way at a time, in the order the runs come.
 * Trimmed, at most `max` characters, "" when nothing is there.
 */
export function quoteInBox(runs: readonly TextRun[], box: NormBox, max = ANNOTATION_QUOTE_MAX): string {
  /** Pieces per way of reading, in the order the runs first read that way; "slanted" in page axes. */
  const groups = new Map<TextAngle | "slanted", Piece[]>();
  const add = (key: TextAngle | "slanted", piece: Piece) => {
    const group = groups.get(key);
    if (group) group.push(piece);
    else groups.set(key, [piece]);
  };
  for (const run of runs) {
    if (!run.text || !run.text.trim()) continue;
    if (run.angle === null) {
      // Where each character sits is unknown: the whole run, when the box covers most of its box.
      const r = run.rect;
      const w = Math.min(r.x + r.w, box.x + box.w) - Math.max(r.x, box.x);
      const h = Math.min(r.y + r.h, box.y + box.h) - Math.max(r.y, box.y);
      if (w <= 0 || h <= 0 || w * h < 0.5 * r.w * r.h) continue;
      add("slanted", { text: run.text, x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h });
      continue;
    }
    const angle = run.angle ?? 0;
    const r = inReadingFrame(run.rect, angle);
    const b = inReadingFrame(box, angle);
    const bx1 = b.x + b.w;
    const by1 = b.y + b.h;
    const ix0 = Math.max(r.x, b.x);
    const ix1 = Math.min(r.x + r.w, bx1);
    const iy0 = Math.max(r.y, b.y);
    const iy1 = Math.min(r.y + r.h, by1);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    if (iy1 - iy0 < 0.5 * Math.min(r.h, b.h)) continue;
    const chars = [...run.text];
    let from = 0;
    let to = chars.length;
    if (r.w > 0) {
      const f0 = (ix0 - r.x) / r.w;
      const f1 = (ix1 - r.x) / r.w;
      from = Math.min(chars.length, Math.max(0, Math.round(f0 * chars.length)));
      to = Math.min(chars.length, Math.max(from, Math.round(f1 * chars.length)));
      if (to === from) {
        // Less than half a character under the box: keep the one it sits on.
        if (from >= chars.length) continue;
        to = from + 1;
      }
    }
    const text = chars.slice(from, to).join("");
    if (!text.trim()) continue;
    const step = r.w / Math.max(1, chars.length);
    add(angle, { text, x0: r.x + from * step, x1: r.x + to * step, y0: r.y, y1: r.y + r.h });
  }
  const text = [...groups.values()].map(readLines).filter(Boolean).join("\n").trim();
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

/** Pieces that read the same way, in one frame, as lines of text joined by line breaks. */
function readLines(pieces: Piece[]): string {
  // Lines: pieces whose middles across the line are within half a line of each other.
  pieces.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const lines: Piece[][] = [];
  for (const piece of pieces) {
    const mid = (piece.y0 + piece.y1) / 2;
    const line = lines[lines.length - 1];
    if (line) {
      const lineMid = line.reduce((sum, p) => sum + (p.y0 + p.y1) / 2, 0) / line.length;
      const lineH = Math.min(...line.map((p) => p.y1 - p.y0), piece.y1 - piece.y0);
      if (Math.abs(mid - lineMid) <= lineH / 2) {
        line.push(piece);
        continue;
      }
    }
    lines.push([piece]);
  }
  return lines
    .map((line) => {
      line.sort((a, b) => a.x0 - b.x0);
      let out = "";
      let prev: Piece | null = null;
      for (const piece of line) {
        if (prev) {
          const gap = piece.x0 - prev.x1;
          const height = Math.min(piece.y1 - piece.y0, prev.y1 - prev.y0);
          if (gap > 0.2 * height && !/\s$/.test(out) && !/^\s/.test(piece.text)) out += " ";
        }
        out += piece.text;
        prev = piece;
      }
      return out.replace(/[ \t ]+/g, " ").trim();
    })
    .filter(Boolean)
    .join("\n");
}

/** A page's text as find sees it: the items joined, a line break after each that ends a line. */
export type PageText = { text: string; starts: number[]; lengths: number[] };

export function pageTextIndex(items: ReadonlyArray<{ str: string; eol?: boolean }>): PageText {
  let text = "";
  const starts: number[] = [];
  const lengths: number[] = [];
  for (const item of items) {
    starts.push(text.length);
    lengths.push(item.str.length);
    text += item.str;
    if (item.eol) text += "\n";
  }
  return { text, starts, lengths };
}

/**
 * The query as a pattern: literal, any case; a space in it matches any run of whitespace or none
 * at all, because PDFs often draw the words of a line as separate runs with nothing between them.
 */
export function findPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(escaped.join("\\s*"), "giu");
}

export type TextMatch = { start: number; end: number };

export function findInText(text: string, pattern: RegExp | null, limit = FIND_MATCH_MAX): TextMatch[] {
  if (!pattern) return [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const out: TextMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length });
    if (out.length >= limit) break;
  }
  return out;
}

/** A match on a page, in that page's joined text. */
export type PdfMatch = { page: number; start: number; end: number };

/** Where a match lies in the text layer: the items it covers, and the part of each. */
export function matchSegments(index: PageText, match: TextMatch): Array<{ item: number; start: number; end: number }> {
  const out: Array<{ item: number; start: number; end: number }> = [];
  for (let i = 0; i < index.starts.length; i += 1) {
    const s = index.starts[i]!;
    const e = s + index.lengths[i]!;
    if (e <= match.start) continue;
    if (s >= match.end) break;
    const start = Math.max(match.start, s) - s;
    const end = Math.min(match.end, e) - s;
    if (end > start) out.push({ item: i, start, end });
  }
  return out;
}

/** Next or previous match, wrapping around; the first (or last) when none is chosen yet. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** The first match on or after a page, wrapping to the first one; -1 when there are none. */
export function firstMatchFrom(matches: readonly PdfMatch[], page: number): number {
  if (matches.length === 0) return -1;
  const at = matches.findIndex((m) => m.page >= page);
  return at >= 0 ? at : 0;
}

export type HighlightPiece = { text: string; mark: null | "match" | "selected" };

/** A text item cut into plain and highlighted pieces, for painting matches into its span. */
export function highlightPieces(text: string, ranges: ReadonlyArray<{ start: number; end: number; selected?: boolean }>): HighlightPiece[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.max(0, Math.min(text.length, r.start)), end: Math.max(0, Math.min(text.length, r.end)), selected: r.selected === true }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: HighlightPiece[] = [];
  let at = 0;
  for (const r of sorted) {
    const start = Math.max(at, r.start);
    if (r.end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), mark: null });
    out.push({ text: text.slice(start, r.end), mark: r.selected ? "selected" : "match" });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: null });
  return out.length > 0 ? out : [{ text, mark: null }];
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * A box on a page as the anchor that gets stored: six decimals, inside the page, with the quote
 * only when there is one. Null when it would not pass `validateAnchor` (an empty box, a bad page).
 */
export function anchorFromBox(page: number, box: NormBox, quote?: string): PdfRegionAnchor | null {
  const x0 = round6(clamp01(box.x));
  const y0 = round6(clamp01(box.y));
  const x1 = round6(clamp01(box.x + box.w));
  const y1 = round6(clamp01(box.y + box.h));
  const candidate: Record<string, unknown> = { page, x: x0, y: y0, w: round6(x1 - x0), h: round6(y1 - y0) };
  const trimmed = typeof quote === "string" ? [...quote.trim()].slice(0, ANNOTATION_QUOTE_MAX).join("") : "";
  if (trimmed) candidate.quote = trimmed;
  const check = validateAnchor("pdf_region", candidate);
  return check.ok ? (check.anchor as PdfRegionAnchor) : null;
}

export function boxOfAnchor(anchor: Pick<PdfRegionAnchor, "x" | "y" | "w" | "h">): NormBox {
  return { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h };
}

/** An annotation drawn on a page: its number in the list, where it is, how it looks. */
export type PdfMark = {
  id: string;
  n: number;
  page: number;
  box: NormBox;
  status: "draft" | "open" | "resolved";
  stale: boolean;
  body: string;
};

/**
 * The rows to draw, numbered 1..n in the order given (numbers count every row, drawn or not, so
 * they match the list). A row whose file is gone, or whose page the file no longer has, is left
 * out; a changed file draws the rest dashed.
 */
export function pdfMarks(rows: readonly Annotation[], numPages: number): PdfMark[] {
  const out: PdfMark[] = [];
  rows.forEach((row, i) => {
    if (row.anchor_kind !== "pdf_region") return;
    if (row.stale?.kind === "missing") return;
    const a = row.anchor as PdfRegionAnchor;
    if (!Number.isInteger(a.page) || a.page < 1 || a.page > numPages) return;
    if (![a.x, a.y, a.w, a.h].every((v) => Number.isFinite(v))) return;
    out.push({
      id: row.id,
      n: i + 1,
      page: a.page,
      box: boxOfAnchor(a),
      status: row.status,
      stale: Boolean(row.stale),
      body: row.body,
    });
  });
  return out;
}

/** The corner of a box that a resize handle sits on. */
export function handleCorner(box: NormBox, handle: Handle): NormPoint {
  return {
    x: handle === "nw" || handle === "sw" ? box.x : box.x + box.w,
    y: handle === "nw" || handle === "ne" ? box.y : box.y + box.h,
  };
}

/**
 * Where a dragged corner goes: the pointer, shifted by how far from the corner the handle was
 * grabbed (so the corner does not jump to the pointer on the first move), kept on the page.
 */
export function grabbedPoint(at: NormPoint, grab: NormPoint): NormPoint {
  return { x: clamp01(at.x + grab.x), y: clamp01(at.y + grab.y) };
}

/** Arrow keys move a focused box by 1% of the page; with Shift they grow or shrink it from its far corner. */
export function nudgeBox(box: NormBox, key: string, resize: boolean, step = 0.01): NormBox | null {
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  if (dx === 0 && dy === 0) return null;
  if (resize) {
    const w = Math.min(1 - box.x, Math.max(step, box.w + dx));
    const h = Math.min(1 - box.y, Math.max(step, box.h + dy));
    return { ...box, w, h };
  }
  return { ...box, x: Math.min(Math.max(0, box.x + dx), 1 - box.w), y: Math.min(Math.max(0, box.y + dy), 1 - box.h) };
}
