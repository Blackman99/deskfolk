import { expect, test } from "bun:test";
import { keyboardInset } from "./composer-inset.ts";

test("no visual viewport means no inset", () => {
  expect(keyboardInset(844, null)).toBe(0);
  expect(keyboardInset(844, undefined)).toBe(0);
});

test("a keyboard that covers the bottom is measured", () => {
  // iPhone 13, keyboard open: the layout viewport stays 844, the visual one is 508.
  expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
});

test("scrolled visual viewports do not count as a keyboard", () => {
  expect(keyboardInset(844, { height: 800, offsetTop: 44 })).toBe(0);
});

test("a couple of pixels of rounding is not a keyboard", () => {
  expect(keyboardInset(844, { height: 841.6, offsetTop: 0 })).toBe(0);
  expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0);
});
