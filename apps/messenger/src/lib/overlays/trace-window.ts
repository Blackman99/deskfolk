/**
 * Where the trace window was left. Remembered on this machine, so the next open comes back to it.
 * A phone ignores it: there the trace is a page.
 */
const STORAGE_KEY = "real-bot-trace-window";

export const TRACE_WINDOW_MIN_WIDTH = 300;
export const TRACE_WINDOW_MIN_HEIGHT = 280;

export type TraceWindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** The corner being pulled. Every corner resizes; the one across from it stays put. */
export type TraceCorner = "nw" | "ne" | "sw" | "se";

export function loadTraceWindow(): TraceWindowFrame | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TraceWindowFrame>;
    if (!isFrame(parsed)) return null;
    return clampTraceWindow(parsed);
  } catch {
    return null;
  }
}

export function saveTraceWindow(frame: TraceWindowFrame): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clampTraceWindow(frame)));
  } catch {
    // A private window that refuses storage still keeps the frame for this open.
  }
}

/**
 * The frame after dragging a corner by (dx, dy).
 *
 * The opposite corner is the anchor: pulling the top-left moves x and y as the window grows, so
 * the bottom-right stays under the same pixel. Width and height are limited before the edges are
 * derived from them, or a window squeezed past its minimum would start sliding across the screen
 * instead of stopping.
 */
export function resizeTraceWindow(
  frame: TraceWindowFrame,
  corner: TraceCorner,
  dx: number,
  dy: number,
  viewport: { width: number; height: number } = screenSize(),
): TraceWindowFrame {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const width = fit(
    west ? frame.width - dx : frame.width + dx,
    TRACE_WINDOW_MIN_WIDTH,
    west ? right - 8 : viewport.width - frame.x - 8,
  );
  const height = fit(
    north ? frame.height - dy : frame.height + dy,
    TRACE_WINDOW_MIN_HEIGHT,
    north ? bottom - 8 : viewport.height - frame.y - 8,
  );
  return clampTraceWindow(
    {
      x: west ? right - width : frame.x,
      y: north ? bottom - height : frame.y,
      width,
      height,
    },
    viewport,
  );
}

function fit(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, Math.round(value)));
}

/** Pulls a frame back inside the screen and up to the smallest size that still shows a card. */
export function clampTraceWindow(
  frame: TraceWindowFrame,
  viewport: { width: number; height: number } = screenSize(),
): TraceWindowFrame {
  const maxWidth = Math.max(TRACE_WINDOW_MIN_WIDTH, viewport.width - 16);
  const maxHeight = Math.max(TRACE_WINDOW_MIN_HEIGHT, viewport.height - 16);
  const width = Math.min(maxWidth, Math.max(TRACE_WINDOW_MIN_WIDTH, Math.round(frame.width)));
  const height = Math.min(maxHeight, Math.max(TRACE_WINDOW_MIN_HEIGHT, Math.round(frame.height)));
  return {
    x: Math.min(Math.max(8, Math.round(frame.x)), Math.max(8, viewport.width - width - 8)),
    y: Math.min(Math.max(8, Math.round(frame.y)), Math.max(8, viewport.height - height - 8)),
    width,
    height,
  };
}

function isFrame(value: Partial<TraceWindowFrame>): value is TraceWindowFrame {
  return [value.x, value.y, value.width, value.height].every(
    (part) => typeof part === "number" && Number.isFinite(part),
  );
}

function screenSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}
