/**
 * Image regions without a browser: a gesture on screen becomes the same anchor at any displayed
 * size, marks are numbered and filtered, an SVG gets a natural size even when it declares none,
 * and the crop is planned, drawn and encoded through a fake canvas (happy-dom has no 2D context).
 */
import { expect, test } from "bun:test";
import { describeAnchor, validateAnchor, type Annotation, type ImageRegionAnchor } from "@real-bot/protocol";
import {
  anchorFromBox,
  anchorFromDrag,
  cropImageRegion,
  cropPlan,
  domImageLoader,
  handleCorner,
  isCompactBox,
  markClass,
  regionMarks,
  resizeByGrab,
  resolveNaturalSize,
  svgMetrics,
  svgRenderSize,
  thickenSliver,
  toNormFree,
  type CanvasFactory,
  type ImageLoader,
} from "./image-region.ts";
import { moveBox, type Handle, type Size } from "./region-box.ts";

type DrawCall = { size: Size; args: number[]; image: unknown };

/** A canvas that records what was drawn and encodes to a blob of a chosen size. */
function fakeCanvas(opts: { pngBytes?: number; jpegBytes?: number; throwOnDraw?: boolean; throwOnEncode?: boolean } = {}) {
  const calls: DrawCall[] = [];
  const types: string[] = [];
  const factory: CanvasFactory = (size) => ({
    ctx: {
      drawImage(image: CanvasImageSource, ...args: number[]) {
        if (opts.throwOnDraw) throw new Error("tainted");
        calls.push({ size, args, image });
      },
    },
    encoder: {
      async toBlob(type: string) {
        if (opts.throwOnEncode) throw new DOMException("The canvas has been tainted", "SecurityError");
        types.push(type);
        const bytes = type === "image/png" ? (opts.pngBytes ?? 3) : (opts.jpegBytes ?? 2);
        return new Blob([new Uint8Array(bytes)], { type });
      },
    },
  });
  return { factory, calls, types };
}

/** An <img> as happy-dom makes it, told it has loaded at this size. */
function loadedImg(width: number, height: number): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  return img;
}

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "out/chart.png",
    anchor_kind: "image_region",
    anchor: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, natural_width: 1000, natural_height: 500 },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "图例挡住了曲线",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

const valid = (anchor: ImageRegionAnchor) => validateAnchor("image_region", anchor).ok;

test("the same drag gives the same anchor however large the image is drawn", () => {
  const natural = { width: 2000, height: 1000 };
  // Drawn at full width in a wide pane, 100px in and 40px down.
  const big = { left: 100, top: 40, width: 1000, height: 500 };
  const a = anchorFromDrag({ x: 100 + 200, y: 40 + 100 }, { x: 100 + 600, y: 40 + 350 }, big, natural);
  expect(a).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 });
  // The same spot on a phone, where the image is drawn at 300×150.
  const small = { left: 16, top: 70, width: 300, height: 150 };
  const b = anchorFromDrag({ x: 16 + 60, y: 70 + 30 }, { x: 16 + 180, y: 70 + 105 }, small, natural);
  expect(b).toEqual(a);
  expect(valid(a)).toBe(true);
  // Dragging up and left gives the same box.
  expect(anchorFromDrag({ x: 700, y: 390 }, { x: 300, y: 140 }, big, natural)).toEqual(a);
  expect(describeAnchor("image_region", a, "zh")).toBe("x 20%–60%，y 20%–70%（原图 2000×1000，像素 400,200 → 1,200,700）");
});

test("a drag that runs off the image stops at its edge", () => {
  const drawn = { left: 0, top: 0, width: 400, height: 300 };
  const a = anchorFromDrag({ x: 200, y: 150 }, { x: 900, y: -80 }, drawn, { width: 800, height: 600 });
  expect(a).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5, natural_width: 800, natural_height: 600 });
  expect(valid(a)).toBe(true);
});

