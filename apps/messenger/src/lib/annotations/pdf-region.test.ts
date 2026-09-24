/**
 * The PDF adapter's pure half: zoom and fits, page layout and the current page, the canvas and
 * render budgets, quotes from text runs (also against real pdf.js geometry), find, and anchors.
 */
import { expect, test } from "bun:test";
import { validateAnchor, type Annotation } from "@real-bot/protocol";
import {
  FIND_MATCH_MAX,
  MAX_ZOOM,
  MIN_ZOOM,
  PAGE_GAP,
  anchorFromBox,
  boxOfAnchor,
  currentPageAt,
  findInText,
  findPattern,
  firstMatchFrom,
  fitBasis,
  grabbedPoint,
  handleCorner,
  fitPageZoom,
  fitWidthZoom,
  highlightPieces,
  linkTargets,
  matchSegments,
  nudgeBox,
  outputScaleFor,
  pageLayout,
  pageTextIndex,
  parsePageNumber,
  parseZoomMenuValue,
  pdfMarks,
  pickEvictions,
  quoteInBox,
  renderOrder,
  resolveZoom,
  scrollTopForPage,
  scrollTopForPoint,
  stepMatch,
  textRunsFromItems,
  zoomIn,
  zoomMenuValue,
  zoomOut,
  zoomPercent,
  type TextRun,
  type ViewportLike,
} from "./pdf-region.ts";
import type { NormBox } from "./region-box.ts";

const letter = { width: 816, height: 1056 }; // 8.5×11 in at 100%

test("fit width and fit page leave the gutters, and every zoom stays within bounds", () => {
  expect(fitWidthZoom(letter, { width: 840, height: 600 })).toBeCloseTo((840 - 2 * PAGE_GAP) / 816);
  expect(fitPageZoom(letter, { width: 840, height: 600 })).toBeCloseTo((600 - 2 * PAGE_GAP) / 1056);
  // A wide pane: the page is the limit, not the width.
  expect(fitPageZoom(letter, { width: 3000, height: 1080 })).toBeCloseTo((1080 - 24) / 1056);
  expect(resolveZoom({ kind: "scale", value: 40 }, letter, { width: 800, height: 600 })).toBe(MAX_ZOOM);
  expect(resolveZoom({ kind: "scale", value: 0.01 }, letter, { width: 800, height: 600 })).toBe(MIN_ZOOM);
  expect(resolveZoom({ kind: "fit-width" }, letter, { width: 0, height: 0 })).toBe(1);
  expect(fitWidthZoom(letter, { width: 10, height: 10 })).toBe(MIN_ZOOM);
  // A landscape page among portrait ones: the fits measure the widest and the tallest.
  expect(fitBasis([letter, { width: 1056, height: 816 }, letter])).toEqual({ width: 1056, height: 1056 });
  expect(fitBasis([])).toBeNull();
});

test("+ and − walk the zoom steps, from wherever the zoom is", () => {
  expect(zoomIn(1)).toBe(1.1);
  expect(zoomOut(1)).toBe(0.9);
  // Between steps (a fit): up goes to the next step, down to the one below.
  expect(zoomIn(0.93)).toBe(1);
  expect(zoomOut(0.93)).toBe(0.9);
  expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
  expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
  expect(zoomPercent(1.25)).toBe("125%");
  expect(zoomPercent(0.934)).toBe("93%");
});

test("the zoom menu round-trips its values", () => {
  expect(zoomMenuValue({ kind: "fit-width" })).toBe("fit-width");
  expect(zoomMenuValue({ kind: "scale", value: 1.5 })).toBe("1.5");
  expect(parseZoomMenuValue("fit-page")).toEqual({ kind: "fit-page" });
  expect(parseZoomMenuValue("2")).toEqual({ kind: "scale", value: 2 });
  expect(parseZoomMenuValue("nope")).toBeNull();
  expect(parseZoomMenuValue("-1")).toBeNull();
});

test("pages stack with a gap, in whole pixels, and a page number box takes only real pages", () => {
  const layout = pageLayout([letter, letter, { width: 1056, height: 816 }], 0.5);
  expect(layout.tops).toEqual([12, 12 + 528 + 12, 12 + 2 * (528 + 12)]);
  expect(layout.widths).toEqual([408, 408, 528]);
  expect(layout.heights).toEqual([528, 528, 408]);
  expect(layout.total).toBe(12 + 528 + 12 + 528 + 12 + 408 + 12);
  // Fractions round down, like pdf.js does for its layers.
  expect(pageLayout([{ width: 612.5, height: 792.9 }], 1).widths).toEqual([612]);
  expect(parsePageNumber(" 3 ", 10)).toBe(3);
  expect(parsePageNumber("99", 10)).toBe(10);
  expect(parsePageNumber("0", 10)).toBe(1);
  expect(parsePageNumber("x", 10)).toBeNull();
});

