import { expect, test } from "nsh/test";
import { outsideAll } from "./press";

test("a press is outside when it lands in none of the boxes, and a box not measured holds nothing", () => {
  const popup = { x: 455, y: 598, width: 260, height: 92 };
  const trigger = { x: 453, y: 712, width: 140, height: 32 };
  expect(outsideAll([popup, trigger], 500, 450)).toBe(true);
  expect(outsideAll([popup, trigger], 500, 620)).toBe(false);
  expect(outsideAll([popup, trigger], 520, 728)).toBe(false);
  // The far edges are outside, as a view's frame ends there.
  expect(outsideAll([popup], 715, 620)).toBe(true);
  expect(outsideAll([popup, null, undefined], 500, 620)).toBe(false);
  expect(outsideAll([null], 500, 620)).toBe(true);
  expect(outsideAll([], 0, 0)).toBe(true);
});
