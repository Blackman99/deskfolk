import { expect, test } from "bun:test";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./sidebar-width.ts";

test("clampSidebarWidth keeps a floor, a share of the shell, and a hard cap", () => {
  expect(clampSidebarWidth(100, 1200)).toBe(SIDEBAR_MIN);
  expect(clampSidebarWidth(900, 1200)).toBe(Math.min(SIDEBAR_MAX, Math.floor(1200 * 0.42)));
  expect(clampSidebarWidth(900, 800)).toBe(Math.floor(800 * 0.42));
  expect(clampSidebarWidth(280, 1200)).toBe(280);
  expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX);
});

test("loadSidebarWidth restores a saved width instead of shrinking to a default shell", () => {
  if (typeof window === "undefined" || !window.localStorage) {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
    return;
  }
  saveSidebarWidth(400);
  expect(loadSidebarWidth()).toBe(400);
  window.localStorage.removeItem("real-bot-sidebar-width");
  expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
});