test("the current page is the one showing most of itself; a jump puts a page at the top", () => {
  const layout = pageLayout([letter, letter, letter, letter], 1); // tops 12, 1080, 2148, 3216
  expect(currentPageAt(layout, 0, 800)).toBe(1);
  // Page 1's last 200px against page 2's first 600px.
  expect(currentPageAt(layout, 1068 - 200, 800)).toBe(2);
  // Halfway through a gap and a tall viewport: the page with more on screen wins.
  expect(currentPageAt(layout, 2000, 2000)).toBe(3);
  expect(currentPageAt(layout, 99999, 800)).toBe(4);
  expect(currentPageAt(pageLayout([], 1), 0, 800)).toBe(1);
  expect(scrollTopForPage(layout, 3)).toBe(2148 - PAGE_GAP);
  expect(scrollTopForPage(layout, 1)).toBe(0);
  expect(scrollTopForPage(layout, 99)).toBe(3216 - PAGE_GAP);
  expect(currentPageAt(layout, scrollTopForPage(layout, 3), 800)).toBe(3);
  // A point halfway down page 2, a third of the way down an 900px viewport.
  expect(scrollTopForPoint(layout, 2, 0.5, 900)).toBe(1080 + 528 - 300);
});

test("a canvas keeps the screen's pixel ratio until it would pass the pixel cap", () => {
  expect(outputScaleFor(800, 1000, 2)).toBe(2);
  const scale = outputScaleFor(4000, 5000, 2);
  expect(4000 * 5000 * scale * scale).toBeLessThanOrEqual(4096 * 4096 + 1);
  expect(scale).toBeLessThan(2);
  expect(outputScaleFor(100, 100, Number.NaN)).toBe(1);
});

test("near pages are drawn outward from the current one; far pages are let go oldest first", () => {
  expect(renderOrder([5, 1, 3, 4, 2], 3)).toEqual([3, 2, 4, 1, 5]);
  const rendered = [
    { page: 1, pixels: 10, lastUsed: 1 },
    { page: 2, pixels: 10, lastUsed: 5 },
    { page: 3, pixels: 10, lastUsed: 3 },
    { page: 4, pixels: 10, lastUsed: 2 },
  ];
  // Too many pages: the least recently used, not near, go first.
  expect(pickEvictions(rendered, new Set([1]), 2, 1000)).toEqual([4, 3]);
  // Too many pixels.
  expect(pickEvictions(rendered, new Set(), 10, 25)).toEqual([1, 4]);
  // Near pages stay even over budget.
  expect(pickEvictions(rendered, new Set([1, 2, 3, 4]), 1, 1)).toEqual([]);
});

const run = (text: string, x: number, y: number, w: number, h = 0.02): TextRun => ({ text, rect: { x, y, w, h } });

test("a quote is the text under the box, in reading order, cut to the characters it covers", () => {
  const runs = [
    run("Second line here", 0.1, 0.14, 0.4),
    run("Title", 0.1, 0.1, 0.1),
    run("of the page", 0.22, 0.1, 0.2),
    run("Footer", 0.1, 0.9, 0.1),
  ];
  // Both lines, whole: titles first, words on a line joined by a space where a gap shows.
  expect(quoteInBox(runs, { x: 0.05, y: 0.09, w: 0.5, h: 0.08 })).toBe("Title of the page\nSecond line here");
  // Half the second line: the first half of its characters.
  expect(quoteInBox(runs, { x: 0.05, y: 0.135, w: 0.25, h: 0.03 })).toBe("Second l");
  // A box grazing the bottom of a line does not quote it.
  expect(quoteInBox(runs, { x: 0.05, y: 0.118, w: 0.5, h: 0.05 })).toBe("Second line here");
  expect(quoteInBox(runs, { x: 0.6, y: 0.5, w: 0.1, h: 0.1 })).toBe("");
});

