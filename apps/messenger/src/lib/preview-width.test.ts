import { expect, test } from "bun:test";
import { clampPreviewWidth, PREVIEW_MIN } from "./preview-width.ts";

test("clampPreviewWidth keeps a floor and a share of the shell", () => {
  expect(clampPreviewWidth(100, 1200)).toBe(PREVIEW_MIN);
  expect(clampPreviewWidth(900, 1200)).toBe(Math.floor(1200 * 0.62));
  expect(clampPreviewWidth(400, 1200)).toBe(400);
});