test("a click is a small square on landscape and portrait images alike", () => {
  const land = anchorFromDrag({ x: 250, y: 125 }, { x: 251, y: 126 }, { left: 0, top: 0, width: 500, height: 250 }, { width: 4000, height: 2000 });
  // 4% of the short side (2000) is 80px: 0.02 of the width, 0.04 of the height.
  expect(land.w).toBeCloseTo(0.02, 6);
  expect(land.h).toBeCloseTo(0.04, 6);
  expect(land.x + land.w / 2).toBeCloseTo(0.5, 6);
  const port = anchorFromDrag({ x: 125, y: 250 }, { x: 125, y: 250 }, { left: 0, top: 0, width: 250, height: 500 }, { width: 2000, height: 4000 });
  expect(port.w).toBeCloseTo(0.04, 6);
  expect(port.h).toBeCloseTo(0.02, 6);
  // In the bottom-right corner it is nudged in, not cut off.
  const corner = anchorFromDrag({ x: 500, y: 250 }, { x: 500, y: 250 }, { left: 0, top: 0, width: 500, height: 250 }, { width: 4000, height: 2000 });
  expect(corner.x + corner.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(corner.y + corner.h).toBeLessThanOrEqual(1 + 1e-9);
  for (const a of [land, port, corner]) expect(valid(a)).toBe(true);
});

test("a drag straight across becomes a band as thick as a click box", () => {
  const a = anchorFromDrag({ x: 100, y: 100 }, { x: 300, y: 100 }, { left: 0, top: 0, width: 400, height: 400 }, { width: 1000, height: 1000 });
  expect(a.w).toBeCloseTo(0.5, 6);
  expect(a.h).toBeCloseTo(0.04, 6);
  expect(valid(a)).toBe(true);
  expect(thickenSliver({ x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, { width: 10, height: 10 })).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.3 });
});

