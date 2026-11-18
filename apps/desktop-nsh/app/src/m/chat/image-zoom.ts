/**
 * Pinching the enlarged picture on a phone. The frame keeps the box it was fitted to and is
 * scaled and moved with a transform, so the growing out of the thumbnail and the shrinking back
 * into it stay as they are.
 *
 * Not `overlays/screen-zoom.ts`: there zoom 1 fills the stage and sits centred, while this frame
 * rests with margins round it and room kept under it for the offer of the original.
 *
 * Units: client CSS pixels. `rest` is the fitted box; a view is the scale and where the scaled
 * frame's top-left corner sits.
 */
export type Box = { top: number; left: number; width: number; height: number };
export type Point = { x: number; y: number };
export type PictureView = { scale: number; x: number; y: number };

export function restView(rest: Box): PictureView {
  return { scale: 1, x: rest.left, y: rest.top };
}

/**
 * One axis. Larger than the stage, the picture is dragged within it and never shows a gap at an
 * edge. Smaller, it sits where it rested, in proportion, so letting go below the stage's size
 * does not jump.
 */
function placeAxis(stageStart: number, stageSize: number, restStart: number, restSize: number, size: number, wanted: number): number {
  if (size > stageSize) return Math.min(stageStart, Math.max(stageStart + stageSize - size, wanted));
  const room = stageSize - restSize;
  const share = room > 0 ? (restStart - stageStart) / room : 0.5;
  return stageStart + (stageSize - size) * share;
}

/** The view the page can show: never smaller than the fitted box, never past an edge. */
export function settleView(stage: Box, rest: Box, view: PictureView): PictureView {
  const scale = Math.max(1, view.scale);
  return {
    scale,
    x: placeAxis(stage.left, stage.width, rest.left, rest.width, rest.width * scale, view.x),
    y: placeAxis(stage.top, stage.height, rest.top, rest.height, rest.height * scale, view.y),
  };
}

/** A new scale that keeps the picture point under `anchor` where it was. */
export function zoomAround(stage: Box, rest: Box, from: PictureView, anchor: Point, scale: number, limit: number): PictureView {
  const next = Math.min(Math.max(1, scale), Math.max(1, limit));
  const point = { x: (anchor.x - from.x) / from.scale, y: (anchor.y - from.y) / from.scale };
  return settleView(stage, rest, { scale: next, x: anchor.x - point.x * next, y: anchor.y - point.y * next });
}

/** A drag while zoomed in: the picture follows the finger. */
export function panBy(stage: Box, rest: Box, from: PictureView, moved: Point): PictureView {
  return settleView(stage, rest, { scale: from.scale, x: from.x + moved.x, y: from.y + moved.y });
}

/** Twice as far in as one picture pixel to one device pixel, and at least 3×. */
export function zoomLimit(rest: Box, naturalWidth: number, devicePixelRatio: number): number {
  if (!rest.width || !naturalWidth) return 3;
  return Math.max(3, (naturalWidth / (devicePixelRatio || 1) / rest.width) * 2);
}

/** The frame's transform for a view, or nothing at rest. */
export function viewTransform(rest: Box, view: PictureView): string | null {
  if (view.scale === 1 && view.x === rest.left && view.y === rest.top) return null;
  return `translate(${view.x - rest.left}px, ${view.y - rest.top}px) scale(${view.scale})`;
}
