import { expect, test } from "bun:test";
import { applyWindowChromeAttribute, syncWindowTheme, windowChrome, windowTheme } from "./window-chrome.ts";

test("only the desktop window on macOS draws its own frame", () => {
  expect(windowChrome(true, "mac")).toBe("mac");
  expect(windowChrome(true, "windows")).toBe("system");
  expect(windowChrome(false, "mac")).toBe("system");
});

test("the root says which frame the page draws", () => {
  applyWindowChromeAttribute("mac");
  expect(document.documentElement.dataset.chrome).toBe("mac");
  applyWindowChromeAttribute("system");
  expect(document.documentElement.dataset.chrome).toBe("system");
});

test("a chosen theme pins the window; following the system leaves it to the system", () => {
  expect(windowTheme("dark", "dark")).toBe("dark");
  expect(windowTheme("light", "light")).toBe("light");
  expect(windowTheme("system", "dark")).toBeNull();
  expect(windowTheme("system", "light")).toBeNull();
});

test("the window is told the page's theme, and a browser tab is left alone", async () => {
  const calls: unknown[][] = [];
  const g = globalThis as { __TAURI_INTERNALS__?: unknown };
  syncWindowTheme("dark", "dark");
  expect(calls).toHaveLength(0);
  g.__TAURI_INTERNALS__ = { invoke: async (...args: unknown[]) => void calls.push(args) };
  try {
    syncWindowTheme("dark", "dark");
    syncWindowTheme("system", "light");
    await Promise.resolve();
    expect(calls).toEqual([
      ["plugin:window|set_theme", { label: "main", value: "dark" }],
      ["plugin:window|set_theme", { label: "main", value: null }],
    ]);
  } finally {
    delete g.__TAURI_INTERNALS__;
  }
});
