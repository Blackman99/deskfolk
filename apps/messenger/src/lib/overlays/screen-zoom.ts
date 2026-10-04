/**
 * Zooming the Mac's screen on the phone, locally: the picture's box grows past the page and the
 * page shows a window onto it. noVNC fits its canvas to that box, so its own pointer mapping stays
 * right at every zoom; this only works out the box.
 *
 * Units: `zoom` 1 is the whole screen fitted to the stage; `pan` is how far the stage's top-left
 * corner sits into the zoomed picture, in CSS pixels.
 */
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type ZoomView = { zoom: number; pan: Point };
export type Box = { width: number; height: number; left: number; top: number };

/** The picture fitted whole into the stage, aspect kept. */
export function fitSize(stage: Size, frame: Size): Size {
  if (!stage.w || !stage.h || !frame.w || !frame.h) return { w: stage.w, h: stage.h };
  const scale = Math.min(stage.w / frame.w, stage.h / frame.h);
  return { w: frame.w * scale, h: frame.h * scale };
}

/** One Mac pixel to one device pixel: as sharp as the picture gets. */
export function actualZoom(stage: Size, frame: Size, devicePixelRatio: number): number {
  const fit = fitSize(stage, frame);
  if (!fit.w) return 1;
  return Math.max(1, frame.w / devicePixelRatio / fit.w);
}

/** Twice as far in as actual size; past that a Mac pixel is just a bigger square. */
export function maxZoom(stage: Size, frame: Size, devicePixelRatio: number): number {
  return Math.max(1, actualZoom(stage, frame, devicePixelRatio) * 2);
}

function clampPan(stage: Size, size: Size, pan: Point): Point {
  return {
    x: Math.min(Math.max(0, pan.x), Math.max(0, size.w - stage.w)),
    y: Math.min(Math.max(0, pan.y), Math.max(0, size.h - stage.h)),
  };
}

/** Where the picture's box goes: centred along a side it does not fill, panned along one it overflows. */
export function boxFor(stage: Size, frame: Size, view: ZoomView): Box {
  const fit = fitSize(stage, frame);
  const size = { w: fit.w * view.zoom, h: fit.h * view.zoom };
  const pan = clampPan(stage, size, view.pan);
  return {
    width: size.w,
    height: size.h,
    left: size.w <= stage.w ? (stage.w - size.w) / 2 : -pan.x,
    top: size.h <= stage.h ? (stage.h - size.h) / 2 : -pan.y,
  };
}

/** A new zoom that keeps the picture point under `anchor` (stage coordinates) where it was. */
export function zoomAround(stage: Size, frame: Size, from: ZoomView, anchor: Point, zoom: number, limit: number): ZoomView {
  const next = Math.min(Math.max(1, zoom), Math.max(1, limit));
  const box = boxFor(stage, frame, from);
  const fit = fitSize(stage, frame);
  // The point under the anchor, in fitted (zoom 1) units.
  const point = { x: (anchor.x - box.left) / from.zoom, y: (anchor.y - box.top) / from.zoom };
  const size = { w: fit.w * next, h: fit.h * next };
  const pan = clampPan(stage, size, { x: point.x * next - anchor.x, y: point.y * next - anchor.y });
  return { zoom: next, pan };
}

/** A two-finger drag while zoomed in: the picture follows the fingers. */
export function panBy(stage: Size, frame: Size, from: ZoomView, moved: Point): ZoomView {
  const fit = fitSize(stage, frame);
  const size = { w: fit.w * from.zoom, h: fit.h * from.zoom };
  return { zoom: from.zoom, pan: clampPan(stage, size, { x: from.pan.x - moved.x, y: from.pan.y - moved.y }) };
}

/**
 * Which part of the picture each edge of the stage cuts off, in the Mac's pixels, `margin` CSS
 * pixels in from an edge the picture runs past. An edge where the picture itself ends gets no
 * margin, or the pointer could never reach the menu bar or a hot corner.
 */
function shownRange(stage: Size, frame: Size, view: ZoomView, margin: number): { left: number; right: number; top: number; bottom: number } {
  const box = boxFor(stage, frame, view);
  const scale = box.width / frame.w || 1;
  return {
    left: box.left < 0 ? (margin - box.left) / scale : 0,
    right: box.left + box.width > stage.w ? (stage.w - margin - box.left) / scale : frame.w - 1,
    top: box.top < 0 ? (margin - box.top) / scale : 0,
    bottom: box.top + box.height > stage.h ? (stage.h - margin - box.top) / scale : frame.h - 1,
  };
}

/** The nearest point to `point` (Mac pixels) that the stage shows: trackpad mode's pointer never hides off the page. */
export function keepShown(stage: Size, frame: Size, view: ZoomView, point: Point, margin: number): Point {
  const shown = shownRange(stage, frame, view, margin);
  return {
    x: Math.min(Math.max(point.x, shown.left), Math.max(shown.left, shown.right)),
    y: Math.min(Math.max(point.y, shown.top), Math.max(shown.top, shown.bottom)),
  };
}

/** The view moved just enough that `point` (Mac pixels) stays shown: zoomed in, the picture follows the pointer. */
export function follow(stage: Size, frame: Size, view: ZoomView, point: Point, margin: number): ZoomView {
  // From the pan the page actually shows: a stored one can sit past the edge after the stage shrank.
  const from = panBy(stage, frame, view, { x: 0, y: 0 });
  const shown = shownRange(stage, frame, from, margin);
  const scale = boxFor(stage, frame, from).width / frame.w || 1;
  const shift = {
    x: point.x < shown.left ? (shown.left - point.x) * scale : point.x > shown.right ? (shown.right - point.x) * scale : 0,
    y: point.y < shown.top ? (shown.top - point.y) * scale : point.y > shown.bottom ? (shown.bottom - point.y) * scale : 0,
  };
  if (shift.x || shift.y) return panBy(stage, frame, from, shift);
  // Unchanged stays the same object: a move that pans nothing re-lays nothing out.
  return from.pan.x === view.pan.x && from.pan.y === view.pan.y ? view : from;
}
