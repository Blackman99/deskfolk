import "../platform/install";
import { expect, test } from "nsh/test";
import { ghostPlacement } from "./workspace-drag.svelte.ts";

test("the chip rides below and right of the pointer, and flips over near an edge", () => {
  const size = { width: 80, height: 22 };
  const viewport = { width: 1440, height: 900 };
  expect(ghostPlacement({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 112, y: 112 });
  // Dropping on the composer happens at the bottom of the window.
  expect(ghostPlacement({ x: 100, y: 880 }, size, viewport)).toEqual({ x: 112, y: 846 });
  expect(ghostPlacement({ x: 1400, y: 100 }, size, viewport)).toEqual({ x: 1308, y: 112 });
  expect(ghostPlacement({ x: 2, y: 2 }, { width: 2000, height: 2000 }, viewport)).toEqual({ x: 4, y: 4 });
});
