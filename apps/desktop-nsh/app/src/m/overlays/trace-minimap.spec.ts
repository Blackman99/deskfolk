import { afterEach, expect, test } from "bun:test";
import {
  TRACE_MINIMAP_MAX,
  TRACE_MINIMAP_MIN,
  forgetTraceMinimap,
  fromMinimap,
  loadTraceMinimap,
  minimapFrame,
  minimapSize,
  onMinimap,
  saveTraceMinimap,
  viewCentredOn,
  visibleRect,
} from "./trace-minimap.ts";

afterEach(() => forgetTraceMinimap());

const pane = { width: 800, height: 600 };

test("the minimap takes the board's shape, inside its stops", () => {
  // A tall job: as high as it may be, as wide as the shape says.
  const tall = minimapSize({ width: 600, height: 2400 }, pane, 1)!;
  expect(tall.height).toBe(TRACE_MINIMAP_MAX.height);
  expect(tall.width).toBe(TRACE_MINIMAP_MIN.width);
  const wide = minimapSize({ width: 1680, height: 600 }, pane, 1)!;
  expect(wide).toEqual({ width: TRACE_MINIMAP_MAX.width, height: 60 });
  // A board all one way still leaves something to aim at.
  expect(minimapSize({ width: 3000, height: 100 }, pane, 1)!.height).toBe(TRACE_MINIMAP_MIN.height);
});

test("zoomed out past the board, the minimap takes the shape of the view instead", () => {
  // 600 × 2400 at a fifth of life size: the view spans 4000 × 3000 of the board, and the map is that
  // shape, not a strip down the middle of a tall box.
  expect(minimapSize({ width: 600, height: 2400 }, pane, 0.2)).toEqual({ width: 168, height: 126 });
  // Wider than the board only: the board's length, the view's width.
  expect(minimapSize({ width: 600, height: 2400 }, pane, 1)).toEqual(minimapSize({ width: 800, height: 2400 }, pane, 1));
});

test("a small viewport gets a smaller minimap, and one too small for a corner gets none", () => {
  expect(minimapSize({ width: 600, height: 600 }, { width: 390, height: 640 }, 1)).toEqual({ width: 117, height: 125 });
  expect(minimapSize({ width: 600, height: 600 }, { width: 260, height: 600 }, 1)).toBeNull();
  expect(minimapSize({ width: 600, height: 600 }, { width: 800, height: 180 }, 1)).toBeNull();
  expect(minimapSize({ width: 0, height: 0 }, pane, 1)).toBeNull();
});

test("the frame is the part of the board the viewport shows", () => {
  expect(visibleRect({ scale: 0.5, x: -100, y: -40 }, pane)).toEqual({ x: 200, y: 80, width: 1600, height: 1200 });
});

test("a view on the board draws the board edge to edge; a view off it keeps its frame on the map", () => {
  const board = { width: 1000, height: 2000 };
  const size = { width: 84, height: 140 };
  const inside = minimapFrame(board, { x: 100, y: 100, width: 400, height: 300 }, size);
  const whole = onMinimap(inside, { x: 0, y: 0, ...board });
  // Five pixels in from the edge the board fits, and it is centred the other way.
  expect(whole.height).toBeCloseTo(130, 6);
  expect(whole.y).toBeCloseTo(5, 6);
  expect(whole.x + whole.width / 2).toBeCloseTo(42, 6);

  // Panned off to the right and below: the board is drawn smaller, and the frame is still in view.
  const off = minimapFrame(board, { x: 1400, y: 2200, width: 400, height: 300 }, size);
  const frame = onMinimap(off, { x: 1400, y: 2200, width: 400, height: 300 });
  expect(off.scale).toBeLessThan(inside.scale);
  expect(frame.x).toBeGreaterThanOrEqual(5 - 1e-6);
  expect(frame.x + frame.width).toBeLessThanOrEqual(79 + 1e-6);
  expect(frame.y + frame.height).toBeLessThanOrEqual(135 + 1e-6);
});

test("a press on the map is the board point drawn under it, and the view centres on that point at its zoom", () => {
  const frame = minimapFrame({ width: 1000, height: 2000 }, null, { width: 84, height: 140 });
  const point = { x: 640, y: 1300 };
  const drawn = onMinimap(frame, { ...point, width: 0, height: 0 });
  const back = fromMinimap(frame, drawn);
  expect(back.x).toBeCloseTo(point.x, 6);
  expect(back.y).toBeCloseTo(point.y, 6);
  const view = viewCentredOn({ scale: 0.5, x: 0, y: 0 }, pane, point);
  expect(view).toEqual({ scale: 0.5, x: 400 - 320, y: 300 - 650 });
  const shown = visibleRect(view, pane);
  expect(shown.x + shown.width / 2).toBeCloseTo(point.x, 6);
  expect(shown.y + shown.height / 2).toBeCloseTo(point.y, 6);
});

test("the minimap is shown until it is put away, and stays away", () => {
  expect(loadTraceMinimap()).toBe(true);
  saveTraceMinimap(false);
  expect(loadTraceMinimap()).toBe(false);
  saveTraceMinimap(true);
  expect(loadTraceMinimap()).toBe(true);
});
