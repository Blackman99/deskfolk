/**
 * Where a floating pane sits, and what a drag on its edges does.
 *
 * Generalised from the trace window, which was the first thing in the app to float: same
 * arithmetic, with the minimum size passed in rather than fixed, so every kind of pane can use
 * it. There is deliberately only one implementation of this — two would drift.
 *
 * "Floating" means floating inside the one app window. There is no second OS window.
 */
import type { FloatFrame, PaneMin, Rect } from "./layout-types.ts";

/**
 * Which edge or corner is being pulled. The side across from it stays where it is: an edge moves
 * one side, a corner the two it joins.
 */
export type Handle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** Kept clear of the window edge so a floating pane never looks welded to it. */
export const FLOAT_EDGE_GAP = 8;

export type Viewport = { width: number; height: number };

function fit(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, Math.round(value)));
}

/** How far each new float is stepped down and right from the last, so none hides another exactly. */
export const FLOAT_OPEN_STEP = 28;

/**
 * Where a window that opens floating goes: in the middle of the workbench, most of it, never under
 * what its content needs, and stepped past the floats already there.
 */
export function frameForOpen(viewport: Viewport, min: PaneMin, floatingCount: number): FloatFrame {
  const width = Math.max(min.width, Math.round(viewport.width * 0.6));
  const height = Math.max(min.height, Math.round(viewport.height * 0.7));
  const step = FLOAT_OPEN_STEP * (floatingCount % 6);
  return clampFrame(
    { x: (viewport.width - width) / 2 + step, y: (viewport.height - height) / 2 + step, width, height },
    min,
    viewport,
  );
}

/** Pull a frame back inside the window and up to a size that still shows something. */
export function clampFrame(frame: FloatFrame, min: PaneMin, viewport: Viewport): FloatFrame {
  const gap = FLOAT_EDGE_GAP;
  const maxWidth = Math.max(min.width, viewport.width - gap * 2);
  const maxHeight = Math.max(min.height, viewport.height - gap * 2);
  const width = Math.min(maxWidth, Math.max(min.width, Math.round(frame.width)));
  const height = Math.min(maxHeight, Math.max(min.height, Math.round(frame.height)));
  return {
    x: Math.min(Math.max(gap, Math.round(frame.x)), Math.max(gap, viewport.width - width - gap)),
    y: Math.min(Math.max(gap, Math.round(frame.y)), Math.max(gap, viewport.height - height - gap)),
    width,
    height,
  };
}

/**
 * The frame after pulling an edge or a corner by (dx, dy).
 *
 * Width and height are limited before the edges are worked out from them; the other way round, a
 * pane squeezed past its minimum starts sliding across the screen instead of stopping. An edge
 * leaves the other axis alone: pulling the east edge never moves the pane up or down.
 */
export function resizeFrame(
  frame: FloatFrame,
  handle: Handle,
  dx: number,
  dy: number,
  min: PaneMin,
  viewport: Viewport,
): FloatFrame {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const gap = FLOAT_EDGE_GAP;
  const width = west || east
    ? fit(
      west ? frame.width - dx : frame.width + dx,
      min.width,
      west ? right - gap : viewport.width - frame.x - gap,
    )
    : frame.width;
  const height = north || south
    ? fit(
      north ? frame.height - dy : frame.height + dy,
      min.height,
      north ? bottom - gap : viewport.height - frame.y - gap,
    )
    : frame.height;
  return clampFrame(
    { x: west ? right - width : frame.x, y: north ? bottom - height : frame.y, width, height },
    min,
    viewport,
  );
}

export function moveFrame(frame: FloatFrame, dx: number, dy: number, min: PaneMin, viewport: Viewport): FloatFrame {
  return clampFrame({ ...frame, x: frame.x + dx, y: frame.y + dy }, min, viewport);
}

/**
 * Where a pane torn out of the tree should land: the size it had, centred on the pointer, nudged
 * back inside the window. Keeping its size means the tear-out does not also resize it.
 */
export function frameForTearOut(source: Rect, point: { x: number; y: number }, min: PaneMin, viewport: Viewport): FloatFrame {
  const width = Math.max(min.width, Math.round(source.width * 0.8));
  const height = Math.max(min.height, Math.round(source.height * 0.8));
  return clampFrame({ x: Math.round(point.x - width / 2), y: Math.round(point.y - height / 2), width, height }, min, viewport);
}

export function isFrame(value: unknown): value is FloatFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<FloatFrame>;
  return [frame.x, frame.y, frame.width, frame.height].every(
    (part) => typeof part === "number" && Number.isFinite(part),
  );
}
