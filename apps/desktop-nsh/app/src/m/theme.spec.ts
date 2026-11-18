import { expect, test } from "bun:test";
import { resolveTheme, nextTheme, getStoredThemePreference, saveStoredThemePreference, THEME_STORAGE_KEY } from "./theme.ts";

test("resolveTheme logic for light, dark, and system", () => {
  // Explicit light
  expect(resolveTheme("light", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");

  // Explicit dark
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("dark", true)).toBe("dark");

  // System mode
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("system", true)).toBe("dark");
});

test("nextTheme cycles correctly: system -> light -> dark -> system", () => {
  expect(nextTheme("system")).toBe("light");
  expect(nextTheme("light")).toBe("dark");
  expect(nextTheme("dark")).toBe("system");
});

test("stored theme preference handles fallback and values safely", () => {
  // In bun test environment where window might not be defined or localStorage is mocked
  const pref = getStoredThemePreference();
  expect(["system", "light", "dark"]).toContain(pref);
});