test("anchors stay inside the image after rounding and carry a whole-pixel natural size", () => {
  const a = anchorFromBox({ x: 0.1234567891, y: 0.9, w: 0.8765432109, h: 0.2 }, { width: 640.4, height: 0.2 });
  expect(a.x).toBe(0.123457);
  expect(a.x + a.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(a.y + a.h).toBeLessThanOrEqual(1 + 1e-9);
  expect(a.natural_width).toBe(640);
  expect(a.natural_height).toBe(1);
  expect(valid(a)).toBe(true);
});

test("marks are numbered in the given order; a gone file keeps its number but is not drawn", () => {
  const marks = regionMarks([
    row({ id: "o" }),
    row({ id: "d", status: "draft", message_id: null }),
    row({ id: "gone", stale: { kind: "missing" } }),
    row({ id: "r", status: "resolved", stale: { kind: "changed" } }),
    row({ id: "bad", anchor: { x: 2, y: 0, w: 0.1, h: 0.1, natural_width: 10, natural_height: 10 } }),
    row({ id: "text", anchor_kind: "text_range" }),
  ]);
  expect(marks.map((m) => [m.id, m.n, m.status, m.stale])).toEqual([
    ["o", 1, "open", false],
    ["d", 2, "draft", false],
    ["r", 4, "resolved", true],
  ]);
  expect(marks[0]!.box).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  expect(markClass(marks[0]!)).toBe("img-annot-mark is-open");
  expect(markClass(marks[2]!)).toBe("img-annot-mark is-resolved is-stale");
});

test("an SVG's size comes from its root tag: width and height, one of them and the viewBox, or the viewBox", () => {
  expect(svgMetrics('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect stroke-width="3"/></svg>')).toEqual({
    size: { width: 640, height: 480 },
    viewBox: null,
  });
  expect(svgMetrics("<svg width='2in' height=\"1in\" viewBox=\"0 0 20 10\">").size).toEqual({ width: 192, height: 96 });
  expect(svgMetrics('<svg width="300" viewBox="0,0,30,10">').size).toEqual({ width: 300, height: 100 });
  expect(svgMetrics('<svg width="100%" height="100%" viewBox="0 0 24 24">')).toEqual({ size: null, viewBox: { width: 24, height: 24 } });
  expect(svgMetrics("<svg>")).toEqual({ size: null, viewBox: null });
  // A comment ahead of the root is not the root.
  expect(svgMetrics('<!-- exported from <svg width="1" height="1"> --><svg viewBox="0 0 300 100">')).toEqual({ size: null, viewBox: { width: 300, height: 100 } });
  expect(svgMetrics("not an svg")).toEqual({ size: null, viewBox: null });
});

test("the natural size of an SVG without one falls back to its viewBox, then to 1024", () => {
  // A raster image: its pixels, or nothing before it loads.
  expect(resolveNaturalSize({ naturalWidth: 1600, naturalHeight: 900 })).toEqual({ width: 1600, height: 900 });
  expect(resolveNaturalSize({ naturalWidth: 0, naturalHeight: 0 })).toBeNull();
  // A viewBox-only SVG, whatever made-up size the browser reports.
  const viewBoxOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><path d="M0 0"/></svg>';
  expect(resolveNaturalSize({ naturalWidth: 300, naturalHeight: 150 }, { svg: true, svgText: viewBoxOnly })).toEqual({ width: 800, height: 200 });
  expect(resolveNaturalSize({ naturalWidth: 0, naturalHeight: 0 }, { svg: true, svgText: '<svg viewBox="0 0 12.4 6.6">' })).toEqual({ width: 12, height: 7 });
  // Without the source: the browser's size when it has the drawn shape…
  expect(resolveNaturalSize({ naturalWidth: 640, naturalHeight: 480 }, { svg: true, drawn: { width: 320, height: 240 } })).toEqual({ width: 640, height: 480 });
  // …else 1024 on the long side in the drawn shape, else a 1024 square.
  expect(resolveNaturalSize({ naturalWidth: 300, naturalHeight: 150 }, { svg: true, drawn: { width: 400, height: 400 } })).toEqual({ width: 1024, height: 1024 });
  expect(resolveNaturalSize({ naturalWidth: 0, naturalHeight: 0 }, { svg: true, drawn: { width: 500, height: 250 } })).toEqual({ width: 1024, height: 512 });
  expect(resolveNaturalSize({ naturalWidth: 0, naturalHeight: 0 }, { svg: true })).toEqual({ width: 1024, height: 1024 });
  expect(resolveNaturalSize({ naturalWidth: 0, naturalHeight: 0 }, { svg: true, svgText: "<svg>" })).toEqual({ width: 1024, height: 1024 });
});

test("a crop at the image's edge keeps the margin only where there is image", async () => {
  const canvas = fakeCanvas();
  const img = loadedImg(1000, 800);
  const anchor: ImageRegionAnchor = { x: 0, y: 0.9, w: 0.1, h: 0.1, natural_width: 1000, natural_height: 800 };
  const crop = await cropImageRegion(img, anchor, { canvas: canvas.factory });
  expect(crop).toEqual({ mime: "image/png", base64: "AAAA" });
  // 10% of 100×80 is 10×8: none past the left or bottom edge.
  expect(canvas.calls).toHaveLength(1);
  expect(canvas.calls[0]!.image).toBe(img);
  expect(canvas.calls[0]!.size).toEqual({ width: 110, height: 88 });
  expect(canvas.calls[0]!.args).toEqual([0, 712, 110, 88, 0, 0, 110, 88]);
  expect(canvas.types).toEqual(["image/png"]);
});

test("a crop of a huge image is drawn at 1024 on its long side and falls back to JPEG past 1 MB", async () => {
  const canvas = fakeCanvas({ pngBytes: 3_000_000, jpegBytes: 400_000 });
  const img = loadedImg(12000, 9000);
  const whole: ImageRegionAnchor = { x: 0, y: 0, w: 1, h: 1, natural_width: 12000, natural_height: 9000 };
  const crop = await cropImageRegion(img, whole, { canvas: canvas.factory });
  expect(crop?.mime).toBe("image/jpeg");
  expect(canvas.calls[0]!.size).toEqual({ width: 1024, height: 768 });
  expect(canvas.calls[0]!.args).toEqual([0, 0, 12000, 9000, 0, 0, 1024, 768]);
  expect(canvas.types).toEqual(["image/png", "image/jpeg"]);
});

test("a raster crop cuts from the loaded image's own pixels, and a blob is decoded once, not fetched", async () => {
  const plan = cropPlan({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, natural_width: 100, natural_height: 100 }, { width: 2000, height: 2000 }, false);
  expect(plan).toEqual({ kind: "raster", rect: { sx: 400, sy: 400, sw: 1200, sh: 1200 }, out: { width: 1024, height: 1024 } });
  const canvas = fakeCanvas();
  const frame = { naturalWidth: 400, naturalHeight: 200 } as unknown as HTMLImageElement;
  const seen: Array<{ type: string; svg: boolean }> = [];
  let released = 0;
  const loader: ImageLoader = async (blob, { svg }) => {
    seen.push({ type: blob.type, svg });
    return { image: frame, release: () => (released += 1) };
  };
  const gif = new Blob([new Uint8Array(4)], { type: "image/gif" });
  const crop = await cropImageRegion(gif, { x: 0.5, y: 0, w: 0.5, h: 0.5, natural_width: 400, natural_height: 200 }, { canvas: canvas.factory, loadImage: loader });
  expect(crop?.mime).toBe("image/png");
  expect(seen).toEqual([{ type: "image/gif", svg: false }]);
  expect(released).toBe(1);
  expect(canvas.calls[0]!.args).toEqual([180, 0, 220, 110, 0, 0, 220, 110]);
});

test("an SVG is rasterized at the crop's own scale from its natural size, so small ones stay sharp", async () => {
  expect(svgRenderSize({ width: 24, height: 12 })).toEqual({ width: 2048, height: 1024 });
  expect(svgRenderSize({ width: 4000, height: 3000 })).toEqual({ width: 4000, height: 3000 });
  const canvas = fakeCanvas();
  const svgImage = { naturalWidth: 300, naturalHeight: 150 } as unknown as HTMLImageElement;
  let released = 0;
  const loader: ImageLoader = async (_blob, { svg }) => {
    expect(svg).toBe(true);
    return { image: svgImage, release: () => (released += 1) };
  };
  const blob = new Blob(['<svg viewBox="0 0 24 12"/>'], { type: "image/svg+xml" });
  // The right half of a 24×12 icon: drawn as if 2048×1024, the crop is 1024 wide at most.
  const anchor: ImageRegionAnchor = { x: 0.5, y: 0, w: 0.5, h: 1, natural_width: 24, natural_height: 12 };
  const crop = await cropImageRegion(blob, anchor, { canvas: canvas.factory, loadImage: loader });
  expect(crop?.mime).toBe("image/png");
  expect(released).toBe(1);
  const plan = cropPlan(anchor, { width: 24, height: 12 }, true);
  // 10% margin on a 1024-wide half: from x 921.6 (floored) to the right edge; all of the height.
  expect(plan).toEqual({ kind: "svg", rect: { sx: 921, sy: 0, sw: 1127, sh: 1024 }, render: { width: 2048, height: 1024 }, out: { width: 1024, height: 930 } });
  const [dx, dy, dw, dh] = canvas.calls[0]!.args;
  const kx = 1024 / 1127;
  const ky = 930 / 1024;
  expect(canvas.calls[0]!.size).toEqual({ width: 1024, height: 930 });
  expect(canvas.calls[0]!.image).toBe(svgImage);
  expect(dx).toBeCloseTo(-921 * kx, 6);
  expect(dy).toBeCloseTo(0, 6);
  expect(dw).toBeCloseTo(2048 * kx, 6);
  expect(dh).toBeCloseTo(1024 * ky, 6);
  // The on-screen <img> of an SVG works the same way, sized by the anchor, not by what it reports.
  const onScreen = fakeCanvas();
  const img = loadedImg(0, 0);
  expect(await cropImageRegion(img, anchor, { svg: true, canvas: onScreen.factory })).not.toBeNull();
  expect(onScreen.calls[0]!.size).toEqual({ width: 1024, height: 930 });
});

test("no crop when the browser cannot decode, draw, or export it", async () => {
  const anchor: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 100, natural_height: 100 };
  const img = loadedImg(100, 100);
  // happy-dom's own canvas has no 2D context: the default path gives up quietly.
  expect(await cropImageRegion(img, anchor)).toBeNull();
  expect(await cropImageRegion(img, anchor, { canvas: () => null })).toBeNull();
  expect(await cropImageRegion(img, anchor, { canvas: fakeCanvas({ throwOnDraw: true }).factory })).toBeNull();
  expect(await cropImageRegion(img, anchor, { canvas: fakeCanvas({ throwOnEncode: true }).factory })).toBeNull();
  // A raster that never loaded.
  expect(await cropImageRegion(loadedImg(0, 0), anchor, { canvas: fakeCanvas().factory })).toBeNull();
  // A blob that will not decode.
  let released = 0;
  expect(await cropImageRegion(new Blob([], { type: "image/png" }), anchor, { canvas: fakeCanvas().factory, loadImage: async () => null })).toBeNull();
  const failing: ImageLoader = async () => ({ image: {} as HTMLImageElement, release: () => (released += 1) });
  expect(await cropImageRegion(new Blob([], { type: "image/png" }), anchor, { canvas: fakeCanvas().factory, loadImage: failing })).toBeNull();
  expect(released).toBe(1);
});

