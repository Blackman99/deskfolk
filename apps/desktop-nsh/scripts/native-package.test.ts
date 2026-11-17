import { expect, test } from "bun:test";
import { assertMinimum, machOMinimums, minimumMacOS, nativeFilesFor } from "./native-package";

test("the native resource list is per-OS: Windows ships no Swift helper or credentials library", () => {
  expect(nativeFilesFor("darwin")).toEqual([
    "real-bot-daemon",
    "real-bot-runtime-helper",
    "real-bot-pty",
    "libRemoteCredentials.dylib",
    "real-bot-rtc",
  ]);
  expect(nativeFilesFor("win32")).toEqual(["real-bot-daemon.exe", "real-bot-pty.exe", "real-bot-rtc.exe"]);
  expect(nativeFilesFor("linux")).toEqual(["real-bot-daemon", "real-bot-pty", "real-bot-rtc"]);
});

test("published macOS minimum covers every mandatory nested deployment target", () => {
  expect(minimumMacOS).toBe("14.0");
  for (const required of machOMinimums("Load command 0\n cmd LC_BUILD_VERSION\n minos 14.0\nLoad command 1\n cmd LC_VERSION_MIN_MACOSX\n version 12.0\nLoad command 2\n cmd LC_SOURCE_VERSION\n version 99.0\n")) {
    expect(() => assertMinimum(minimumMacOS, required)).not.toThrow();
  }
  for (const required of ["14.0.1", "14.1", "15.0"]) {
    expect(() => assertMinimum(minimumMacOS, required)).toThrow();
  }
  expect(() => assertMinimum("10.13", "14.0")).toThrow();
  expect(() => assertMinimum("invalid", "14.0")).toThrow();
  expect(() => machOMinimums("missing load command")).toThrow();
  expect(() => machOMinimums("cmd LC_SOURCE_VERSION\n version 99.0")).toThrow();
});
