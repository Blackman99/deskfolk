import { expect, test } from "bun:test";
import {
  clampPreviewWidth,
  loadPreviewWidth,
  PREVIEW_DEFAULT,
  PREVIEW_MIN,
  savePreviewWidth,
} from "./preview-width.ts";

test("clampPreviewWidth keeps a floor and a share of the shell", () => {
  expect(clampPreviewWidth(100, 1200)).toBe(PREVIEW_MIN);
  expect(clampPreviewWidth(900, 1200)).toBe(Math.floor(1200 * 0.62));
  expect(clampPreviewWidth(400, 1200)).toBe(400);
  expect(clampPreviewWidth(1200)).toBe(1200);
});

test("loadPreviewWidth restores a saved width instead of shrinking to a default shell", () => {
  if (typeof window === "undefined" || !window.localStorage) {
    expect(loadPreviewWidth()).toBe(PREVIEW_DEFAULT);
    return;
  }
  savePreviewWidth(640);
  expect(loadPreviewWidth()).toBe(640);
  window.localStorage.removeItem("real-bot-preview-width");
  expect(loadPreviewWidth()).toBe(PREVIEW_DEFAULT);
});
