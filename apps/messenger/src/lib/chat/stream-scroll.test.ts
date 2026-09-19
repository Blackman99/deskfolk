import { expect, test } from "bun:test";
import {
  distanceFromBottom,
  isNearBottom,
  maxScrollTop,
  stickAfterScroll,
  STREAM_NEAR_BOTTOM_PX,
} from "./stream-scroll.ts";

test("distanceFromBottom is the leftover pixels below the viewport", () => {
  expect(distanceFromBottom(1000, 800, 100)).toBe(100);
  expect(distanceFromBottom(1000, 900, 100)).toBe(0);
});

test("isNearBottom is true on and within the stick threshold", () => {
  expect(STREAM_NEAR_BOTTOM_PX).toBe(120);
  expect(isNearBottom(1000, 780, 100)).toBe(true);
  expect(isNearBottom(1000, 879, 100)).toBe(true);
  expect(isNearBottom(1000, 900, 100)).toBe(true);
});

test("isNearBottom is false once the user has scrolled up past the threshold", () => {
  expect(isNearBottom(1000, 779, 100)).toBe(false);
  expect(isNearBottom(1000, 0, 100)).toBe(false);
});

test("stickAfterScroll keeps a programmatic pin at the bottom", () => {
  expect(stickAfterScroll(true, true)).toEqual({ ignore: true, stick: true });
});

test("stickAfterScroll unsticks when the user leaves the bottom even during a pin", () => {
  expect(stickAfterScroll(true, false)).toEqual({ ignore: false, stick: false });
  expect(stickAfterScroll(false, false)).toEqual({ ignore: false, stick: false });
  expect(stickAfterScroll(false, true)).toEqual({ ignore: false, stick: true });
});

test("maxScrollTop is the clamped scrollTop of the last pixel", () => {
  expect(maxScrollTop(1000, 100)).toBe(900);
  expect(maxScrollTop(80, 100)).toBe(0);
});

test("stickAfterScroll keeps stick while jumping even far from the bottom", () => {
  expect(stickAfterScroll(true, false, true)).toEqual({ ignore: true, stick: true });
  expect(stickAfterScroll(false, false, true)).toEqual({ ignore: true, stick: true });
  expect(stickAfterScroll(false, true, true)).toEqual({ ignore: true, stick: true });
});
