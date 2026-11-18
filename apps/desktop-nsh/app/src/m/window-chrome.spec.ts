import { expect, test } from "bun:test";
import { windowChrome } from "./window-chrome.ts";

test("only the desktop window on macOS draws its own frame", () => {
  expect(windowChrome(true, "mac")).toBe("mac");
  expect(windowChrome(true, "windows")).toBe("system");
  expect(windowChrome(false, "mac")).toBe("system");
});