test("Chinese runs join without spaces, whitespace collapses, and the quote is capped", () => {
  const runs = [run("批注", 0.1, 0.1, 0.04), run("产物", 0.14, 0.1, 0.04), run("  多余   空格  ", 0.1, 0.13, 0.3)];
  expect(quoteInBox(runs, { x: 0, y: 0.09, w: 1, h: 0.08 })).toBe("批注产物\n多余 空格");
  const long = [run("字".repeat(3000), 0, 0.5, 1)];
  expect([...quoteInBox(long, { x: 0, y: 0.49, w: 1, h: 0.05 })]).toHaveLength(2000);
});

/** A two-page PDF: Helvetica text on both pages and a web link on the first. */
function samplePdf(): Uint8Array {
  const page1 = "BT /F1 20 Tf 60 700 Td (Hello world) Tj ET BT /F1 20 Tf 60 660 Td (Second line) Tj ET";
  const page2 = "BT /F1 20 Tf 60 700 Td (Page two text) Tj ET";
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Annot /Subtype /Link /Rect [60 695 200 720] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>",
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
  ]);
}

/** One letter-size page shown turned `rotate`° clockwise (/Rotate), with the two lines of `TWO_LINES`. */
function turnedPdf(rotate: number): Uint8Array {
  const content = TWO_LINES.map((line) => `BT /F1 12 Tf 60 ${line.y} Td (${line.str}) Tj ET`).join(" ");
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

/** A PDF file from its objects, numbered from 1 in the order given. */
function pdfFile(objs: readonly string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function pdfjs() {
  // The modern build, though the app ships the legacy one (see pdfjs.ts): the geometry is the same,
  // and the legacy build's core-js feature probes trip Svelte's dev-time array checks in whatever
  // process has mounted a component. On import it suggests the legacy build for Node, once; keep that
  // out of the test output.
  const warn = console.warn;
  console.warn = () => {};
  const lib = await import("pdfjs-dist").finally(() => (console.warn = warn));
  lib.GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;
  return lib;
}

test("runs and links come out of real pdf.js geometry, and a box over a line quotes it", async () => {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: samplePdf(), useWorkerFetch: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const runs = textRunsFromItems(content.items as never, viewport);
    expect(runs.map((r) => r.text)).toEqual(["Hello world", "Second line"]);
    // "Hello world" sits on the baseline y=700 of an 800pt page: 100pt from the top.
    const hello = runs[0]!.rect;
    expect(hello.x).toBeCloseTo(60 / 600, 3);
    expect(hello.y + hello.h * (0.85 / 1.05)).toBeCloseTo(100 / 800, 2);
    expect(hello.w).toBeCloseTo(98.9 / 600, 2);
    // A box around the first line only, as the viewer would draw it.
    expect(quoteInBox(runs, { x: 0.08, y: 0.09, w: 0.3, h: 0.045 })).toBe("Hello world");
    expect(quoteInBox(runs, { x: 0.08, y: 0.09, w: 0.3, h: 0.1 })).toBe("Hello world\nSecond line");
    const links = linkTargets((await page.getAnnotations({ intent: "display" })) as never, viewport);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://example.com/");
    expect(links[0]!.rect.x).toBeCloseTo(0.1, 5);
    expect(links[0]!.rect.y).toBeCloseTo(80 / 800, 5);
    expect(links[0]!.rect.h).toBeCloseTo(25 / 800, 5);
  } finally {
    await task.destroy();
  }
}, 20000);

test("rotated pages map runs to their on-screen place", () => {
  // A 90° viewport of a 600×800 page: 800 wide, 600 tall. PDF (x, y) → (y, x) on screen.
  const viewport = { width: 800, height: 600, convertToViewportPoint: (x: number, y: number) => [y, x] };
  const [only] = textRunsFromItems([{ str: "Up", transform: [10, 0, 0, 10, 100, 200], width: 30, height: 10, hasEOL: false }], viewport);
  expect(only!.rect.x).toBeCloseTo((200 - 2) / 800);
  expect(only!.rect.y).toBeCloseTo(100 / 600);
  expect(only!.rect.h).toBeCloseTo(30 / 600);
  // Its line now runs down the screen.
  expect(only!.angle).toBe(90);
});

/** Two lines of 12pt Helvetica at x=60 on a letter page, the second under the first; widths from Helvetica's metrics. */
const TWO_LINES = [
  { str: "Hello brave new world", y: 700, width: 118.032 },
  { str: "Second line of text!!", y: 685, width: 105.396 },
];

/** pdf.js's `PageViewport` at 100% (pdf.mjs, PageViewport's constructor) for a page shown turned `rotate`° clockwise. */
function turnedViewport(width: number, height: number, rotate: 0 | 90 | 180 | 270): ViewportLike {
  const [a, b, c, d] = rotate === 90 ? [0, 1, 1, 0] : rotate === 180 ? [-1, 0, 0, 1] : rotate === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const sideways = a === 0;
  const e = (sideways ? height : width) / 2 - (a * width) / 2 - (c * height) / 2;
  const f = (sideways ? width : height) / 2 - (b * width) / 2 - (d * height) / 2;
  return {
    width: sideways ? height : width,
    height: sideways ? width : height,
    convertToViewportPoint: (x, y) => [a * x + c * y + e, b * x + d * y + f],
  };
}

/** A box given in PDF points, where it lands on screen, normalized to the page: what the viewer's box would be. */
function screenBox(viewport: ViewportLike, x0: number, y0: number, x1: number, y1: number): NormBox {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => viewport.convertToViewportPoint(x!, y!));
  const xs = corners.map((p) => p[0]! / viewport.width);
  const ys = corners.map((p) => p[1]! / viewport.height);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

test("however the page is turned, a box quotes the characters under it, line by line", () => {
  for (const rotate of [0, 90, 180, 270] as const) {
    const viewport = turnedViewport(612, 792, rotate);
    const items = TWO_LINES.map((line) => ({ str: line.str, transform: [12, 0, 0, 12, 60, line.y], width: line.width, height: 12 }));
    const runs = textRunsFromItems(items, viewport);
    expect(runs.map((r) => r.angle)).toEqual([rotate, rotate]);
    // The start of both lines — at 90° the top of two columns, the right-hand one first — not both
    // whole runs run together.
    expect(quoteInBox(runs, screenBox(viewport, 55, 680, 90, 715))).toBe("Hello\nSecond");
    // The end of the first line alone; the second only grazes the box.
    expect(quoteInBox(runs, screenBox(viewport, 150, 695, 190, 715))).toBe("world");
  }
});

test("real pdf.js on pages with /Rotate 90 and 270: runs read down and up the screen, and quotes follow them", async () => {
  const lib = await pdfjs();
  for (const rotate of [90, 270] as const) {
    const task = lib.getDocument({ data: turnedPdf(rotate), useWorkerFetch: false, verbosity: 0 });
    try {
      const page = await (await task.promise).getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      expect([viewport.width, viewport.height]).toEqual([792, 612]);
      const runs = textRunsFromItems((await page.getTextContent()).items as never, viewport);
      expect(runs.map((r) => [r.text, r.angle])).toEqual(TWO_LINES.map((line) => [line.str, rotate]));
      expect(runs[0]!.rect.h).toBeCloseTo(TWO_LINES[0]!.width / 612, 2);
      expect(quoteInBox(runs, screenBox(viewport, 55, 680, 90, 715))).toBe("Hello\nSecond");
      expect(quoteInBox(runs, screenBox(viewport, 150, 695, 190, 715))).toBe("world");
    } finally {
      await task.destroy();
    }
  }
}, 20000);

test("a slanted run is quoted whole and only when the box covers most of it; a slight lean still cuts", () => {
  const viewport = turnedViewport(612, 792, 0);
  const s = 12 * Math.SQRT1_2;
  const lean = 0.05; // about 3°
  const [slanted, leaning] = textRunsFromItems(
    [
      { str: "Draft copy", transform: [s, s, -s, s, 200, 300], width: 100, height: 12 },
      { str: "Leaning line", transform: [12 * Math.cos(lean), 12 * Math.sin(lean), -12 * Math.sin(lean), 12 * Math.cos(lean), 60, 700], width: 80, height: 12 },
    ],
    viewport,
  );
  expect(slanted!.angle).toBeNull();
  // A corner of its box: which letters sit there is not known, so none are guessed.
  expect(quoteInBox([slanted!], screenBox(viewport, 185, 290, 230, 335))).toBe("");
  expect(quoteInBox([slanted!], screenBox(viewport, 185, 290, 260, 385))).toBe("Draft copy");
  expect(leaning!.angle).toBe(0);
  expect(quoteInBox([leaning!], screenBox(viewport, 55, 690, 105, 720))).toBe("Leaning");
});

test("text reading different ways is quoted one way at a time, in the order the runs come", () => {
  const runs: TextRun[] = [
    run("Body text here", 0.2, 0.1, 0.4),
    { text: "SIDEBAR", rect: { x: 0.1, y: 0.05, w: 0.02, h: 0.2 }, angle: 270 },
    run("More body", 0.2, 0.13, 0.3),
  ];
  expect(quoteInBox(runs, { x: 0.05, y: 0.04, w: 0.6, h: 0.22 })).toBe("Body text here\nMore body\nSIDEBAR");
});

test("one run per text item, in order, even for an item that cannot be placed", () => {
  const viewport = { width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, 100 - y] };
  const runs = textRunsFromItems(
    [
      { str: "first", transform: [10, 0, 0, 10, 10, 80], width: 30, height: 10 },
      { str: "nowhere", transform: [Number.NaN, 0, 0, 10, 10, 60], width: 30, height: 10 },
      { str: "third", transform: [10, 0, 0, 10, 10, 40], width: 30, height: 10, hasEOL: true },
    ],
    viewport,
  );
  // Find maps a match's item index straight into this list.
  expect(runs.map((r) => r.text)).toEqual(["first", "nowhere", "third"]);
  expect(runs[1]!.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  expect(runs[2]!.eol).toBe(true);
  // The empty box is never quoted.
  expect(quoteInBox(runs, { x: 0, y: 0, w: 1, h: 1 })).toBe("first\nthird");
});

test("a resize handle's corner, and the pointer shifted by where the handle was grabbed", () => {
  const box = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };
  expect(handleCorner(box, "nw")).toEqual({ x: 0.2, y: 0.3 });
  expect(handleCorner(box, "ne")).toEqual({ x: 0.6000000000000001, y: 0.3 });
  expect(handleCorner(box, "sw")).toEqual({ x: 0.2, y: 0.5 });
  expect(handleCorner(box, "se").y).toBeCloseTo(0.5);
  expect(grabbedPoint({ x: 0.5, y: 0.5 }, { x: -0.01, y: 0.02 })).toEqual({ x: 0.49, y: 0.52 });
  // Kept on the page.
  expect(grabbedPoint({ x: 0.995, y: 0.001 }, { x: 0.01, y: -0.01 })).toEqual({ x: 1, y: 0 });
});

