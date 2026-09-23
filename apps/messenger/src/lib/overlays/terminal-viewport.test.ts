import { expect, test } from "bun:test";
import { keyboardViewport } from "./terminal-viewport.ts";

test("with a keyboard up, the page is the part of the screen above it", () => {
  // An iPhone 14: 844 tall, the keyboard takes 336, and iOS has scrolled 120 to show the cursor.
  expect(keyboardViewport(844, { height: 508, offsetTop: 0, scale: 1 })).toEqual({ top: 0, height: 508 });
  expect(keyboardViewport(844, { height: 508, offsetTop: 120, scale: 1 })).toEqual({ top: 120, height: 508 });
});

test("with no keyboard, pinch-zoomed, or no visual viewport, the page stays as laid out", () => {
  expect(keyboardViewport(844, { height: 844, offsetTop: 0, scale: 1 })).toBeNull();
  // A pixel or two of rounding is not a keyboard.
  expect(keyboardViewport(844, { height: 838.5, offsetTop: 0 })).toBeNull();
  // Zoomed in, the visible part is a lens over the page, not room to shrink into.
  expect(keyboardViewport(844, { height: 422, offsetTop: 200, scale: 2 })).toBeNull();
  expect(keyboardViewport(844, null)).toBeNull();
});
