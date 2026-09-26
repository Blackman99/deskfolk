import { expect, test } from "bun:test";
import { slideForKey, slideZoom } from "./slides.ts";

const WIDE = { width: 960, height: 540 };

test("a slide fits by the narrower side of the frame", () => {
  // A tall pane: the width decides.
  expect(slideZoom({ width: 480, height: 800 }, WIDE)).toBe(50);
  // A wide, short full screen: the height decides, so nothing is cut off at the bottom.
  expect(slideZoom({ width: 1440, height: 270 }, WIDE)).toBe(50);
  // Larger than the slide itself grows it.
  expect(slideZoom({ width: 1920, height: 1080 }, WIDE)).toBe(200);
});

test("a frame or slide without a size gives no zoom", () => {
  expect(slideZoom({ width: 964, height: 0 }, WIDE)).toBeNull();
  expect(slideZoom({ width: 0, height: 0 }, WIDE)).toBeNull();
  expect(slideZoom({ width: 964, height: 540 }, { width: 0, height: 0 })).toBeNull();
});

test("arrow and page keys step one slide, Home and End go to the ends", () => {
  expect(slideForKey("ArrowRight", 2, 10)).toBe(3);
  expect(slideForKey("ArrowDown", 2, 10)).toBe(3);
  expect(slideForKey("PageDown", 2, 10)).toBe(3);
  expect(slideForKey("ArrowLeft", 2, 10)).toBe(1);
  expect(slideForKey("ArrowUp", 2, 10)).toBe(1);
  expect(slideForKey("PageUp", 2, 10)).toBe(1);
  expect(slideForKey("Home", 5, 10)).toBe(0);
  expect(slideForKey("End", 5, 10)).toBe(9);
});

test("the ends do not wrap, and other keys are left alone", () => {
  expect(slideForKey("ArrowRight", 9, 10)).toBe(9);
  expect(slideForKey("ArrowLeft", 0, 10)).toBe(0);
  expect(slideForKey(" ", 2, 10)).toBeNull();
  expect(slideForKey("a", 2, 10)).toBeNull();
  expect(slideForKey("ArrowRight", 0, 0)).toBeNull();
});