test("links only keep web, mail and in-document targets", () => {
  const viewport = { width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, 100 - y] };
  const found = linkTargets(
    [
      { subtype: "Link", rect: [10, 80, 30, 90], url: "https://a.example/" },
      { subtype: "Link", rect: [10, 60, 30, 70], url: "javascript:alert(1)" },
      { subtype: "Link", rect: [10, 40, 30, 50], dest: "chapter-2" },
      { subtype: "Widget", rect: [0, 0, 10, 10] },
      { subtype: "Link", rect: [10, 20, 10, 30], url: "https://empty.example/" },
    ],
    viewport,
  );
  expect(found.map((l) => l.url ?? l.dest)).toEqual(["https://a.example/", "chapter-2"]);
  const rect = found[0]!.rect;
  expect([rect.x, rect.y, rect.w, rect.h].map((v) => Number(v.toFixed(9)))).toEqual([0.1, 0.1, 0.2, 0.1]);
});

test("find joins a page's runs, takes any case and flexible spaces, and maps matches back to runs", () => {
  const index = pageTextIndex([
    { str: "Annual Re", eol: false },
    { str: "port 2026", eol: true },
    { str: "(c) report", eol: false },
  ]);
  expect(index.text).toBe("Annual Report 2026\n(c) report");
  const matches = findInText(index.text, findPattern("report"));
  expect(matches).toEqual([
    { start: 7, end: 13 },
    { start: 23, end: 29 },
  ]);
  // A match across two runs covers the end of one and the start of the next.
  expect(matchSegments(index, matches[0]!)).toEqual([
    { item: 0, start: 7, end: 9 },
    { item: 1, start: 0, end: 4 },
  ]);
  // Spaces in the query match a line break, or nothing where the PDF drew no space.
  expect(findInText(index.text, findPattern("2026 (c)"))).toEqual([{ start: 14, end: 22 }]);
  expect(findInText("AnnualReport", findPattern("annual report"))).toEqual([{ start: 0, end: 12 }]);
  // Regex characters are literal.
  expect(findInText("a+b (x) a.b", findPattern("(x)"))).toEqual([{ start: 4, end: 7 }]);
  expect(findPattern("   ")).toBeNull();
  expect(findInText("aaaa", findPattern("a"), 2)).toHaveLength(2);
  expect(FIND_MATCH_MAX).toBeGreaterThan(100);
});

