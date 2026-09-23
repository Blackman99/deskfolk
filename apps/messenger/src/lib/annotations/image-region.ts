/**
 * 图片框选（#26）的图片专属部分，几何本身在 `region-box.ts`：锚点 ⇄ 归一化框、拖动 / 点一下收尾成框、
 * 画在图上的编号标记、原图尺寸（SVG 没有固有尺寸时退到 viewBox，再退到 1024），以及从已经加载好的图里
 * 裁出批注区域（SVG 按裁图需要的分辨率栅格化，不重新取文件）。画布和解码都可以换成测试替身。
 */
import { validateAnchor, type Annotation, type AnnotationStatus, type ImageRegionAnchor } from "@real-bot/protocol";
import {
  boxBetween,
  canvasEncoder,
  clickBox,
  cropRect,
  encodeCrop,
  isClick,
  isUsableBox,
  resizeBox,
  scaledSize,
  toNorm,
  type CanvasEncoder,
  type DrawnRect,
  type EncodedCrop,
  type Handle,
  type NormBox,
  type NormPoint,
  type PixelRect,
  type Size,
} from "./region-box.ts";

/** What an SVG with neither a size nor a viewBox is measured as. */
export const SVG_FALLBACK_SIDE = 1024;
/** An SVG is rasterized for a crop as if its long side were at least this, so small icons crop sharp. */
export const SVG_RENDER_LONG_MIN = 2048;
/** Two aspect ratios this close are the same picture. */
const ASPECT_TOLERANCE = 0.02;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const wholePx = (value: number): number => Math.max(1, Math.round(value));

export function anchorBox(anchor: ImageRegionAnchor): NormBox {
  return { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h };
}

export function anchorNatural(anchor: ImageRegionAnchor): Size {
  return { width: anchor.natural_width, height: anchor.natural_height };
}

/**
 * A box on the image as the anchor the daemon stores: inside 0–1, six decimals (a millionth of the
 * image is well under a pixel), whole-pixel natural size. Always passes `validateAnchor` for a box
 * with some area.
 */
export function anchorFromBox(box: NormBox, natural: Size): ImageRegionAnchor {
  const x = round6(clamp01(box.x));
  const y = round6(clamp01(box.y));
  const w = round6(Math.min(Math.max(0, box.w), 1 - x));
  const h = round6(Math.min(Math.max(0, box.h), 1 - y));
  return { x, y, w, h, natural_width: wholePx(natural.width), natural_height: wholePx(natural.height) };
}

/** A drag that came out as a sliver (all sideways, or all up and down) gets a click box's thickness. */
export function thickenSliver(box: NormBox, natural: Size): NormBox {
  if (isUsableBox(box)) return box;
  const small = clickBox({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, natural);
  const thinX = box.w <= 0.0005;
  const thinY = box.h <= 0.0005;
  return {
    x: thinX ? small.x : box.x,
    y: thinY ? small.y : box.y,
    w: thinX ? small.w : box.w,
    h: thinY ? small.h : box.h,
  };
}

/**
 * How a new box ends: a pointer that barely moved is a click (a small square, 4% of the short side),
 * anything else is the box between where it went down and where it came up.
 */
export function finishNewBox(
  start: { client: { x: number; y: number }; norm: NormPoint },
  end: { client: { x: number; y: number }; norm: NormPoint },
  natural: Size,
): NormBox {
  if (isClick(start.client, end.client)) return clickBox(start.norm, natural);
  return thickenSliver(boxBetween(start.norm, end.norm), natural);
}

/** A whole gesture on screen, straight to an anchor: what the component does on pointer up. */
export function anchorFromDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  drawn: DrawnRect,
  natural: Size,
): ImageRegionAnchor {
  const box = finishNewBox(
    { client: from, norm: toNorm(from.x, from.y, drawn) },
    { client: to, norm: toNorm(to.x, to.y, drawn) },
    natural,
  );
  return anchorFromBox(box, natural);
}

