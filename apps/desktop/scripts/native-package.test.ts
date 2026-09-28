import { expect, test } from "bun:test";
import { assertMinimum, machOMinimums, minimumMacOS, nativeFilesFor } from "./native-package";

test("the native resource list is per-OS: Windows ships no Swift helper or credentials library", () => {
  expect(nativeFilesFor("darwin")).toEqual([
    "real-bot-daemon",
    "real-bot-runtime-helper",
    "real-bot-pty",
    "libRemoteCredentials.dylib",
  ]);
  expect(nativeFilesFor("win32")).toEqual(["real-bot-daemon.exe", "real-bot-pty.exe"]);
});

test("published macOS minimum covers every mandatory nested deployment target", () => {
  expect(minimumMacOS).toBe("13.0");
  for (const required of machOMinimums("Load command 0\n cmd LC_BUILD_VERSION\n minos 13.0\nLoad command 1\n cmd LC_VERSION_MIN_MACOSX\n version 12.0\nLoad command 2\n cmd LC_SOURCE_VERSION\n version 99.0\n")) {
    expect(() => assertMinimum(minimumMacOS, required)).not.toThrow();
  }
  for (const required of ["13.0.1", "13.1", "14.0"]) {
    expect(() => assertMinimum(minimumMacOS, required)).toThrow();
  }
  expect(() => assertMinimum("10.13", "13.0")).toThrow();
  expect(() => assertMinimum("invalid", "13.0")).toThrow();
  expect(() => machOMinimums("missing load command")).toThrow();
  expect(() => machOMinimums("cmd LC_SOURCE_VERSION\n version 99.0")).toThrow();
});