test("next and previous wrap around, and find starts at the page on screen", () => {
  expect(stepMatch(-1, 3, 1)).toBe(0);
  expect(stepMatch(-1, 3, -1)).toBe(2);
  expect(stepMatch(2, 3, 1)).toBe(0);
  expect(stepMatch(0, 3, -1)).toBe(2);
  expect(stepMatch(0, 0, 1)).toBe(-1);
  const matches = [
    { page: 1, start: 0, end: 1 },
    { page: 4, start: 0, end: 1 },
    { page: 9, start: 0, end: 1 },
  ];
  expect(firstMatchFrom(matches, 3)).toBe(1);
  expect(firstMatchFrom(matches, 10)).toBe(0);
  expect(firstMatchFrom([], 1)).toBe(-1);
});

test("a run is cut into plain and highlighted pieces", () => {
  expect(highlightPieces("Hello world", [{ start: 6, end: 11, selected: true }, { start: 0, end: 2 }])).toEqual([
    { text: "He", mark: "match" },
    { text: "llo ", mark: null },
    { text: "world", mark: "selected" },
  ]);
  expect(highlightPieces("abc", [])).toEqual([{ text: "abc", mark: null }]);
  expect(highlightPieces("", [])).toEqual([{ text: "", mark: null }]);
  // Overlaps do not repeat text.
  expect(highlightPieces("abcdef", [{ start: 0, end: 4 }, { start: 2, end: 6 }]).map((p) => p.text).join("")).toBe("abcdef");
});

