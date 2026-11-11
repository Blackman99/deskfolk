import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KEYCHAIN_SERVICE, LOCAL_API_BIND, LOCAL_API_PORT } from "../../../packages/protocol/src/index.ts";
import {
  APP_ICON,
  APP_ICON_FILE,
  assertApartFromStable,
  chosenInstance,
  DEV_APP_NAME,
  devDataDir,
  devInstance,
  installedRuntime,
  isInstalledCommand,
  originOf,
  placeAppIcon,
  sharedRemoteHost,
  STABLE_INSTANCE_FLAG,
  stableDataDir,
  stableInstance,
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

describe("--stable-instance: the NSH build as the one you use", () => {
  const home = "/Users/someone";

  test("only when asked for by name", () => {
    expect(chosenInstance(["bun", "dev.ts"], home)).toEqual(devInstance(home));
    expect(chosenInstance(["bun", "dev.ts", "--schedule"], home)).toEqual(devInstance(home));
    expect(chosenInstance(["bun", "dev.ts", STABLE_INSTANCE_FLAG], home)).toEqual(stableInstance(home));
  });

  test("is the stable instance's port, data directory and Keychain service", () => {
    const stable = stableInstance(home, { platform: "darwin", env: {} });
    expect(stable).toEqual({
      bind: LOCAL_API_BIND,
      port: LOCAL_API_PORT,
      dataDir: "/Users/someone/Library/Application Support/real-bot",
      keychainService: KEYCHAIN_SERVICE,
    });
    expect(originOf(stable)).toBe("http://127.0.0.1:17890");
    expect(() => assertApartFromStable(stable, home, { platform: "darwin", env: {} })).toThrow();
  });

  test("takes the installed app's runtime for what it is", () => {
    expect(isInstalledCommand("/Applications/Deskfolk.app/Contents/MacOS/real-bot-daemon --desktop-remote-channel")).toBe(true);
    expect(isInstalledCommand("/Users/someone/.bun/bin/bun apps/desktop-nsh/scripts/dev-runtime.ts --stable-instance")).toBe(false);
    expect(isInstalledCommand("")).toBe(false);
  });

  test("a dev database seeded from the stable one shares its relay host; its own does not", () => {
    const root = mkdtempSync(join(tmpdir(), "nsh-shared-remote-"));
    const make = (name: string, host?: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      if (host === undefined) return dir;
      const db = new Database(join(dir, "state.sqlite"));
      db.run("CREATE TABLE remote_host (singleton INTEGER PRIMARY KEY, host_id TEXT)");
      db.run("INSERT INTO remote_host VALUES (1, ?)", [host]);
      db.close();
      return dir;
    };
    try {
      const stable = make("stable", "H1");
      expect(sharedRemoteHost(make("seeded", "H1"), stable)).toBe("H1");
      expect(sharedRemoteHost(make("own", "H2"), stable)).toBeUndefined();
      expect(sharedRemoteHost(make("fresh"), stable)).toBeUndefined();
      expect(sharedRemoteHost(make("seeded2", "H1"), join(root, "missing"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory nobody holds has no installed runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "nsh-stable-holder-"));
    try {
      expect(installedRuntime(dir)).toBeUndefined();
      writeFileSync(join(dir, "local-api.json"), JSON.stringify({ pid: process.pid, port: LOCAL_API_PORT, token: "t" }));
      expect(installedRuntime(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
