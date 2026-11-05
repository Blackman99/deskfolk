import { afterEach, beforeEach, expect, test } from "bun:test";
import { flip } from "svelte/animate";
import { moveFlip } from "./move-flip.ts";

/*
 * flip reads the row's own box (`clientWidth`, `getComputedStyle`, zoom), which happy-dom leaves at
 * zero; a row laid out at its new 229px stands in for it, its transform origin in the middle.
 */
const row = { clientWidth: 229, clientHeight: 60, currentCSSZoom: 1 } as unknown as Element;
const realComputedStyle = globalThis.getComputedStyle;
beforeEach(() => {
  globalThis.getComputedStyle = (() => ({ transform: "none", transformOrigin: "114.5px 30px" })) as unknown as typeof getComputedStyle;
});
afterEach(() => {
  globalThis.getComputedStyle = realComputedStyle;
});

const box = (left: number, top: number, width: number) => new DOMRect(left, top, width, 60);
const firstFrame = (config: ReturnType<typeof flip>) => config.css?.(0, 1) ?? "";

test("a row the list's scrollbar narrowed stays still, where flip squeezed it back", () => {
  const from = box(8, 100, 244);
  const to = box(8, 100, 229);
  expect(firstFrame(flip(row, { from, to }, { duration: 240 }))).toContain("scale(1.06");
  expect(moveFlip(row, { from, to }, { duration: 240 }).duration).toBe(0);
  // And widened again when the bar goes.
  expect(moveFlip(row, { from: to, to: from }, { duration: 240 }).duration).toBe(0);
});

test("a row that moved slides from where it was, at its new size", () => {
  // Pushed down a row by a new one above it, and narrowed by the bar that row brought.
  const config = moveFlip(row, { from: box(8, 100, 244), to: box(8, 160, 229) }, { duration: 240 });
  expect(config.duration).toBe(240);
  expect(firstFrame(config)).toBe("transform:  translate(0px, -60px) scale(1, 1);");
  expect(config.css?.(1, 0)).toBe("transform:  translate(0px, 0px) scale(1, 1);");
});

test("reduced motion still lands a moved row at once", () => {
  expect(moveFlip(row, { from: box(8, 100, 229), to: box(8, 160, 229) }, { duration: 0 }).duration).toBe(0);
});
