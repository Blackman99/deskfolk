/**
 * Which installed app shares the daemon's database: the one thing that can hold the engine level
 * back (store/schema-gate.ts `raiseEngineLevel`).
 */
import { describe, expect, test } from "bun:test";
import { bundleVersion, sharedInstalledVersion } from "./installed-app";

const DEFAULT = "/Users/me/Library/Application Support/real-bot";

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Deskfolk</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`;
}

function mac(files: Record<string, string>) {
  return (path: string) => files[path] ?? null;
}

describe("the installed app that shares this database", () => {
  test("there is none for the installed app's own daemon, or a source run on a data folder of its own", () => {
    const read = mac({ "/Applications/Deskfolk.app/Contents/Info.plist": plist("0.1.0-rc.11") });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: true, platform: "darwin", home: "/Users/me", read })).toBeNull();
    expect(sharedInstalledVersion({ dataDir: "/tmp/fixture", defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read })).toBeNull();
  });

  test("a source run on the default folder answers with the oldest copy installed, or none", () => {
    const both = mac({
      "/Applications/Deskfolk.app/Contents/Info.plist": plist("0.1.0-rc.13"),
      "/Users/me/Applications/Deskfolk.app/Contents/Info.plist": plist("0.1.0-rc.11"),
    });
    expect(sharedInstalledVersion({ dataDir: `${DEFAULT}/`, defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read: both })).toEqual({
      version: "0.1.0-rc.11",
    });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read: mac({}) })).toBeNull();
  });

  test("a copy from before the rename to Deskfolk counts too: same data folder, and it cannot update itself", () => {
    const renamed = mac({
      "/Applications/Deskfolk.app/Contents/Info.plist": plist("0.1.0-rc.13"),
      "/Users/me/Applications/Real Bot.app/Contents/Info.plist": plist("0.1.0-rc.5"),
    });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read: renamed })).toEqual({
      version: "0.1.0-rc.5",
    });
    const onlyOld = mac({ "/Applications/Real Bot.app/Contents/Info.plist": plist("0.1.0-rc.3") });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read: onlyOld })).toEqual({
      version: "0.1.0-rc.3",
    });
  });

  test("one whose version cannot be read, or a platform where there is no telling, counts as too old", () => {
    const binary = mac({ "/Applications/Deskfolk.app/Contents/Info.plist": "bplist00\u0000\u0001" });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: false, platform: "darwin", home: "/Users/me", read: binary })).toEqual({
      version: "",
    });
    expect(sharedInstalledVersion({ dataDir: DEFAULT, defaultDataDir: DEFAULT, compiled: false, platform: "win32", read: mac({}) })).toEqual({
      unseen: expect.stringContaining("win32"),
    });
  });

  test("reads the version out of an XML property list", () => {
    expect(bundleVersion(plist(" 0.1.0-rc.12 "))).toBe("0.1.0-rc.12");
    expect(bundleVersion("<plist/>")).toBe("");
  });
});
