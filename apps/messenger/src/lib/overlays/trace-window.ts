/**
 * Where the trace window was left. Remembered on this machine, so the next open comes back to it.
 * A phone ignores it: there the trace is a page.
 *
 * The arithmetic lives in `workbench/float-frame.ts`, which every floating pane uses. This file
 * is what the trace window calls it by, plus the one storage key that belongs to it. When the
 * trace becomes an ordinary pane this file goes away; until then there is still only one
 * implementation of a floating frame, which is the point.
 */
import {
  clampFrame,
  isFrame,
  resizeFrame,
  type Corner,
  type Viewport,
} from "../workbench/float-frame.ts";
import type { FloatFrame, PaneMin } from "../workbench/layout-types.ts";

const STORAGE_KEY = "real-bot-trace-window";

export const TRACE_WINDOW_MIN_WIDTH = 300;
export const TRACE_WINDOW_MIN_HEIGHT = 280;
const TRACE_MIN: PaneMin = { width: TRACE_WINDOW_MIN_WIDTH, height: TRACE_WINDOW_MIN_HEIGHT };

export type TraceWindowFrame = FloatFrame;

/** The corner being pulled. Every corner resizes; the one across from it stays put. */
export type TraceCorner = Corner;

export function loadTraceWindow(): TraceWindowFrame | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
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

export function resizeTraceWindow(
  frame: TraceWindowFrame,
  corner: TraceCorner,
  dx: number,
  dy: number,
  viewport: Viewport = screenSize(),
): TraceWindowFrame {
  return resizeFrame(frame, corner, dx, dy, TRACE_MIN, viewport);
}

/** Pulls a frame back inside the screen and up to the smallest size that still shows a card. */
export function clampTraceWindow(
  frame: TraceWindowFrame,
  viewport: Viewport = screenSize(),
): TraceWindowFrame {
  return clampFrame(frame, TRACE_MIN, viewport);
}

function screenSize(): Viewport {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}
