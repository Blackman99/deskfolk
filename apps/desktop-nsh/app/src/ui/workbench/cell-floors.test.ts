/** A window too small for every pane's minimum shrinks them all alike, as the Svelte grid does. */
import { expect, test } from "nsh/test";
import { allocate } from "../../m/workbench/layout-geometry.ts";
import { cellFloors } from "./cell-floors";

test("while every minimum fits, each pane keeps its own", () => {
  expect(cellFloors([360, 360, 280], 1200)).toEqual([360, 360, 280]);
  expect(cellFloors([360, 360, 280], 1000)).toEqual([360, 360, 280]);
});

test("too small for them all, every minimum shrinks by the same ratio and they fill the branch", () => {
  // Two chats and the usage page in 778 pt (a 1100 pt window, a 320 pt sidebar, two dividers).
  const floors = cellFloors([360, 360, 280], 778);
  expect(floors.map((f) => Math.round(f * 100) / 100)).toEqual([280.08, 280.08, 217.84]);
  expect(Math.round(floors.reduce((a, b) => a + b, 0))).toBe(778);
});

test("the floors match where the dividers' handles go (allocate)", () => {
  const sizes = allocate(778, [0.36, 0.36, 0.28], [360, 360, 280]);
  const floors = cellFloors([360, 360, 280], 778);
  sizes.forEach((size, i) => expect(Math.abs(size - floors[i]!)).toBeLessThan(1));
});

test("before the workbench is measured, or with nothing to share, the minimums stand", () => {
  expect(cellFloors([360, 280], null)).toEqual([360, 280]);
  expect(cellFloors([360, 280], 0)).toEqual([0, 0]);
  expect(cellFloors([0, 0], 100)).toEqual([0, 0]);
});
