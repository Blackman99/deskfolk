import { expect, test } from "bun:test";
import type { TauriInternals } from "./tauri.ts";
import {
  checkForUpdate,
  fetchAppVersion,
  loadIgnoredVersion,
  openExternalUrl,
  parseUpdateCheck,
  saveIgnoredVersion,
  shouldShowUpdate,
  type UpdateCheck,
  type UpdateStorage,
} from "./updates.ts";

const FULL_PAYLOAD = {
  current: "0.1.0-alpha.3",
  latest: "0.1.0-alpha.4",
  updateAvailable: true,
  releaseUrl: "https://github.com/Blackman99/real-bot/releases/tag/v0.1.0-alpha.4",
  downloadUrl: "https://github.com/Blackman99/real-bot/releases/download/v0.1.0-alpha.4/Real.Bot_0.1.0-alpha.4_aarch64.dmg",
  publishedAt: "2026-09-01T00:00:00Z",
  notes: "### Messenger\n\n- 一条更新说明。",
} satisfies UpdateCheck;

test("parseUpdateCheck round-trips a full payload", () => {
  expect(parseUpdateCheck(FULL_PAYLOAD)).toEqual(FULL_PAYLOAD);
});

test("parseUpdateCheck rejects a missing current", () => {
  const { current: _current, ...rest } = FULL_PAYLOAD;
  expect(parseUpdateCheck(rest)).toBeNull();
});

test("parseUpdateCheck rejects a non-boolean updateAvailable", () => {
  expect(parseUpdateCheck({ ...FULL_PAYLOAD, updateAvailable: "yes" })).toBeNull();
});

test("parseUpdateCheck rejects a null body", () => {
  expect(parseUpdateCheck(null)).toBeNull();
});

test("parseUpdateCheck turns non-string optional fields into null", () => {
  expect(
    parseUpdateCheck({
      current: "0.1.0",
      updateAvailable: false,
      latest: 123,
      releaseUrl: false,
      downloadUrl: {},
      publishedAt: [],
      notes: 0,
    }),
  ).toEqual({
    current: "0.1.0",
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    downloadUrl: null,
    publishedAt: null,
    notes: null,
  });
});

function fakeInternals(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): TauriInternals & { calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

test("checkForUpdate calls check_for_update with the force flag and resolves the parsed result", async () => {
  const internals = fakeInternals(async () => FULL_PAYLOAD);
  await expect(checkForUpdate(true, internals)).resolves.toEqual(FULL_PAYLOAD);
  expect(internals.calls).toEqual([{ cmd: "check_for_update", args: { force: true } }]);
});

test("checkForUpdate rejects when invoke throws", async () => {
  const internals = fakeInternals(async () => {
    throw new Error("network down");
  });
  await expect(checkForUpdate(false, internals)).rejects.toThrow("network down");
});

test("checkForUpdate rejects when the payload is invalid", async () => {
  const internals = fakeInternals(async () => ({ current: "0.1.0" }));
  await expect(checkForUpdate(false, internals)).rejects.toThrow("bad update payload");
});

test("checkForUpdate rejects with no internals or undefined invoke", async () => {
  await expect(checkForUpdate(false, undefined)).rejects.toThrow("tauri unavailable");
  await expect(checkForUpdate(false, {})).rejects.toThrow("tauri unavailable");
});

test("fetchAppVersion returns the invoked string", async () => {
  const internals = fakeInternals(async () => "0.1.0-alpha.3");
  await expect(fetchAppVersion(internals)).resolves.toBe("0.1.0-alpha.3");
});

test("fetchAppVersion returns null when invoke throws", async () => {
  const internals = fakeInternals(async () => {
    throw new Error("nope");
  });
  await expect(fetchAppVersion(internals)).resolves.toBeNull();
});

test("fetchAppVersion returns null with undefined internals", async () => {
  await expect(fetchAppVersion(undefined)).resolves.toBeNull();
});

test("openExternalUrl returns false with undefined internals", async () => {
  await expect(openExternalUrl("https://github.com/Blackman99/real-bot/", undefined)).resolves.toBe(
    false,
  );
});

test("openExternalUrl returns true and passes { url } on success", async () => {
  const internals = fakeInternals(async () => null);
  await expect(
    openExternalUrl("https://github.com/Blackman99/real-bot/releases", internals),
  ).resolves.toBe(true);
  expect(internals.calls).toEqual([
    { cmd: "open_external_url", args: { url: "https://github.com/Blackman99/real-bot/releases" } },
  ]);
});

test("openExternalUrl returns false when invoke rejects", async () => {
  const internals = fakeInternals(async () => {
    throw new Error("url not allowed");
  });
  await expect(openExternalUrl("https://evil.example/", internals)).resolves.toBe(false);
});

function mapStorage(): UpdateStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

test("loadIgnoredVersion and saveIgnoredVersion round-trip through an in-memory storage", () => {
  const storage = mapStorage();
  expect(loadIgnoredVersion(storage)).toBeNull();
  saveIgnoredVersion("0.1.0-alpha.4", storage);
  expect(loadIgnoredVersion(storage)).toBe("0.1.0-alpha.4");
});

test("saveIgnoredVersion(null) removes the stored version", () => {
  const storage = mapStorage();
  saveIgnoredVersion("0.1.0-alpha.4", storage);
  saveIgnoredVersion(null, storage);
  expect(loadIgnoredVersion(storage)).toBeNull();
});

test("null storage makes load a no-op null and save a harmless no-op", () => {
  expect(loadIgnoredVersion(null)).toBeNull();
  expect(() => saveIgnoredVersion("0.1.0-alpha.4", null)).not.toThrow();
  expect(() => saveIgnoredVersion(null, null)).not.toThrow();
});

test("shouldShowUpdate is false for a null check", () => {
  expect(shouldShowUpdate(null, null)).toBe(false);
});

test("shouldShowUpdate is false when no update is available", () => {
  expect(shouldShowUpdate({ ...FULL_PAYLOAD, updateAvailable: false }, null)).toBe(false);
});

test("shouldShowUpdate is false when the latest version is ignored", () => {
  expect(shouldShowUpdate(FULL_PAYLOAD, FULL_PAYLOAD.latest)).toBe(false);
});

test("shouldShowUpdate is true when available and unignored", () => {
  expect(shouldShowUpdate(FULL_PAYLOAD, null)).toBe(true);
});

test("shouldShowUpdate is true when the ignored version is older than the new latest", () => {
  expect(shouldShowUpdate(FULL_PAYLOAD, "0.1.0-alpha.2")).toBe(true);
});