test("every anchor a drag, a move or a resize can make passes validateAnchor, on any image", () => {
  // A small deterministic generator: the same thousands of gestures on every run.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sizes: Size[] = [
    { width: 1, height: 1 },
    { width: 3, height: 2000 },
    { width: 2000, height: 3 },
    { width: 4000, height: 3000 },
    { width: 640.4, height: 479.6 },
    { width: 99999, height: 7 },
  ];
  const handles: Handle[] = ["nw", "ne", "sw", "se"];
  const failures: unknown[] = [];
  for (let i = 0; i < 3000; i += 1) {
    const natural = sizes[i % sizes.length]!;
    const drawn = { left: rnd() * 100, top: rnd() * 100, width: 1 + rnd() * 900, height: 1 + rnd() * 900 };
    // Points up to 20% past every edge: drags that leave the image.
    const point = () => ({ x: drawn.left + (rnd() * 1.4 - 0.2) * drawn.width, y: drawn.top + (rnd() * 1.4 - 0.2) * drawn.height });
    const drag = anchorFromDrag(point(), point(), drawn, natural);
    const box = { x: drag.x, y: drag.y, w: drag.w, h: drag.h };
    const handle = handles[i % 4]!;
    const grab = { x: rnd() * 0.1 - 0.05, y: rnd() * 0.1 - 0.05 };
    const resized = anchorFromBox(thickenSliver(resizeByGrab(box, handle, toNormFree(point().x, point().y, drawn), grab), natural), natural);
    const moved = anchorFromBox(thickenSliver(moveBox(box, rnd() * 2 - 1, rnd() * 2 - 1), natural), natural);
    for (const anchor of [drag, resized, moved]) {
      const check = validateAnchor("image_region", anchor);
      if (!check.ok) failures.push({ anchor, reason: check.reason });
    }
  }
  expect(failures).toEqual([]);
});