/** A pointer on screen as a point on the image, not clamped: a handle may be dragged past the edge. */
export function toNormFree(clientX: number, clientY: number, drawn: DrawnRect): NormPoint {
  if (drawn.width <= 0 || drawn.height <= 0) return { x: 0, y: 0 };
  return { x: (clientX - drawn.left) / drawn.width, y: (clientY - drawn.top) / drawn.height };
}

/** The corner of a box that a handle sits on. */
export function handleCorner(box: NormBox, handle: Handle): NormPoint {
  return {
    x: handle === "nw" || handle === "sw" ? box.x : box.x + box.w,
    y: handle === "nw" || handle === "ne" ? box.y : box.y + box.h,
  };
}

/**
 * Resize by a handle grabbed `grab` away from its corner (corner minus pointer, normalized): the
 * corner keeps that offset from the pointer instead of jumping under it on the first move — a
 * 40px touch handle is seldom pressed dead on its corner. Clamped to the image by `resizeBox`.
 */
export function resizeByGrab(box: NormBox, handle: Handle, pointer: NormPoint, grab: NormPoint): NormBox {
  return resizeBox(box, handle, { x: pointer.x + grab.x, y: pointer.y + grab.y });
}

/** Below this many screen pixels on either side, a pending box keeps a single handle. */
export const COMPACT_BOX_PX = 64;

/**
 * Whether a pending box is too small on screen for four corner handles: they would cover all of
 * it and leave nothing to grab for a move. Such a box gets one handle, just outside its corner.
 */
export function isCompactBox(box: NormBox, drawn: Pick<Size, "width" | "height">): boolean {
  return Math.min(box.w * drawn.width, box.h * drawn.height) < COMPACT_BOX_PX;
}

export type RegionMark = {
  id: string;
  /** 1..n in the order the rows were given, so it matches the list beside the image. */
  n: number;
  box: NormBox;
  status: AnnotationStatus;
  stale: boolean;
  body: string;
};

/**
 * The rows to draw, numbered by their place in `rows`. A row whose file is gone keeps its number
 * but is not drawn, and so is one whose anchor is not an image region.
 */
export function regionMarks(rows: readonly Annotation[]): RegionMark[] {
  const marks: RegionMark[] = [];
  rows.forEach((row, index) => {
    if (row.anchor_kind !== "image_region" || row.stale?.kind === "missing") return;
    const check = validateAnchor("image_region", row.anchor);
    if (!check.ok) return;
    const status: AnnotationStatus = row.status === "draft" ? "draft" : row.status === "resolved" ? "resolved" : "open";
    marks.push({ id: row.id, n: index + 1, box: anchorBox(check.anchor as ImageRegionAnchor), status, stale: Boolean(row.stale), body: row.body });
  });
  return marks;
}

/** The classes a drawn mark carries: its state, and dashed when the image changed since. */
export function markClass(mark: Pick<RegionMark, "status" | "stale">): string {
  return `img-annot-mark is-${mark.status}${mark.stale ? " is-stale" : ""}`;
}

/* ---------------------------------------------------------------- natural size */

const CSS_PX: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };

function svgLength(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
  if (!match) return null;
  const unit = match[2]!.toLowerCase();
  const scale = CSS_PX[unit];
  const value = Number(match[1]) * (scale ?? Number.NaN);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function rootAttribute(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = re.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

export type SvgMetrics = {
  /** What the SVG declares itself as: width and height, or one of them and the viewBox's ratio. */
  size: Size | null;
  viewBox: Size | null;
};

/** Read the root `<svg>` tag's width, height and viewBox; percentages and `auto` are no size. */
export function svgMetrics(svgText: string): SvgMetrics {
  // A generator's comment ahead of the root can itself mention `<svg …>`.
  const open = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(svgText.replace(/<!--[\s\S]*?-->/g, ""));
  if (!open) return { size: null, viewBox: null };
  const tag = open[1] ?? "";
  const width = svgLength(rootAttribute(tag, "width"));
  const height = svgLength(rootAttribute(tag, "height"));
  const box = rootAttribute(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
  const viewBox = box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { width: box[2]!, height: box[3]! } : null;
  let size: Size | null = null;
  if (width !== null && height !== null) size = { width, height };
  else if (width !== null && viewBox) size = { width, height: (width * viewBox.height) / viewBox.width };
  else if (height !== null && viewBox) size = { width: (height * viewBox.width) / viewBox.height, height };
  return { size, viewBox };
}

function sameAspect(a: Size, b: Size): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / rb <= ASPECT_TOLERANCE;
}

const whole = (size: Size): Size => ({ width: wholePx(size.width), height: wholePx(size.height) });

/**
 * The size an anchor is normalized to. A raster image has its pixels; nothing before it loads.
 * An SVG: what its root tag declares, else its viewBox (the units a Bot editing it would use),
 * else the browser's natural size when it has the same shape as what is drawn, else 1024 on the
 * long side in the drawn shape (1024×1024 when even that is unknown).
 */
export function resolveNaturalSize(
  image: { naturalWidth: number; naturalHeight: number },
  opts: { svg?: boolean; svgText?: string | null; drawn?: Size | null } = {},
): Size | null {
  const own: Size = { width: image.naturalWidth, height: image.naturalHeight };
  const hasOwn = own.width > 0 && own.height > 0;
  if (!opts.svg) return hasOwn ? whole(own) : null;
  if (opts.svgText) {
    const metrics = svgMetrics(opts.svgText);
    if (metrics.size) return whole(metrics.size);
    if (metrics.viewBox) return whole(metrics.viewBox);
  }
  const drawn = opts.drawn && opts.drawn.width > 0 && opts.drawn.height > 0 ? opts.drawn : null;
  // A viewBox-only SVG can report a made-up 300×150; trust it only when it has the drawn shape.
  if (hasOwn && (!drawn || sameAspect(own, drawn))) return whole(own);
  if (drawn) {
    const k = SVG_FALLBACK_SIDE / Math.max(drawn.width, drawn.height);
    return whole({ width: drawn.width * k, height: drawn.height * k });
  }
  return { width: SVG_FALLBACK_SIDE, height: SVG_FALLBACK_SIDE };
}

/* ---------------------------------------------------------------- crop */

/** The one drawing call a crop makes; a real 2D context and a test double both provide it. */
export type DrawContext = { drawImage(image: CanvasImageSource, ...args: number[]): void };
export type DrawTarget = { ctx: DrawContext; encoder: CanvasEncoder };
/** A blank canvas of this size, or null when the browser cannot give a 2D context. */
export type CanvasFactory = (size: Size) => DrawTarget | null;
export type LoadedImage = { image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number }; release(): void };
/** Decode a blob into something drawable, or null when it will not decode. */
export type ImageLoader = (blob: Blob, opts: { svg: boolean }) => Promise<LoadedImage | null>;
export type CropDeps = { canvas?: CanvasFactory; loadImage?: ImageLoader };

export const domCanvas: CanvasFactory = (size) => {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  return ctx ? { ctx: ctx as unknown as DrawContext, encoder: canvasEncoder(canvas) } : null;
};

/**
 * A raster blob decodes to its first frame (a GIF included), turned the way its EXIF says as the
 * `<img>` on screen is — a browser that does not know `from-image` throws, and the `<img>` path
 * below takes over. An SVG always goes through an `<img>`.
 */
export const domImageLoader: ImageLoader = async (blob, { svg }) => {
  if (!svg && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { image: Object.assign(bitmap, { naturalWidth: bitmap.width, naturalHeight: bitmap.height }), release: () => bitmap.close() };
    } catch {
      // Fall through to an <img>, which decodes more formats.
    }
  }
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image did not decode"));
      image.src = url;
    });
    return { image, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
};

