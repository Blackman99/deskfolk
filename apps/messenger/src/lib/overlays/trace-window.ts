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

/** Pulls a frame back inside the screen and up to the smallest size that still shows a card. */
export function clampTraceWindow(
  frame: TraceWindowFrame,
  viewport: { width: number; height: number } = typeof window === "undefined"
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight },
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
