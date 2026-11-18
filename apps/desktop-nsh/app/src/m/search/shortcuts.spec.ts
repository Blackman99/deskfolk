import { expect, test } from "bun:test";
import { matchesSearchShortcut, searchShortcutLabel } from "./shortcuts.ts";

function keyIn(selector: string | null, init: KeyboardEventInit): KeyboardEvent {
  const host = document.createElement("div");
  if (selector) host.className = selector;
  const inner = document.createElement("textarea");
  host.append(inner);
  document.body.append(host);
  const event = new KeyboardEvent("keydown", { key: "k", bubbles: true, ...init });
  Object.defineProperty(event, "target", { value: inner });
  host.remove();
  return event;
}

test("Shift makes K the app-wide search, even from inside a terminal or an editor", () => {
  expect(matchesSearchShortcut(keyIn("xterm", { metaKey: true, shiftKey: true }), "mac")).toBe(true);
  expect(matchesSearchShortcut(keyIn("monaco-editor", { ctrlKey: true, shiftKey: true }), "windows")).toBe(true);
  expect(matchesSearchShortcut(keyIn(null, { ctrlKey: true, shiftKey: true }), "windows")).toBe(true);
  // Without Shift, a terminal or an editor keeps its own K.
  expect(matchesSearchShortcut(keyIn("xterm", { metaKey: true }), "mac")).toBe(false);
  expect(matchesSearchShortcut(keyIn(null, { ctrlKey: true }), "windows")).toBe(true);
});

test("in a Windows terminal Ctrl+Shift+K is the terminal's clear, not the search", () => {
  expect(matchesSearchShortcut(keyIn("xterm", { ctrlKey: true, shiftKey: true }), "windows")).toBe(false);
  expect(matchesSearchShortcut(keyIn("xterm", { ctrlKey: true, shiftKey: true }), "linux")).toBe(false);
  // On the Mac ⌘K clears the terminal, so ⌃⇧K stays the search there.
  expect(matchesSearchShortcut(keyIn("xterm", { ctrlKey: true, shiftKey: true }), "mac")).toBe(true);
});

test("the label is the platform's own — mac keeps its pre-existing ⌘ order", () => {
  // happy-dom's navigator reads as "mac" here (see platform.test.ts).
  expect(searchShortcutLabel()).toBe("⌘K");
  expect(searchShortcutLabel(true)).toBe("⌘⇧K");
});
