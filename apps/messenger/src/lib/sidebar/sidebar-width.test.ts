import { expect, test } from "bun:test";
import { clampSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar-width.ts";

test("clampSidebarWidth keeps a floor, a share of the shell, and a hard cap", () => {
  expect(clampSidebarWidth(100, 1200)).toBe(SIDEBAR_MIN);
  expect(clampSidebarWidth(900, 1200)).toBe(Math.min(SIDEBAR_MAX, Math.floor(1200 * 0.42)));
  expect(clampSidebarWidth(900, 800)).toBe(Math.floor(800 * 0.42));
  expect(clampSidebarWidth(280, 1200)).toBe(280);
});
