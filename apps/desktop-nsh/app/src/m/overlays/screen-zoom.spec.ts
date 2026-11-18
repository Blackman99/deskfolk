import { expect, test } from "bun:test";
import { actualZoom, boxFor, fitSize, follow, keepShown, maxZoom, panBy, zoomAround } from "./screen-zoom.ts";

const stage = { w: 400, h: 800 };
const frame = { w: 4112, h: 2658 };

test("fitted, the whole screen sits centred in the stage", () => {
  const fit = fitSize(stage, frame);
  expect(fit.w).toBe(400);
  expect(Math.round(fit.h)).toBe(259);
  const box = boxFor(stage, frame, { zoom: 1, pan: { x: 0, y: 0 } });
  expect(box.left).toBe(0);
  expect(Math.round(box.top)).toBe(Math.round((800 - fit.h) / 2));
});

test("pinching keeps the point under the fingers where it was", () => {
  const anchor = { x: 300, y: 400 };
  const before = boxFor(stage, frame, { zoom: 1, pan: { x: 0, y: 0 } });
  const pointBefore = (anchor.x - before.left) / before.width;
  const view = zoomAround(stage, frame, { zoom: 1, pan: { x: 0, y: 0 } }, anchor, 3, 10);
  const after = boxFor(stage, frame, view);
  expect(view.zoom).toBe(3);
  expect((anchor.x - after.left) / after.width).toBeCloseTo(pointBefore, 6);
  // Taller than the stage now? Not at 3× (777 px): still centred vertically.
  expect(after.height).toBeLessThan(800);
  expect(after.top).toBeGreaterThan(0);
});

test("zoom stays between the whole screen and twice actual size; pan stays on the picture", () => {
  const limit = maxZoom(stage, frame, 3);
  expect(actualZoom(stage, frame, 3)).toBeCloseTo(4112 / 3 / 400, 6);
  expect(limit).toBeCloseTo(2 * 4112 / 3 / 400, 6);
  expect(zoomAround(stage, frame, { zoom: 2, pan: { x: 0, y: 0 } }, { x: 0, y: 0 }, 0.2, limit).zoom).toBe(1);
  expect(zoomAround(stage, frame, { zoom: 2, pan: { x: 0, y: 0 } }, { x: 0, y: 0 }, 99, limit).zoom).toBeCloseTo(limit, 6);
  const far = panBy(stage, frame, { zoom: 4, pan: { x: 100, y: 0 } }, { x: -100000, y: 0 });
  expect(far.pan.x).toBe(400 * 4 - 400);
  expect(panBy(stage, frame, { zoom: 4, pan: { x: 100, y: 0 } }, { x: 500, y: 0 }).pan.x).toBe(0);
});

test("fitted, the pointer reaches every edge of the screen; zoomed, it stays inside what the stage shows", () => {
  const whole = { zoom: 1, pan: { x: 0, y: 0 } };
  // The menu bar and the corners: no margin where the picture itself ends.
  expect(keepShown(stage, frame, whole, { x: 0, y: 0 }, 40)).toEqual({ x: 0, y: 0 });
  expect(keepShown(stage, frame, whole, { x: 4111, y: 2657 }, 40)).toEqual({ x: 4111, y: 2657 });
  // 4× in, panned 400 px along: the stage shows Mac pixels 1028 to 2056 across.
  const zoomed = { zoom: 4, pan: { x: 400, y: 0 } };
  const scale = (400 * 4) / 4112;
  const left = keepShown(stage, frame, zoomed, { x: 0, y: 1300 }, 40);
  expect(left.x).toBeCloseTo((400 + 40) / scale, 6);
  expect(left.y).toBe(1300);
  expect(keepShown(stage, frame, zoomed, { x: 4000, y: 1300 }, 40).x).toBeCloseTo((400 + 400 - 40) / scale, 6);
});

test("a pointer past the edge of a zoomed view pulls the view along, just far enough", () => {
  const zoomed = { zoom: 4, pan: { x: 400, y: 0 } };
  const scale = (400 * 4) / 4112;
  // 100 CSS px past the right edge's margin.
  const point = { x: (400 + 400 - 40 + 100) / scale, y: 1300 };
  const moved = follow(stage, frame, zoomed, point, 40);
  expect(moved.pan.x).toBeCloseTo(500, 6);
  expect(moved.zoom).toBe(4);
  // Inside the view: the same view, not a copy.
  expect(follow(stage, frame, zoomed, { x: 1500, y: 1300 }, 40)).toBe(zoomed);
  // Never past the picture's own end.
  expect(follow(stage, frame, zoomed, { x: 4111, y: 1300 }, 40).pan.x).toBe(400 * 4 - 400);
  // A stored pan past the edge (the stage shrank) is followed from where the page shows it.
  expect(follow(stage, frame, { zoom: 4, pan: { x: 99999, y: 0 } }, { x: 0, y: 1300 }, 40).pan.x).toBe(0);
});
