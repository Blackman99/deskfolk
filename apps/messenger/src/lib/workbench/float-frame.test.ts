import { expect, test } from "bun:test";
import type { PaneMin } from "./layout-types.ts";
import { clampFrame, frameForTearOut, isFrame, moveFrame, resizeFrame } from "./float-frame.ts";

const viewport = { width: 1200, height: 800 };
/** The trace window's own minimum, so the cases carried over from it still mean the same thing. */
const traceMin: PaneMin = { width: 300, height: 280 };

test("a frame is pulled back inside the window", () => {
  expect(clampFrame({ x: -50, y: -50, width: 400, height: 300 }, traceMin, viewport))
    .toEqual({ x: 8, y: 8, width: 400, height: 300 });
  expect(clampFrame({ x: 5000, y: 5000, width: 400, height: 300 }, traceMin, viewport))
    .toEqual({ x: 792, y: 492, width: 400, height: 300 });
});

test("a frame is never smaller than its minimum or bigger than the window", () => {
  expect(clampFrame({ x: 10, y: 10, width: 10, height: 10 }, traceMin, viewport))
    .toEqual({ x: 10, y: 10, width: 300, height: 280 });
  const huge = clampFrame({ x: 0, y: 0, width: 9000, height: 9000 }, traceMin, viewport);
  expect(huge.width).toBe(1184);
  expect(huge.height).toBe(784);
});

test("a pane with a bigger minimum than the window still gets its minimum", () => {
  const wide: PaneMin = { width: 600, height: 200 };
  expect(clampFrame({ x: 0, y: 0, width: 100, height: 100 }, wide, { width: 400, height: 300 }).width).toBe(600);
});

test("pulling a corner anchors the one across from it", () => {
  const frame = { x: 200, y: 200, width: 400, height: 300 };
  const se = resizeFrame(frame, "se", 50, 40, traceMin, viewport);
  expect(se).toEqual({ x: 200, y: 200, width: 450, height: 340 });

  const nw = resizeFrame(frame, "nw", -50, -40, traceMin, viewport);
  // The bottom-right stayed put: 200+400 = 650 = 150+500.
  expect(nw.x + nw.width).toBe(600);
  expect(nw.y + nw.height).toBe(500);
  expect(nw).toEqual({ x: 150, y: 160, width: 450, height: 340 });
});

test("a corner pulled past the minimum stops instead of sliding the pane away", () => {
  const frame = { x: 200, y: 200, width: 400, height: 300 };
  const squeezed = resizeFrame(frame, "nw", 5000, 5000, traceMin, viewport);
  expect(squeezed.width).toBe(300);
  expect(squeezed.height).toBe(280);
  // The anchored corner did not move, which is what "stops" means here.
  expect(squeezed.x + squeezed.width).toBe(600);
  expect(squeezed.y + squeezed.height).toBe(500);
});

test("moving keeps the pane on screen", () => {
  const frame = { x: 200, y: 200, width: 400, height: 300 };
  expect(moveFrame(frame, 60, -40, traceMin, viewport)).toEqual({ x: 260, y: 160, width: 400, height: 300 });
  expect(moveFrame(frame, -5000, -5000, traceMin, viewport)).toEqual({ x: 8, y: 8, width: 400, height: 300 });
});

test("tearing a pane out lands it under the pointer, a little smaller", () => {
  const torn = frameForTearOut({ x: 0, y: 0, width: 600, height: 500 }, { x: 400, y: 300 }, traceMin, viewport);
  expect(torn.width).toBe(480);
  expect(torn.height).toBe(400);
  expect(torn.x + torn.width / 2).toBe(400);
  expect(torn.y + torn.height / 2).toBe(300);
});

test("tearing out near an edge still lands inside the window", () => {
  const torn = frameForTearOut({ x: 0, y: 0, width: 600, height: 500 }, { x: 5, y: 5 }, traceMin, viewport);
  expect(torn.x).toBe(8);
  expect(torn.y).toBe(8);
});

test("isFrame rejects anything that is not four real numbers", () => {
  expect(isFrame({ x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(isFrame({ x: 1, y: 2, width: 3 })).toBe(false);
  expect(isFrame({ x: Number.NaN, y: 2, width: 3, height: 4 })).toBe(false);
  expect(isFrame(null)).toBe(false);
  expect(isFrame("nope")).toBe(false);
});
