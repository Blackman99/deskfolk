import { expect, test } from "bun:test";
import { panBy, restView, settleView, viewTransform, zoomAround, zoomLimit } from "./image-zoom.ts";

const stage = { top: 0, left: 0, width: 400, height: 800 };
// Fitted with 24 px either side, and raised by room kept under it.
const rest = { top: 200, left: 24, width: 352, height: 352 };

test("at rest the frame keeps its fitted box", () => {
  expect(viewTransform(rest, restView(rest))).toBeNull();
  expect(settleView(stage, rest, { scale: 0.5, x: 0, y: 0 })).toEqual(restView(rest));
});

test("a pinch keeps the point between the fingers where it was", () => {
  const anchor = { x: 100, y: 300 };
  const view = zoomAround(stage, rest, restView(rest), anchor, 3, 8);
  expect(view.scale).toBe(3);
  // The picture point under the fingers: 76 px in from the frame's left, 100 down.
  expect(view.x + 76 * 3).toBeCloseTo(anchor.x);
  expect(view.y + 100 * 3).toBeCloseTo(anchor.y);
});

test("zoomed in, the picture never shows a gap past an edge", () => {
  const zoomed = zoomAround(stage, rest, restView(rest), { x: 200, y: 376 }, 3, 8);
  const farRight = panBy(stage, rest, zoomed, { x: 5000, y: 0 });
  expect(farRight.x).toBe(0);
  const farLeft = panBy(stage, rest, zoomed, { x: -5000, y: 0 });
  expect(farLeft.x).toBe(400 - 352 * 3);
});

test("a side still smaller than the stage stays in proportion, not draggable", () => {
  const view = settleView(stage, rest, { scale: 1.5, x: 0, y: -999 });
  // 528 px tall in 800: the rest's share of the spare room (200 of 448) kept.
  expect(view.y).toBeCloseTo((800 - 528) * (200 / 448));
});

test("the scale stops at the limit", () => {
  expect(zoomAround(stage, rest, restView(rest), { x: 200, y: 376 }, 40, 6).scale).toBe(6);
  expect(zoomLimit(rest, 1600, 2)).toBeCloseTo(Math.max(3, (800 / 352) * 2));
  expect(zoomLimit(rest, 200, 2)).toBe(3);
});
