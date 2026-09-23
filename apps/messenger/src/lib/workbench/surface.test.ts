import { expect, test } from "bun:test";
import { NARROW_MAX_WIDTH, isWorkbenchSurface } from "./surface.ts";

test("the workbench appears above the narrow breakpoint and not at or below it", () => {
  expect(isWorkbenchSurface(NARROW_MAX_WIDTH + 1)).toBe(true);
  expect(isWorkbenchSurface(NARROW_MAX_WIDTH)).toBe(false);
  expect(isWorkbenchSurface(375)).toBe(false);
  expect(isWorkbenchSurface(1440)).toBe(true);
});

test("the breakpoint is the one the stylesheet uses", () => {
  // responsive.css owns the same number; a second opinion about it is how they drift.
  expect(NARROW_MAX_WIDTH).toBe(680);
});
