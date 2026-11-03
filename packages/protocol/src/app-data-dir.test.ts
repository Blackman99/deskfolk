import { describe, expect, test } from "bun:test";
import { defaultAppDataDir } from "./app-data-dir";

describe("defaultAppDataDir", () => {
  test("macOS: unchanged Library/Application Support path, POSIX-joined", () => {
    expect(defaultAppDataDir({ platform: "darwin", env: {}, home: "/Users/dongsheng" })).toBe(
      "/Users/dongsheng/Library/Application Support/real-bot",
    );
  });

  test("linux: $XDG_DATA_HOME/real-bot, else ~/.local/share/real-bot", () => {
    expect(defaultAppDataDir({ platform: "linux", env: {}, home: "/home/dongsheng" })).toBe(
      "/home/dongsheng/.local/share/real-bot",
    );
    expect(
      defaultAppDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/data/me/" }, home: "/home/dongsheng" }),
    ).toBe("/data/me/real-bot");
  });

  test("linux: an empty or relative XDG_DATA_HOME is ignored, as the XDG spec says", () => {
    for (const XDG_DATA_HOME of ["", "relative/share"]) {
      expect(defaultAppDataDir({ platform: "linux", env: { XDG_DATA_HOME }, home: "/home/me" })).toBe(
        "/home/me/.local/share/real-bot",
      );
    }
  });

  test("win32: %LOCALAPPDATA%\\real-bot when set, backslash-joined", () => {
    expect(
      defaultAppDataDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\dongsheng\\AppData\\Local" },
        home: "C:\\Users\\dongsheng",
      }),
    ).toBe("C:\\Users\\dongsheng\\AppData\\Local\\real-bot");
  });

  test("win32: falls back to <home>\\AppData\\Local\\real-bot when LOCALAPPDATA is unset", () => {
    expect(defaultAppDataDir({ platform: "win32", env: {}, home: "C:\\Users\\dongsheng" })).toBe(
      "C:\\Users\\dongsheng\\AppData\\Local\\real-bot",
    );
  });

  test("win32: an empty LOCALAPPDATA counts as unset", () => {
    expect(
      defaultAppDataDir({ platform: "win32", env: { LOCALAPPDATA: "" }, home: "C:\\Users\\me" }),
    ).toBe("C:\\Users\\me\\AppData\\Local\\real-bot");
  });

  test("does not read REAL_BOT_DATA_DIR itself; that stays the caller's job", () => {
    expect(
      defaultAppDataDir({
        platform: "darwin",
        env: { REAL_BOT_DATA_DIR: "/somewhere/else" },
        home: "/Users/dongsheng",
      }),
    ).toBe("/Users/dongsheng/Library/Application Support/real-bot");
  });
});
