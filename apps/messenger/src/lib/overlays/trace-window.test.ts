import { expect, test } from "bun:test";
import {
  TRACE_WINDOW_MIN_HEIGHT,
  TRACE_WINDOW_MIN_WIDTH,
  clampTraceWindow,
  loadTraceWindow,
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
