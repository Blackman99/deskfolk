import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KEYCHAIN_SERVICE, LOCAL_API_PORT } from "../../../packages/protocol/src/index.ts";
import {
  APP_ICON,
  APP_ICON_FILE,
  assertApartFromStable,
  DEV_APP_NAME,
  devDataDir,
  devInstance,
  placeAppIcon,
  stableDataDir,
} from "./dev-instance";

describe("the dev instance stays apart from the stable one", () => {
  const home = "/Users/someone";

  test("beside each platform's stable directory", () => {
    expect(devDataDir(home, { platform: "darwin", env: {} })).toBe("/Users/someone/Library/Application Support/real-bot-nsh-dev");
    expect(devDataDir("/home/a", { platform: "linux", env: {} })).toBe("/home/a/.local/share/real-bot-nsh-dev");
    expect(devDataDir("C:\\Users\\a", { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } })).toBe(
      "C:\\Users\\a\\AppData\\Local\\real-bot-nsh-dev",
    );
  });

  test("its own port, data directory and Keychain service", () => {
    const dev = devInstance(home);
    expect(dev.port).not.toBe(LOCAL_API_PORT);
    expect(dev.bind).not.toContain(String(LOCAL_API_PORT));
    expect(dev.dataDir).not.toBe(stableDataDir(home));
    expect(dev.keychainService).not.toBe(KEYCHAIN_SERVICE);
    expect(() => assertApartFromStable(dev, home)).not.toThrow();
  });

  test("refuses the stable port", () => {
    const dev = { ...devInstance(home), port: LOCAL_API_PORT, bind: `127.0.0.1:${LOCAL_API_PORT}` };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable port/);
  });

  test("refuses the stable data directory, however it is spelled", () => {
    const dev = { ...devInstance(home), dataDir: `${stableDataDir(home)}/../real-bot` };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable data directory/);
  });

  test("refuses the stable Keychain service", () => {
    const dev = { ...devInstance(home), keychainService: KEYCHAIN_SERVICE };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable Keychain service/);
  });
});

describe("the dev app wears the app's icon", () => {
  test("placed once in Resources, again only when it changes", () => {
    const app = join(mkdtempSync(join(tmpdir(), "nsh-dev-icon-")), `${DEV_APP_NAME}.app`);
    try {
      expect(placeAppIcon(app)).toBe(true);
      const placed = join(app, "Contents", "Resources", APP_ICON_FILE);
      expect(readFileSync(placed).equals(readFileSync(APP_ICON))).toBe(true);
      expect(placeAppIcon(app)).toBe(false);
      writeFileSync(placed, "stale");
      expect(placeAppIcon(app)).toBe(true);
      expect(readFileSync(placed).equals(readFileSync(APP_ICON))).toBe(true);
    } finally {
      rmSync(dirname(app), { recursive: true, force: true });
    }
  });

  test("is the icns every build wears, named in both bundles' Info.plist", () => {
    expect(readFileSync(APP_ICON).subarray(0, 4).toString("latin1")).toBe("icns");
    for (const script of ["dev.ts", "package.ts"]) {
      const source = readFileSync(join(import.meta.dir, script), "utf8");
      expect(source).toContain("<key>CFBundleIconFile</key><string>${APP_ICON_FILE}</string>");
      expect(source).toContain("placeAppIcon(");
    }
  });
});
