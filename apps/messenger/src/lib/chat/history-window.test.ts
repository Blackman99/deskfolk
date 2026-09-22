import { expect, test } from "bun:test";
import { HISTORY_WINDOW_INITIAL, windowForIndex, windowedItems } from "./history-window.ts";

const items = Array.from({ length: 200 }, (_, i) => i);

test("the window is the newest slice, and the whole list when it is shorter", () => {
  expect(windowedItems(items, 60)).toEqual(items.slice(140));
  expect(windowedItems(items, 200)).toBe(items);
  expect(windowedItems(items, 500)).toBe(items);
  expect(windowedItems([], 60)).toEqual([]);
});

test("a hit deeper than the window widens it, with room above, and never shrinks it", () => {
  // Item 10 of 200 is 190 from the end: the window has to reach it plus the margin.
  expect(windowForIndex(200, 10, HISTORY_WINDOW_INITIAL)).toBe(200);
  expect(windowForIndex(200, 150, HISTORY_WINDOW_INITIAL, 10)).toBe(HISTORY_WINDOW_INITIAL);
  expect(windowForIndex(200, 120, 60, 10)).toBe(90);
  // Nothing found: the window stays as it is rather than collapsing.
  expect(windowForIndex(200, -1, 120)).toBe(120);
});
