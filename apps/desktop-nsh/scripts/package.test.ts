import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { archTag, dmgName, infoPlist, MACOS_MINIMUM, productVersion, RELEASE_BUNDLE_ID, setupName, windowsFileVersion } from "./package";

/** The names every Deskfolk since 0.1 looks for (`updates.rs` `arch_tag_for`, `pick_dmg`). */
test("a release image is named the way the update check matches it", () => {
  expect(dmgName("0.5.0", "aarch64-apple-darwin")).toBe("Deskfolk_0.5.0_aarch64.dmg");
  expect(dmgName("0.5.0", "x86_64-apple-darwin")).toBe("Deskfolk_0.5.0_x64.dmg");
  expect(() => archTag("x86_64-pc-windows-msvc")).toThrow();
  // `pick_windows_installer` matches `_x64-setup.exe`.
  expect(setupName("0.5.0")).toBe("Deskfolk_0.5.0_x64-setup.exe");
});

test("the installer's file version is four numbers, a pre-release tag dropped", () => {
  expect(windowsFileVersion("0.5.0")).toBe("0.5.0.0");
  expect(windowsFileVersion("0.6.0-rc.2")).toBe("0.6.0.0");
});

/** The installer checks `CFBundleIdentifier` and `CFBundleShortVersionString` (`verify_bundle`). */
test("the release's Info.plist carries the Tauri app's id and the release's version", () => {
  const plist = infoPlist({ id: RELEASE_BUNDLE_ID, name: "Deskfolk", version: "0.5.0", minimum: MACOS_MINIMUM });
  expect(plist).toContain("<key>CFBundleIdentifier</key><string>com.real-bot.desktop</string>");
  expect(plist).toContain("<key>CFBundleShortVersionString</key><string>0.5.0</string>");
  expect(plist).toContain("<key>CFBundleExecutable</key><string>deskfolk-nsh</string>");
  expect(plist).toContain("<key>LSMinimumSystemVersion</key><string>14.0</string>");
  expect(plist).toContain("NSMicrophoneUsageDescription");
  expect(plist).toContain("<key>CFBundleIconFile</key><string>icon.icns</string>");
});

test("the version is the release's, from tauri.conf.json", () => {
  expect(productVersion(resolve(import.meta.dir, "../../.."))).toMatch(/^\d+\.\d+\.\d+/);
});
