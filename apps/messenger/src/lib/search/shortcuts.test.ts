import { expect, test } from "bun:test";
import { searchShortcutLabel } from "./shortcuts.ts";

test("the label is the platform's own — mac keeps its pre-existing ⌘ order", () => {
  // happy-dom's navigator reads as "mac" here (see platform.test.ts).
  expect(searchShortcutLabel()).toBe("⌘K");
  expect(searchShortcutLabel(true)).toBe("⌘⇧K");
});
