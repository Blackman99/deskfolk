import { expect, test } from "bun:test";
import {
  TRACE_WINDOW_MIN_HEIGHT,
  TRACE_WINDOW_MIN_WIDTH,
  clampTraceWindow,
  loadTraceWindow,
  resizeTraceWindow,
  saveTraceWindow,
} from "./trace-window.ts";

const screen = { width: 1200, height: 800 };

test("a frame stays inside the screen and above the smallest usable size", () => {
  expect(clampTraceWindow({ x: -40, y: 900, width: 120, height: 40 }, screen)).toEqual({
    x: 8,
    y: 800 - TRACE_WINDOW_MIN_HEIGHT - 8,
    width: TRACE_WINDOW_MIN_WIDTH,
    height: TRACE_WINDOW_MIN_HEIGHT,
  });
  expect(clampTraceWindow({ x: 1100, y: 20, width: 900, height: 900 }, screen)).toEqual({
    x: 292,
    y: 8,
    width: 900,
    height: 784,
  });
  expect(clampTraceWindow({ x: 0, y: 0, width: 4000, height: 4000 }, screen).width).toBe(1184);
});

test("the frame comes back the next time", () => {
  localStorage.clear();
  expect(loadTraceWindow()).toBeNull();
  saveTraceWindow({ x: 40, y: 60, width: 480, height: 520 });
  expect(loadTraceWindow()).toEqual({ x: 40, y: 60, width: 480, height: 520 });
  localStorage.setItem("real-bot-trace-window", "not json");
  expect(loadTraceWindow()).toBeNull();
});

test("every corner resizes, and the corner across from it stays put", () => {
  const frame = { x: 300, y: 200, width: 440, height: 480 };
  expect(resizeTraceWindow(frame, "se", 60, 40, screen)).toEqual({
    x: 300,
    y: 200,
    width: 500,
    height: 520,
  });
  // Pulling the top-left out grows the window and leaves the bottom-right where it was.
  expect(resizeTraceWindow(frame, "nw", -60, -40, screen)).toEqual({
    x: 240,
    y: 160,
    width: 500,
    height: 520,
  });
  expect(resizeTraceWindow(frame, "ne", 60, -40, screen)).toEqual({
    x: 300,
    y: 160,
    width: 500,
    height: 520,
  });
  expect(resizeTraceWindow(frame, "sw", -60, 40, screen)).toEqual({
    x: 240,
    y: 200,
    width: 500,
    height: 520,
  });
});

test("a corner pulled past a limit stops the window instead of sliding it", () => {
  const frame = { x: 300, y: 200, width: 440, height: 480 };
  // Squeezed past the minimum from the top-left: the bottom-right is still the anchor.
  const squeezed = resizeTraceWindow(frame, "nw", 900, 900, screen);
  expect(squeezed).toEqual({
    x: 740 - TRACE_WINDOW_MIN_WIDTH,
    y: 680 - TRACE_WINDOW_MIN_HEIGHT,
    width: TRACE_WINDOW_MIN_WIDTH,
    height: TRACE_WINDOW_MIN_HEIGHT,
  });
  // Dragged off the top-left of the screen: it grows up to the edge and no further.
  expect(resizeTraceWindow(frame, "nw", -900, -900, screen)).toEqual({
    x: 8,
    y: 8,
    width: 732,
    height: 672,
  });
  // And off the bottom-right of the screen.
  expect(resizeTraceWindow(frame, "se", 900, 900, screen)).toEqual({
    x: 300,
    y: 200,
    width: 892,
    height: 592,
  });
});
