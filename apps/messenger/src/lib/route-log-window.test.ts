import { expect, test } from "bun:test";
import { listWindow, ROUTE_ROW_ESTIMATE_PX } from "./route-log-window.ts";

const E = ROUTE_ROW_ESTIMATE_PX;

function win(over: Partial<Parameters<typeof listWindow>[0]> = {}) {
  return listWindow({
    count: 400,
    scrollTop: 0,
    viewportHeight: 600,
    heights: [],
    overscan: 2,
    ...over,
  });
}

test("an empty log renders nothing and takes no space", () => {
  expect(win({ count: 0 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 });
});

test("a list shorter than the viewport is rendered whole, with no padding", () => {
  const w = win({ count: 5 });
  expect(w.start).toBe(0);
  expect(w.end).toBe(5);
  expect(w.padTop).toBe(0);
  expect(w.padBottom).toBe(0);
  expect(w.total).toBe(5 * E);
});

test("only the visible rows plus the overscan reach the DOM", () => {
  const w = win();
  expect(w.start).toBe(0);
  // 600px viewport over 80px rows is 8 rows, plus 2 rows of overscan below.
  expect(w.end).toBeLessThanOrEqual(11);
  expect(w.end - w.start).toBeLessThan(20);
  expect(w.padTop).toBe(0);
  expect(w.padBottom).toBe((400 - w.end) * E);
});

test("padding always adds up to the full list height, wherever it is scrolled", () => {
  for (const scrollTop of [0, 500, 8000, 31_000]) {
    const w = win({ scrollTop });
    expect(w.total).toBe(400 * E);
    expect(w.padTop).toBe(w.start * E);
    expect(w.padTop + (w.end - w.start) * E + w.padBottom).toBe(w.total);
  }
});

test("scrolling into the middle moves the window and leaves space above", () => {
  const w = win({ scrollTop: 8000 });
  expect(w.start).toBeGreaterThan(90);
  expect(w.start).toBeLessThan(100);
  expect(w.padTop).toBe(w.start * E);
  expect(w.end).toBeGreaterThan(w.start);
});

test("the last screen clamps to the end of the list", () => {
  const w = win({ scrollTop: 400 * E });
  expect(w.end).toBe(400);
  expect(w.padBottom).toBe(0);
  expect(w.start).toBeLessThan(400);
});

test("scrolling past the end never runs off either edge", () => {
  const w = win({ scrollTop: 10_000_000 });
  expect(w.start).toBeGreaterThanOrEqual(0);
  expect(w.end).toBe(400);
  expect(w.padTop).toBeGreaterThanOrEqual(0);
  expect(w.padBottom).toBe(0);
});

test("a negative scrollTop is treated as the top", () => {
  expect(win({ scrollTop: -120 })).toEqual(win({ scrollTop: 0 }));
});

test("measured rows are used instead of the estimate", () => {
  const heights = [300, 300, 300, 300];
  const w = listWindow({ count: 10, scrollTop: 0, viewportHeight: 600, heights, overscan: 0 });
  // Two 300px rows already fill a 600px viewport.
  expect(w.end).toBe(2);
  expect(w.total).toBe(300 * 4 + E * 6);
});

test("a tall row above the viewport pushes the window down", () => {
  const heights = [1000];
  const w = listWindow({ count: 50, scrollTop: 1000, viewportHeight: 600, heights, overscan: 0 });
  expect(w.start).toBe(1);
  expect(w.padTop).toBe(1000);
});

test("before the first layout a first slab is still rendered", () => {
  const w = win({ viewportHeight: 0 });
  expect(w.start).toBe(0);
  expect(w.end).toBeGreaterThan(0);
});