test("a handle resizes from where it was grabbed; the pointer may run past the edge", () => {
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  expect(handleCorner(box, "nw")).toEqual({ x: 0.2, y: 0.2 });
  expect(handleCorner(box, "se")).toEqual({ x: 0.6000000000000001, y: 0.6000000000000001 });
  expect(handleCorner(box, "ne")).toEqual({ x: 0.6000000000000001, y: 0.2 });
  // Unclamped, so a handle grabbed 5% inside its corner can still bring the corner to the edge.
  expect(toNormFree(600, -50, { left: 100, top: 0, width: 400, height: 200 })).toEqual({ x: 1.25, y: -0.25 });
  const grown = resizeByGrab(box, "se", { x: 0.95, y: 1.2 }, { x: 0.05, y: 0.05 });
  expect(grown.x).toBeCloseTo(0.2, 9);
  expect(grown.x + grown.w).toBeCloseTo(1, 9);
  expect(grown.y + grown.h).toBeCloseTo(1, 9);
  // Where it was grabbed is where it resizes from: no move, no change.
  const still = resizeByGrab(box, "nw", { x: 0.25, y: 0.23 }, { x: -0.05, y: -0.03 });
  expect(still.x).toBeCloseTo(0.2, 9);
  expect(still.w).toBeCloseTo(0.4, 9);
  // Small on screen means one handle.
  expect(isCompactBox({ x: 0, y: 0, w: 0.02, h: 0.04 }, { width: 400, height: 200 })).toBe(true);
  expect(isCompactBox({ x: 0, y: 0, w: 0.3, h: 0.4 }, { width: 400, height: 200 })).toBe(false);
  // The same box on a wide screen is not small.
  expect(isCompactBox({ x: 0, y: 0, w: 0.1, h: 0.1 }, { width: 400, height: 400 })).toBe(true);
  expect(isCompactBox({ x: 0, y: 0, w: 0.1, h: 0.1 }, { width: 1400, height: 1400 })).toBe(false);
});

