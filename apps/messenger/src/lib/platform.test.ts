import { expect, test } from "bun:test";
import { applyPlatformAttribute, desktopPlatform } from "./platform.ts";

test("userAgentData wins when it names a platform", () => {
  expect(desktopPlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })).toBe("windows");
});

test("falls back to navigator.platform, then userAgent", () => {
  expect(desktopPlatform({ platform: "MacIntel" })).toBe("mac");
  expect(desktopPlatform({ platform: "Win32" })).toBe("windows");
  expect(desktopPlatform({ platform: "Linux x86_64" })).toBe("linux");
  expect(desktopPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("windows");
  expect(desktopPlatform({})).toBe("other");
});

test("happy-dom's own navigator classifies as this machine's OS", () => {
  // The test navigator fakes `process.platform` into its UA, so on the Mac this runs on it
  // reads as "mac" — the same branch a real WKWebView takes, without a real Windows box.
  expect(desktopPlatform()).toBe("mac");
});

test("sets data-platform on the root element once", () => {
  applyPlatformAttribute("windows");
  expect(document.documentElement.dataset.platform).toBe("windows");
  applyPlatformAttribute("mac");
  expect(document.documentElement.dataset.platform).toBe("mac");
});
