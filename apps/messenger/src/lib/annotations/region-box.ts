/**
 * 框选的几何，图片（#26）和 PDF 页面（#27）共用：指针位置 → 归一化坐标、拖出来的框、点一下的小框、
 * 挪动与改大小、裁图区域（四周留 10%）、缩到长边 1024 以内，以及把画布编码成 1 MB 以内的 PNG / JPEG。
 * 全部按「0–1 归一化到原图（或该页）尺寸」计算，显示时怎么缩放都不影响存下的锚点。
 */

/** A box normalized to the image (or the page): 0–1 on both axes. */
export type NormBox = { x: number; y: number; w: number; h: number };
export type NormPoint = { x: number; y: number };
export type Size = { width: number; height: number };
/** Where the image (or page) is drawn on screen, as `getBoundingClientRect()` reports it. */
export type DrawnRect = { left: number; top: number; width: number; height: number };

/** A click is a box whose side is this share of the image's short side. */
export const CLICK_BOX_SHARE = 0.04;
/** A drag shorter than this many screen pixels is a click, not a box. */
export const DRAG_THRESHOLD_PX = 4;
/** The crop keeps this share of the box's size as margin on every side. */
export const CROP_MARGIN_SHARE = 0.1;
export const CROP_LONG_SIDE_MAX = 1024;
export const CROP_BYTES_MAX = 1024 * 1024;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A pointer on screen, as a point on the image: clamped to its edges. */
export function toNorm(clientX: number, clientY: number, drawn: DrawnRect): NormPoint {
  if (drawn.width <= 0 || drawn.height <= 0) return { x: 0, y: 0 };
  return { x: clamp01((clientX - drawn.left) / drawn.width), y: clamp01((clientY - drawn.top) / drawn.height) };
}

/** A normalized box, back on screen: what an overlay positions itself by, in pixels. */
export function toScreen(box: NormBox, drawn: DrawnRect): DrawnRect {
  return { left: drawn.left + box.x * drawn.width, top: drawn.top + box.y * drawn.height, width: box.w * drawn.width, height: box.h * drawn.height };
}

/** The same box as CSS percentages of the drawn image, which follows any later resize for free. */
export function toPercentStyle(box: NormBox): string {
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return `left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.w)};height:${pct(box.h)}`;
}

/** The box between two points, whichever way the drag went, kept inside the image. */
export function boxBetween(a: NormPoint, b: NormPoint): NormBox {
  const x0 = clamp01(Math.min(a.x, b.x));
  const y0 = clamp01(Math.min(a.y, b.y));
  const x1 = clamp01(Math.max(a.x, b.x));
  const y1 = clamp01(Math.max(a.y, b.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A click becomes a small square box centred on the point: its side is 4% of the image's short
 * side, in pixels, so it stays square on a wide image; nudged inward at the edges.
 */
export function clickBox(point: NormPoint, natural: Size): NormBox {
  const side = Math.max(1, Math.min(natural.width, natural.height) * CLICK_BOX_SHARE);
  const w = Math.min(1, side / Math.max(1, natural.width));
  const h = Math.min(1, side / Math.max(1, natural.height));
  const x = Math.min(Math.max(0, point.x - w / 2), 1 - w);
  const y = Math.min(Math.max(0, point.y - h / 2), 1 - h);
  return { x, y, w, h };
}

/** Whether a pointer that went down at `a` and up at `b` (screen pixels) was a click. */
export function isClick(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) < DRAG_THRESHOLD_PX;
}

/** Move a box by a normalized offset, without letting it leave the image. */
export function moveBox(box: NormBox, dx: number, dy: number): NormBox {
  return { ...box, x: Math.min(Math.max(0, box.x + dx), 1 - box.w), y: Math.min(Math.max(0, box.y + dy), 1 - box.h) };
}

export type Handle = "nw" | "ne" | "sw" | "se";

/** Drag one corner of a box to a point; the opposite corner stays where it is. */
export function resizeBox(box: NormBox, handle: Handle, to: NormPoint): NormBox {
  const fixed: NormPoint = {
    x: handle === "nw" || handle === "sw" ? box.x + box.w : box.x,
    y: handle === "nw" || handle === "ne" ? box.y + box.h : box.y,
  };
  return boxBetween(fixed, to);
}

/** A box that is not a sliver: something a remark can be about. */
export function isUsableBox(box: NormBox): boolean {
  return box.w > 0.0005 && box.h > 0.0005;
}

/** Pixel rect in the source image: integers, inside it. */
export type PixelRect = { sx: number; sy: number; sw: number; sh: number };

/** The region to cut: the box plus 10% of its size on every side, in the source's pixels. */
export function cropRect(box: NormBox, natural: Size): PixelRect {
  const mx = box.w * CROP_MARGIN_SHARE;
  const my = box.h * CROP_MARGIN_SHARE;
  // Snapped first: 0.1 + 0.01 is 0.11000000000000001, and a ceiling would take a whole pixel for it.
  const snap = (v: number): number => Math.round(v * 1e6) / 1e6;
  const x0 = snap(clamp01(box.x - mx) * natural.width);
  const y0 = snap(clamp01(box.y - my) * natural.height);
  const x1 = snap(clamp01(box.x + box.w + mx) * natural.width);
  const y1 = snap(clamp01(box.y + box.h + my) * natural.height);
  const sx = Math.floor(x0);
  const sy = Math.floor(y0);
  return { sx, sy, sw: Math.max(1, Math.ceil(x1) - sx), sh: Math.max(1, Math.ceil(y1) - sy) };
}

/** The drawn size of a crop: its long side at most 1024, never scaled up. */
export function scaledSize(width: number, height: number, longMax = CROP_LONG_SIDE_MAX): Size {
  const long = Math.max(width, height);
  if (long <= longMax) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const k = longMax / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** What a crop becomes on the wire: the daemon takes PNG or JPEG, base64, 1 MB at most. */
export type EncodedCrop = { mime: "image/png" | "image/jpeg"; base64: string };

/** The one canvas operation the encoder needs; a real canvas and a test double both provide it. */
export type CanvasEncoder = { toBlob(type: string, quality?: number): Promise<Blob | null> };

/**
 * PNG when it fits in 1 MB, else JPEG at falling quality until it does. Null if nothing fits —
 * the annotation still goes out, only without its crop.
 */
export async function encodeCrop(canvas: CanvasEncoder, maxBytes = CROP_BYTES_MAX): Promise<EncodedCrop | null> {
  const png = await canvas.toBlob("image/png");
  if (png && png.size <= maxBytes) return { mime: "image/png", base64: await blobToBase64(png) };
  for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) {
    const jpeg = await canvas.toBlob("image/jpeg", quality);
    if (jpeg && jpeg.size <= maxBytes) return { mime: "image/jpeg", base64: await blobToBase64(jpeg) };
  }
  return null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** An HTML canvas as a {@link CanvasEncoder}. */
export function canvasEncoder(canvas: HTMLCanvasElement): CanvasEncoder {
  return { toBlob: (type, quality) => new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality)) };
}

/**
 * Cut `rect` out of something drawable (an image, a video frame, a rendered PDF page) into a canvas
 * no longer than 1024 on its long side, and encode it. Null when the browser cannot draw it.
 */
export async function cropDrawable(source: CanvasImageSource, rect: PixelRect): Promise<EncodedCrop | null> {
  if (typeof document === "undefined") return null;
  const size = scaledSize(rect.sw, rect.sh);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, size.width, size.height);
  } catch {
    return null;
  }
  return encodeCrop(canvasEncoder(canvas));
}