test("an anchor from a box passes validation, stays on the page, and keeps a quote only when there is one", () => {
  const anchor = anchorFromBox(2, { x: 0.1234567891, y: 0.2, w: 0.3, h: 0.1 }, "  Hello  ");
  expect(anchor).toEqual({ page: 2, x: 0.123457, y: 0.2, w: 0.3, h: 0.1, quote: "Hello" });
  expect(validateAnchor("pdf_region", anchor).ok).toBe(true);
  // A box against the far edge, where rounding could push x + w past 1.
  const edge = anchorFromBox(1, { x: 0.6666666666, y: 0.3333333333, w: 0.3333333334, h: 0.6666666667 });
  expect(edge).not.toBeNull();
  expect(edge!.x + edge!.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(edge!.y + edge!.h).toBeLessThanOrEqual(1 + 1e-9);
  expect(validateAnchor("pdf_region", edge).ok).toBe(true);
  expect("quote" in edge!).toBe(false);
  expect(anchorFromBox(1, { x: 0.5, y: 0.5, w: 0, h: 0 })).toBeNull();
  expect(anchorFromBox(0, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 })).toBeNull();
  expect([...anchorFromBox(1, { x: 0, y: 0, w: 1, h: 1 }, "x".repeat(2500))!.quote!]).toHaveLength(2000);
  expect(boxOfAnchor(anchor!)).toEqual({ x: 0.123457, y: 0.2, w: 0.3, h: 0.1 });
});

function row(over: Partial<Annotation> & { anchor?: unknown }): Annotation {
  return {
    id: "a",
    status: "open",
    relpath: "report.pdf",
    anchor_kind: "pdf_region",
    anchor: { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "b1",
    session_id: "s1",
    message_id: "m2",
    body: "这里",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  } as Annotation;
}

test("marks are numbered in the given order; gone files and gone pages are not drawn", () => {
  const marks = pdfMarks(
    [
      row({ id: "a" }),
      row({ id: "gone", stale: { kind: "missing" } }),
      row({ id: "p9", anchor: { page: 9, x: 0, y: 0, w: 0.1, h: 0.1 } }),
      row({ id: "changed", status: "draft", stale: { kind: "changed" }, anchor: { page: 2, x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }),
      row({ id: "text", anchor_kind: "text_range" }),
    ],
    3,
  );
  expect(marks.map((m) => [m.id, m.n, m.page, m.status, m.stale])).toEqual([
    ["a", 1, 1, "open", false],
    ["changed", 4, 2, "draft", true],
  ]);
});

test("arrow keys nudge a box by 1%, and grow it with Shift, inside the page", () => {
  const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  expect(nudgeBox(box, "ArrowLeft", false)).toEqual({ x: 0.49, y: 0.5, w: 0.2, h: 0.2 });
  expect(nudgeBox({ ...box, x: 0.8 }, "ArrowRight", false)!.x).toBeCloseTo(0.8);
  expect(nudgeBox(box, "ArrowDown", true)!.h).toBeCloseTo(0.21);
  expect(nudgeBox({ ...box, w: 0.01 }, "ArrowLeft", true)!.w).toBe(0.01);
  expect(nudgeBox(box, "Enter", false)).toBeNull();
});
