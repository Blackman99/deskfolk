import { expect, test } from "bun:test";
import { arrowBytes, controlByte, macEditingBytes, terminalShortcut, windowsTerminalShortcut } from "./terminal-keys.ts";

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

test("the phone's Ctrl turns a key into the byte a hardware Ctrl sends", () => {
  expect(controlByte("c")).toBe("\x03");
  expect(controlByte("C")).toBe("\x03");
  expect(controlByte("r")).toBe("\x12");
  expect(controlByte("v")).toBe("\x16");
  expect(controlByte("[")).toBe("\x1b");
  expect(controlByte("@")).toBe("\x00");
  expect(controlByte(" ")).toBe("\x00");
  expect(controlByte("?")).toBe("\x7f");
  // A key Ctrl has no byte for, and anything that is not one key, go as typed.
  expect(controlByte("1")).toBeNull();
  expect(controlByte("中")).toBeNull();
  expect(controlByte("ab")).toBeNull();
  expect(controlByte("")).toBeNull();
});

test("Ctrl+Shift+letter is the Windows terminal's; plain Ctrl+K and Ctrl+F still reach the shell", () => {
  expect(windowsTerminalShortcut(key("c", { ctrlKey: true, shiftKey: true }))).toBe("copy");
  expect(windowsTerminalShortcut(key("C", { ctrlKey: true, shiftKey: true }))).toBe("copy");
  expect(windowsTerminalShortcut(key("v", { ctrlKey: true, shiftKey: true }))).toBe("paste");
  expect(windowsTerminalShortcut(key("f", { ctrlKey: true, shiftKey: true }))).toBe("find");
  expect(windowsTerminalShortcut(key("k", { ctrlKey: true, shiftKey: true }))).toBe("clear");
  // Plain Ctrl+K (kill-line) and Ctrl+F (forward-search) are the shell's.
  expect(windowsTerminalShortcut(key("k", { ctrlKey: true }))).toBeNull();
  expect(windowsTerminalShortcut(key("f", { ctrlKey: true }))).toBeNull();
});

test("the Windows font-size keys are plain Ctrl, next to nothing the shell gives them", () => {
  expect(windowsTerminalShortcut(key("=", { ctrlKey: true }))).toBe("font-bigger");
  expect(windowsTerminalShortcut(key("+", { ctrlKey: true, shiftKey: true }))).toBeNull();
  expect(windowsTerminalShortcut(key("-", { ctrlKey: true }))).toBe("font-smaller");
  expect(windowsTerminalShortcut(key("0", { ctrlKey: true }))).toBe("font-reset");
});

test("windowsTerminalShortcut answers only Ctrl — never bare, never ⌘, never Alt", () => {
  expect(windowsTerminalShortcut(key("c", { shiftKey: true }))).toBeNull();
  expect(windowsTerminalShortcut(key("c", { metaKey: true, shiftKey: true }))).toBeNull();
  expect(windowsTerminalShortcut(key("c", { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
});

test("an arrow goes the way the program on screen asked for it", () => {
  expect(arrowBytes("up", { application: false })).toBe("\x1b[A");
  expect(arrowBytes("down", { application: false })).toBe("\x1b[B");
  expect(arrowBytes("right", { application: true })).toBe("\x1bOC");
  expect(arrowBytes("left", { application: true })).toBe("\x1bOD");
  // Ctrl's form is the same in either mode.
  expect(arrowBytes("left", { application: true, ctrl: true })).toBe("\x1b[1;5D");
  expect(arrowBytes("up", { application: false, ctrl: true })).toBe("\x1b[1;5A");
});
