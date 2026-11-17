import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  appImageName,
  appRunScript,
  archTag,
  controlFile,
  DEB_DEPENDS,
  debianVersion,
  debName,
  dmgName,
  infoPlist,
  LINUX_DESKTOP_ENTRY,
  linuxIcons,
  MACOS_MINIMUM,
  mergeDepends,
  preinstScript,
  productVersion,
  RELEASE_BUNDLE_ID,
  setupName,
  windowsFileVersion,
} from "./package";

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
  // macOS 15 asks before an app reaches the local network: the remote screen's direct connection does.
  expect(plist).toContain("NSLocalNetworkUsageDescription");
  expect(plist).toContain("<key>CFBundleIconFile</key><string>icon.icns</string>");
});

test("the version is the release's, from this package's package.json", () => {
  expect(productVersion(resolve(import.meta.dir, "../../.."))).toMatch(/^\d+\.\d+\.\d+/);
});

test("the Linux packages are named the way the update check matches them", () => {
  // `pick_linux_package` looks for `_amd64.deb` / `_amd64.AppImage` (`linux_arch_tag_for`).
  expect(debName("0.6.0")).toBe("Deskfolk_0.6.0_amd64.deb");
  expect(appImageName("0.6.0")).toBe("Deskfolk_0.6.0_amd64.AppImage");
});

test("a pre-release's Debian version sorts before the release", () => {
  expect(debianVersion("0.6.0")).toBe("0.6.0");
  expect(debianVersion("0.6.0-rc.1")).toBe("0.6.0~rc.1");
});

test("the dependencies are one entry per package, the hand-written one winning", () => {
  const merged = mergeDepends("libc6 (>= 2.39), libgtk-4-1 (>= 4.6.0), libasound2t64 (>= 1.0)", DEB_DEPENDS);
  expect(merged).toContain("libc6 (>= 2.39)");
  expect(merged).toContain("libgtk-4-1 (>= 4.14)");
  expect(merged).not.toContain("4.6.0");
  expect(merged).toContain("libasound2t64 | libasound2");
  expect(merged).toContain("polkitd | policykit-1");
  expect(merged.match(/libgtk-4-1/g)).toHaveLength(1);
});

test("the control file upgrades the Tauri app's package in place", () => {
  const control = controlFile({ version: "0.6.0-rc.1", depends: "libc6 (>= 2.39)", installedSizeKb: 123 });
  expect(control).toContain("Package: deskfolk\n");
  expect(control).toContain("Version: 0.6.0~rc.1\n");
  expect(control).toContain("Architecture: amd64\n");
  expect(control).toContain("Section: utils\n");
  expect(control).toContain("Depends: libc6 (>= 2.39)\n");
  expect(control).toContain("Recommends: gnome-keyring | kwalletmanager, xdg-desktop-portal-gtk | xdg-desktop-portal-gnome | xdg-desktop-portal-kde, gstreamer1.0-plugins-good\n");
  expect(control).toContain("Suggests: gnome-shell-extension-appindicator, x11vnc, fonts-noto-cjk\n");
  expect(control.endsWith("\n")).toBe(true);
});

test("the desktop entry is named for the app id and the icons are all in place", () => {
  expect(LINUX_DESKTOP_ENTRY).toBe("com.real-bot.desktop.desktop");
  const assets = resolve(import.meta.dir, "../assets/linux");
  const entry = readFileSync(resolve(assets, LINUX_DESKTOP_ENTRY), "utf8");
  expect(entry).toContain("Name=Deskfolk\n");
  expect(entry).toContain("Exec=real-bot-desktop\n");
  expect(entry).toContain("Icon=com.real-bot.desktop\n");
  expect(entry).toContain("StartupWMClass=com.real-bot.desktop\n");
  expect(linuxIcons().map((i) => i.to)).toContain("usr/share/icons/hicolor/256x256/apps/com.real-bot.desktop.png");
  for (const icon of linuxIcons()) expect(existsSync(resolve(assets, "icons", icon.from))).toBe(true);
  expect(existsSync(resolve(assets, "com.real-bot.desktop.policy"))).toBe(true);
});

test("the preinst stops the app, then its helpers, and never fails", () => {
  const preinst = preinstScript();
  expect(preinst.startsWith("#!/bin/sh\nset -e\n")).toBe(true);
  expect(preinst).toContain("install|upgrade");
  // The shell's name is 16 characters, one past what `pkill -x` compares: it is found by command line.
  expect(preinst).toContain("pkill -TERM -f '^([^ ]*/)?real-bot-desktop( |$)' || true");
  for (const name of ["real-bot-daemon", "real-bot-pty", "real-bot-rtc"]) expect(preinst).toContain(`pkill -KILL -x ${name} || true`);
  expect(preinst).toContain("exit 0");
});

test("the AppImage's AppRun runs the shell after the AppDir's hooks", () => {
  const run = appRunScript();
  expect(run).toContain('exec "$APPDIR/usr/lib/Deskfolk/real-bot-desktop" "$@"');
  expect(run).toContain("apprun-hooks");
  expect(run).toContain('APPDIR="${APPDIR:-$HERE}"');
});
