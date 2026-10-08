/**
 * The flow board's minimap: the whole board drawn small in a corner, with the part in view framed.
 *
 * A long job is taller than any window, and the camera is unbounded, so it is easy to be somewhere
 * on it without knowing where — or on empty canvas without knowing which way the cards are. The
 * minimap answers both, and pressing or dragging on it moves the view there.
 *
 * It draws the board and wherever the view is, together: a view panned off the board still has its
 * frame on the map, beside a board drawn smaller, which is how you see which way to go back.
 */
import { forgetStored, readStored, writeStored } from "../storage.ts";
import type { TraceView } from "./task-trace.ts";

export type TraceRect = { x: number; y: number; width: number; height: number };

/** How the minimap maps the board onto itself: board point × scale + offset is a minimap pixel. */
export type MinimapFrame = {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};

/** Big enough to tell rounds apart, small enough to leave the board its corner. */
export const TRACE_MINIMAP_MAX = { width: 168, height: 140 };
/** A board that is all one way still gets a map you can aim a press at. */
export const TRACE_MINIMAP_MIN = { width: 84, height: 56 };
/** The most of the viewport's width, and of its height, the minimap may take. */
const VIEWPORT_SHARE = { width: 0.3, height: 0.28 };
/** Room between the drawing and the minimap's edge, so a card on the edge is not cut by it. */
const PAD = 5;

/**
 * The minimap's own size, as large as the stops allow — and none on a viewport too small to spare
 * a corner for it.
 *
 * Its shape is the board's, widened or lengthened to the view's own size where the view is bigger:
 * a tall board seen whole, in a wide window, is mostly frame, and a map shaped like the board alone
 * drew it as a thin strip across the middle of a tall box. It follows the zoom but not the pan, so
 * dragging the board never makes the minimap itself grow or shrink.
 */
export function minimapSize(
  board: { width: number; height: number },
  viewport: { width: number; height: number },
  scale: number,
): { width: number; height: number } | null {
  if (!board.width || !board.height) return null;
  const max = {
    width: Math.min(TRACE_MINIMAP_MAX.width, Math.floor(viewport.width * VIEWPORT_SHARE.width)),
    height: Math.min(TRACE_MINIMAP_MAX.height, Math.floor(viewport.height * VIEWPORT_SHARE.height)),
  };
  if (max.width < TRACE_MINIMAP_MIN.width || max.height < TRACE_MINIMAP_MIN.height) return null;
  const extent = {
    width: Math.max(board.width, viewport.width / scale),
    height: Math.max(board.height, viewport.height / scale),
  };
  const fit = Math.min(max.width / extent.width, max.height / extent.height);
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(value)));
  return {
    width: clamp(extent.width * fit, TRACE_MINIMAP_MIN.width, max.width),
    height: clamp(extent.height * fit, TRACE_MINIMAP_MIN.height, max.height),
  };
}

/** The part of the board the viewport shows, in board coordinates. */
export function visibleRect(view: TraceView, viewport: { width: number; height: number }): TraceRect {
  return {
    x: -view.x / view.scale,
    y: -view.y / view.scale,
    width: viewport.width / view.scale,
    height: viewport.height / view.scale,
  };
}

/** The board and the view together, drawn as large as fits, in the middle of the minimap. */
export function minimapFrame(
  board: { width: number; height: number },
  visible: TraceRect | null,
  size: { width: number; height: number },
): MinimapFrame {
  const shown = visible && visible.width > 0 && visible.height > 0 ? visible : null;
  const left = Math.min(0, shown?.x ?? 0);
  const top = Math.min(0, shown?.y ?? 0);
  const right = Math.max(board.width, shown ? shown.x + shown.width : 0);
  const bottom = Math.max(board.height, shown ? shown.y + shown.height : 0);
  const inner = { width: Math.max(1, size.width - PAD * 2), height: Math.max(1, size.height - PAD * 2) };
  const spanX = right - left || 1;
  const spanY = bottom - top || 1;
  const scale = Math.min(inner.width / spanX, inner.height / spanY);
  return {
    width: size.width,
    height: size.height,
    scale,
    offsetX: PAD + (inner.width - spanX * scale) / 2 - left * scale,
    offsetY: PAD + (inner.height - spanY * scale) / 2 - top * scale,
  };
}

/** A board rectangle as the minimap draws it. */
export function onMinimap(frame: MinimapFrame, rect: TraceRect): TraceRect {
  return {
    x: frame.offsetX + rect.x * frame.scale,
    y: frame.offsetY + rect.y * frame.scale,
    width: rect.width * frame.scale,
    height: rect.height * frame.scale,
  };
}

/** The board point under a minimap pixel. */
export function fromMinimap(frame: MinimapFrame, at: { x: number; y: number }): { x: number; y: number } {
  return { x: (at.x - frame.offsetX) / frame.scale, y: (at.y - frame.offsetY) / frame.scale };
}

/** The view with this board point in its middle, at the zoom it is already at. */
export function viewCentredOn(
  view: TraceView,
  viewport: { width: number; height: number },
  point: { x: number; y: number },
): TraceView {
  return {
    scale: view.scale,
    x: viewport.width / 2 - point.x * view.scale,
    y: viewport.height / 2 - point.y * view.scale,
  };
}

const STORAGE_KEY = "real-bot-trace-minimap";

/** Shown unless you put it away; the choice is per-browser, like the side panel's. */
export function loadTraceMinimap(): boolean {
  return readStored(STORAGE_KEY) !== "off";
}

export function saveTraceMinimap(shown: boolean): void {
  writeStored(STORAGE_KEY, shown ? "on" : "off");
}

export function forgetTraceMinimap(): void {
  forgetStored(STORAGE_KEY);
}