test("the default decoder hands back its object URL: revoked on release, and on a failed decode", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { Image: g.Image, createImageBitmap: g.createImageBitmap, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const created: string[] = [];
  const revoked: string[] = [];
  let fail = false;
  let closed = 0;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_url: string) {
      queueMicrotask(() => {
        if (fail) return this.onerror?.();
        this.naturalWidth = 24;
        this.naturalHeight = 12;
        this.onload?.();
      });
    }
  }
  try {
    g.Image = FakeImage;
    URL.createObjectURL = () => {
      const url = `blob:fake/${created.length}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    // A raster the bitmap decoder refuses falls back to an <img>, which also fails: URL revoked.
    g.createImageBitmap = async () => {
      throw new Error("unsupported");
    };
    fail = true;
    expect(await domImageLoader(new Blob([], { type: "image/png" }), { svg: false })).toBeNull();
    expect(created).toEqual(["blob:fake/0"]);
    expect(revoked).toEqual(["blob:fake/0"]);
    // An SVG always goes through an <img>; its URL lives until the crop releases it.
    fail = false;
    const svg = await domImageLoader(new Blob(["<svg/>"], { type: "image/svg+xml" }), { svg: true });
    expect(svg?.image.naturalWidth).toBe(24);
    expect(revoked).toEqual(["blob:fake/0"]);
    svg!.release();
    expect(revoked).toEqual(["blob:fake/0", "blob:fake/1"]);
    // A raster that decodes as a bitmap makes no URL at all, and is closed on release.
    g.createImageBitmap = async () => ({ width: 40, height: 20, close: () => (closed += 1) });
    const raster = await domImageLoader(new Blob([], { type: "image/gif" }), { svg: false });
    expect(raster?.image.naturalWidth).toBe(40);
    raster!.release();
    expect(closed).toBe(1);
    expect(created).toHaveLength(2);
    // End to end: a crop from a blob releases what it decoded, whatever the outcome.
    const canvas = fakeCanvas();
    const anchor: ImageRegionAnchor = { x: 0, y: 0, w: 0.5, h: 0.5, natural_width: 24, natural_height: 12 };
    expect(await cropImageRegion(new Blob(["<svg/>"], { type: "image/svg+xml" }), anchor, { canvas: canvas.factory })).not.toBeNull();
    expect(created).toHaveLength(3);
    expect(revoked).toEqual(["blob:fake/0", "blob:fake/1", "blob:fake/2"]);
    expect(await cropImageRegion(new Blob(["<svg/>"], { type: "image/svg+xml" }), anchor, { canvas: fakeCanvas({ throwOnDraw: true }).factory })).toBeNull();
    expect(revoked).toEqual(["blob:fake/0", "blob:fake/1", "blob:fake/2", "blob:fake/3"]);
  } finally {
    g.Image = saved.Image;
    g.createImageBitmap = saved.createImageBitmap;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});

test("a blob is decoded turned the way its EXIF says, like the <img> on screen, or through an <img> when that is unknown", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { Image: g.Image, createImageBitmap: g.createImageBitmap, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const options: unknown[] = [];
  const revoked: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_url: string) {
      queueMicrotask(() => {
        // A portrait photo stored sideways: the <img> shows it upright.
        this.naturalWidth = 300;
        this.naturalHeight = 400;
        this.onload?.();
      });
    }
  }
  try {
    g.Image = FakeImage;
    URL.createObjectURL = () => "blob:fake/exif";
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    g.createImageBitmap = async (_blob: Blob, opts?: ImageBitmapOptions) => {
      options.push(opts);
      return { width: 300, height: 400, close: () => {} };
    };
    const photo = new Blob([new Uint8Array(4)], { type: "image/jpeg" });
    const upright = await domImageLoader(photo, { svg: false });
    expect(options).toEqual([{ imageOrientation: "from-image" }]);
    expect(upright?.image.naturalWidth).toBe(300);
    upright?.release();
    // An older engine that only knows `none` / `flipY` rejects the option: the <img> decodes it upright.
    g.createImageBitmap = async (_blob: Blob, opts?: ImageBitmapOptions) => {
      if (opts?.imageOrientation === "from-image") throw new TypeError("The provided value 'from-image' is not a valid enum value");
      return { width: 400, height: 300, close: () => {} };
    };
    const fallback = await domImageLoader(photo, { svg: false });
    expect(fallback?.image).toBeInstanceOf(FakeImage);
    expect([fallback?.image.naturalWidth, fallback?.image.naturalHeight]).toEqual([300, 400]);
    fallback?.release();
    expect(revoked).toEqual(["blob:fake/exif"]);
  } finally {
    g.Image = saved.Image;
    g.createImageBitmap = saved.createImageBitmap;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});
