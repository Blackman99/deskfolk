import { expect, test } from "bun:test";
import { formatShortcut, isAltGraph, isPrimaryModifier } from "./keymap.ts";

const mods = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
});

test("isPrimaryModifier is ⌘ on mac, Ctrl elsewhere", () => {
  expect(isPrimaryModifier(mods({ metaKey: true }), "mac")).toBe(true);
  expect(isPrimaryModifier(mods({ ctrlKey: true }), "mac")).toBe(false);
  expect(isPrimaryModifier(mods({ ctrlKey: true }), "windows")).toBe(true);
  expect(isPrimaryModifier(mods({ metaKey: true }), "windows")).toBe(false);
  expect(isPrimaryModifier(mods({ ctrlKey: true }), "linux")).toBe(true);
});

test("AltGr (Ctrl+Alt) is never a primary modifier, even on Windows", () => {
  expect(isPrimaryModifier(mods({ ctrlKey: true, altKey: true }), "windows")).toBe(false);
  // `getModifierState` is trusted over the raw keys where it exists.
  expect(
    isPrimaryModifier({ ...mods({ ctrlKey: true }), getModifierState: (k) => k === "AltGraph" }, "windows"),
  ).toBe(false);
});

test("isAltGraph reads getModifierState first, ctrlKey+altKey as the fallback", () => {
  expect(isAltGraph({ ctrlKey: true, altKey: true })).toBe(true);
  expect(isAltGraph({ ctrlKey: true, altKey: false })).toBe(false);
  expect(isAltGraph({ ctrlKey: false, altKey: false, getModifierState: () => true })).toBe(true);
  expect(isAltGraph({ ctrlKey: true, altKey: true, getModifierState: () => false })).toBe(false);
  // A double that throws on an unknown key name falls back rather than blowing up.
  expect(
    isAltGraph({
      ctrlKey: true,
      altKey: true,
      getModifierState: () => {
        throw new Error("nope");
      },
    }),
  ).toBe(true);
});

test("formatShortcut on mac keeps the caller's own glyph order", () => {
  expect(formatShortcut(["mod", "B"], "mac")).toBe("⌘B");
  expect(formatShortcut(["mod", "O"], "mac")).toBe("⌘O");
  expect(formatShortcut(["shift", "mod", "\\"], "mac")).toBe("⇧⌘\\");
  expect(formatShortcut(["mod", "\\"], "mac")).toBe("⌘\\");
  // The order the caller gives is kept exactly — this is the pre-existing global-search label.
  expect(formatShortcut(["mod", "shift", "K"], "mac")).toBe("⌘⇧K");
});

test("formatShortcut elsewhere always orders Ctrl, then Alt, then Shift, then the key", () => {
  expect(formatShortcut(["mod", "B"], "windows")).toBe("Ctrl+B");
  expect(formatShortcut(["shift", "mod", "\\"], "windows")).toBe("Ctrl+Shift+\\");
  expect(formatShortcut(["mod", "shift", "K"], "windows")).toBe("Ctrl+Shift+K");
  expect(formatShortcut(["mod", "K"], "linux")).toBe("Ctrl+K");
});

test("defaults to the platform this call is actually running on", () => {
  // happy-dom's navigator reads as "mac" here (see platform.test.ts).
  expect(formatShortcut(["mod", "B"])).toBe("⌘B");
  expect(isPrimaryModifier(mods({ metaKey: true }))).toBe(true);
});
