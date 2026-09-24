import { expect, test } from "bun:test";
import { parseFontSize, stepFontSize, TERMINAL_FONT_SIZE, TERMINAL_FONT_STORAGE_KEY, terminalFontSize } from "./terminal-font.svelte.ts";

test("⌘+ and ⌘− move a point at a time within bounds, ⌘0 goes back", () => {
  expect(stepFontSize(12, 1)).toBe(13);
  expect(stepFontSize(12, -1)).toBe(11);
  expect(stepFontSize(TERMINAL_FONT_SIZE.max, 1)).toBe(TERMINAL_FONT_SIZE.max);
  expect(stepFontSize(TERMINAL_FONT_SIZE.min, -1)).toBe(TERMINAL_FONT_SIZE.min);
  expect(stepFontSize(20, 0)).toBe(TERMINAL_FONT_SIZE.initial);
});

test("a stored size is read back, and anything unusable is the default", () => {
  expect(parseFontSize("15")).toBe(15);
  expect(parseFontSize("99")).toBe(TERMINAL_FONT_SIZE.max);
  expect(parseFontSize(null)).toBe(TERMINAL_FONT_SIZE.initial);
  expect(parseFontSize("large")).toBe(TERMINAL_FONT_SIZE.initial);
});

test("the size is one for every terminal and is kept on this machine", () => {
  const before = terminalFontSize.current;
  try {
    terminalFontSize.step(0);
    terminalFontSize.step(1);
    expect(terminalFontSize.current).toBe(TERMINAL_FONT_SIZE.initial + 1);
    expect(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY)).toBe(String(TERMINAL_FONT_SIZE.initial + 1));
  } finally {
    terminalFontSize.current = before;
    localStorage.removeItem(TERMINAL_FONT_STORAGE_KEY);
  }
});
