import { expect, test } from "bun:test";
import { macEditingBytes, terminalShortcut } from "./terminal-keys.ts";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

test("⌘←/→ and ⌘⌫ edit the line the way a Mac terminal does", () => {
  expect(macEditingBytes(key("ArrowLeft", { metaKey: true }))).toBe("\x01");
  expect(macEditingBytes(key("ArrowRight", { metaKey: true }))).toBe("\x05");
  expect(macEditingBytes(key("Backspace", { metaKey: true }))).toBe("\x15");
  expect(macEditingBytes(key("Delete", { altKey: true }))).toBe("\x1bd");
});

test("keys xterm already answers, and ones with an extra modifier, are left to it", () => {
  // ⌥←/→ and ⌥⌫ are xterm's own on a Mac; ⌘⌥← moves between panes.
  expect(macEditingBytes(key("ArrowLeft", { altKey: true }))).toBeNull();
  expect(macEditingBytes(key("Backspace", { altKey: true }))).toBeNull();
  expect(macEditingBytes(key("ArrowLeft", { metaKey: true, altKey: true }))).toBeNull();
  expect(macEditingBytes(key("ArrowLeft", { metaKey: true, shiftKey: true }))).toBeNull();
  expect(macEditingBytes(key("ArrowLeft"))).toBeNull();
  expect(macEditingBytes(key("c", { metaKey: true }))).toBeNull();
});

test("⌘K, ⌘F, ⌘G and the size keys are the terminal's; the rest of ⌘ is the app's", () => {
  expect(terminalShortcut(key("k", { metaKey: true }))).toBe("clear");
  expect(terminalShortcut(key("f", { metaKey: true }))).toBe("find");
  expect(terminalShortcut(key("g", { metaKey: true }))).toBe("find-next");
  expect(terminalShortcut(key("G", { metaKey: true, shiftKey: true }))).toBe("find-previous");
  expect(terminalShortcut(key("=", { metaKey: true }))).toBe("font-bigger");
  expect(terminalShortcut(key("+", { metaKey: true, shiftKey: true }))).toBe("font-bigger");
  expect(terminalShortcut(key("-", { metaKey: true }))).toBe("font-smaller");
  expect(terminalShortcut(key("0", { metaKey: true }))).toBe("font-reset");
  // ⌘⌥0 evens out the panes; ⌘C, ⌘V and ⌘W belong to the menus.
  expect(terminalShortcut(key("0", { metaKey: true, altKey: true }))).toBeNull();
  for (const k of ["c", "v", "w", "\\"]) expect(terminalShortcut(key(k, { metaKey: true }))).toBeNull();
  // Ctrl-K is the shell's kill-line, not a clear.
  expect(terminalShortcut(key("k", { ctrlKey: true }))).toBeNull();
  expect(terminalShortcut(key("k"))).toBeNull();
});