export type CropPlan =
  /** Cut `rect` out of the image's own pixels. */
  | { kind: "raster"; rect: PixelRect; out: Size }
  /** Draw the whole SVG at `render` size, shifted so `rect` lands on the canvas. */
  | { kind: "svg"; rect: PixelRect; out: Size; render: Size };

/** The size an SVG is rasterized at: its own, scaled up (never down) to a long side of 2048. */
export function svgRenderSize(natural: Size): Size {
  const long = Math.max(natural.width, natural.height, 1);
  const k = Math.max(1, SVG_RENDER_LONG_MIN / long);
  return { width: natural.width * k, height: natural.height * k };
}

/**
 * What a crop cuts and how big it comes out: the box plus a 10% margin (clipped at the image's
 * edge), long side at most 1024. `source` is the decoded image's own size for a raster, and the
 * anchor's size for an SVG, which has no pixels until it is drawn.
 */
export function cropPlan(anchor: ImageRegionAnchor, source: Size, svg: boolean): CropPlan {
  const box = anchorBox(anchor);
  if (!svg) {
    const rect = cropRect(box, source);
    return { kind: "raster", rect, out: scaledSize(rect.sw, rect.sh) };
  }
  const render = svgRenderSize(source);
  const rect = cropRect(box, render);
  return { kind: "svg", rect, out: scaledSize(rect.sw, rect.sh), render };
}

/** Draw a plan onto a canvas of its output size. */
export function drawPlan(ctx: DrawContext, image: CanvasImageSource, plan: CropPlan): void {
  const { rect, out } = plan;
  if (plan.kind === "raster") {
    ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, out.width, out.height);
    return;
  }
  // The destination-only form rasterizes the vector at the size asked for, so the crop is sharp.
  const kx = out.width / rect.sw;
  const ky = out.height / rect.sh;
  ctx.drawImage(image, -rect.sx * kx, -rect.sy * ky, plan.render.width * kx, plan.render.height * ky);
}

async function ready(image: HTMLImageElement): Promise<boolean> {
  if (image.complete) return true;
  try {
    await image.decode();
    return true;
  } catch {
    return false;
  }
}

function isImageElement(value: HTMLImageElement | Blob): value is HTMLImageElement {
  return !(typeof Blob !== "undefined" && value instanceof Blob);
}

/**
 * Cut the anchor's region out of an image that is already loaded — the `<img>` on screen, or its
 * blob — as PNG (JPEG when PNG passes 1 MB). Never fetches anything. Null when the browser cannot
 * decode or draw it, or the canvas refuses to export: the annotation still goes out, without a crop.
 */
export async function cropImageRegion(
  image: HTMLImageElement | Blob,
  anchor: ImageRegionAnchor,
  opts: { svg?: boolean } & CropDeps = {},
): Promise<EncodedCrop | null> {
  const makeCanvas = opts.canvas ?? domCanvas;
  let loaded: LoadedImage | null = null;
  try {
    let source: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number };
    let svg: boolean;
    if (isImageElement(image)) {
      svg = Boolean(opts.svg);
      if (!(await ready(image))) return null;
      source = image;
    } else {
      svg = opts.svg ?? /svg/i.test(image.type);
      loaded = await (opts.loadImage ?? domImageLoader)(image, { svg });
      if (!loaded) return null;
      source = loaded.image;
    }
    const own: Size = { width: source.naturalWidth ?? 0, height: source.naturalHeight ?? 0 };
    // A raster is cut from its own pixels; an SVG is drawn at the size the anchor was measured in.
    if (!svg && !(own.width > 0 && own.height > 0)) return null;
    const plan = cropPlan(anchor, svg ? anchorNatural(anchor) : own, svg);
    const target = makeCanvas(plan.out);
    if (!target) return null;
    drawPlan(target.ctx, source, plan);
    return await encodeCrop(target.encoder);
  } catch {
    // A decode that failed late, a canvas the browser tainted: no crop.
    return null;
  } finally {
    loaded?.release();
  }
}
