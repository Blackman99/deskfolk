import { expect, test } from "bun:test";
import type { TauriInternals } from "./tauri.ts";
import {
  IDLE_INSTALL,
  cancelUpdateInstall,
  canInstallUpdate,
  checkForUpdate,
  fetchAppVersion,
  formatBytes,
  installErrorCode,
  installErrorCopyKey,
  installPercent,
  installPhaseCopyKey,
  isInstallActive,
  loadIgnoredVersion,
  openExternalUrl,
  parseUpdateCheck,
  parseUpdateInstallState,
  readUpdateInstall,
  saveIgnoredVersion,
  shouldShowUpdate,
  startUpdateInstall,
  type UpdateCheck,
  type UpdateInstallState,
  type UpdateStorage,
} from "./updates.ts";

const FULL_PAYLOAD = {
  current: "0.1.0-alpha.3",
  latest: "0.1.0-alpha.4",
  updateAvailable: true,
  releaseUrl: "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0-alpha.4",
  downloadUrl: "https://github.com/Blackman99/deskfolk/releases/download/v0.1.0-alpha.4/Deskfolk_0.1.0-alpha.4_aarch64.dmg",
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
  await expect(openExternalUrl("https://github.com/Blackman99/deskfolk/", undefined)).resolves.toBe(
    false,
  );
});

test("openExternalUrl returns true and passes { url } on success", async () => {
  const internals = fakeInternals(async () => null);
  await expect(
    openExternalUrl("https://github.com/Blackman99/deskfolk/releases", internals),
  ).resolves.toBe(true);
  expect(internals.calls).toEqual([
    { cmd: "open_external_url", args: { url: "https://github.com/Blackman99/deskfolk/releases" } },
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

const DOWNLOADING = {
  phase: "downloading",
  downloaded: 4_194_304,
  total: 90_177_536,
  version: "0.1.0-alpha.4",
  error: null,
  detail: null,
} satisfies UpdateInstallState;

test("parseUpdateInstallState round-trips a running job", () => {
  expect(parseUpdateInstallState(DOWNLOADING)).toEqual(DOWNLOADING);
});

test("parseUpdateInstallState rejects a body without a known phase", () => {
  expect(parseUpdateInstallState(null)).toBeNull();
  expect(parseUpdateInstallState({ ...DOWNLOADING, phase: "uploading" })).toBeNull();
  expect(parseUpdateInstallState({ ...DOWNLOADING, phase: undefined })).toBeNull();
});

test("parseUpdateInstallState defaults a missing count and nulls junk fields", () => {
  expect(parseUpdateInstallState({ phase: "idle", downloaded: "lots", total: {} })).toEqual(
    IDLE_INSTALL,
  );
});

test("isInstallActive covers every running phase and neither resting one", () => {
  for (const phase of ["downloading", "verifying", "installing", "restarting"] as const) {
    expect(isInstallActive({ ...DOWNLOADING, phase })).toBe(true);
  }
  expect(isInstallActive(IDLE_INSTALL)).toBe(false);
  expect(isInstallActive({ ...DOWNLOADING, phase: "failed" })).toBe(false);
});

test("installPercent divides the download and fills the bar once the swap starts", () => {
  expect(installPercent({ ...DOWNLOADING, downloaded: 45_088_768 })).toBe(50);
  expect(installPercent({ ...DOWNLOADING, downloaded: 0 })).toBe(0);
  // A server that undersold the length cannot push the bar past full.
  expect(installPercent({ ...DOWNLOADING, downloaded: 999, total: 500 })).toBe(100);
  expect(installPercent({ ...DOWNLOADING, phase: "verifying", total: null })).toBe(100);
  expect(installPercent({ ...DOWNLOADING, phase: "installing", total: null })).toBe(100);
  expect(installPercent({ ...DOWNLOADING, phase: "restarting", total: null })).toBe(100);
});

test("installPercent is null without a content length, so the bar runs indeterminate", () => {
  expect(installPercent({ ...DOWNLOADING, total: null })).toBeNull();
  expect(installPercent({ ...DOWNLOADING, total: 0 })).toBeNull();
});

test("formatBytes reads as a download size", () => {
  expect(formatBytes(90_177_536)).toBe("86.0 MB");
  expect(formatBytes(1_572_864)).toBe("1.5 MB");
  expect(formatBytes(51_200)).toBe("50 KB");
  expect(formatBytes(0)).toBe("0 KB");
  expect(formatBytes(-1)).toBe("0 KB");
  expect(formatBytes(Number.NaN)).toBe("0 KB");
});

test("installErrorCode reads the code out of whatever invoke rejected with", () => {
  expect(installErrorCode("read-only")).toBe("read-only");
  expect(installErrorCode(new Error("busy"))).toBe("busy");
  expect(installErrorCode(undefined)).toBe("install-failed");
  expect(installErrorCode("")).toBe("install-failed");
  expect(installErrorCode({})).toBe("install-failed");
});

test("every phase and failure code maps to a sentence", () => {
  expect(installPhaseCopyKey("downloading")).toBe("updateDownloading");
  expect(installPhaseCopyKey("verifying")).toBe("updateVerifying");
  expect(installPhaseCopyKey("installing")).toBe("updateInstalling");
  expect(installPhaseCopyKey("restarting")).toBe("updateRestarting");
  expect(installPhaseCopyKey("idle")).toBeNull();
  expect(installPhaseCopyKey("failed")).toBeNull();

  expect(installErrorCopyKey("download-failed")).toBe("updateInstallFailedDownload");
  expect(installErrorCopyKey("verify-failed")).toBe("updateInstallFailedVerify");
  expect(installErrorCopyKey("install-failed")).toBe("updateInstallFailedInstall");
  expect(installErrorCopyKey("read-only")).toBe("updateInstallFailedReadOnly");
  expect(installErrorCopyKey("not-installed")).toBe("updateInstallFailedNotInstalled");
  // `bad-url`, `busy` and anything new get the neutral sentence.
  expect(installErrorCopyKey("bad-url")).toBe("updateInstallFailedOther");
  expect(installErrorCopyKey(null)).toBe("updateInstallFailedOther");
});

test("startUpdateInstall hands the window process the asset URL and the version", async () => {
  const internals = fakeInternals(async () => DOWNLOADING);
  await expect(
    startUpdateInstall(FULL_PAYLOAD.downloadUrl!, FULL_PAYLOAD.latest!, internals),
  ).resolves.toEqual(DOWNLOADING);
  expect(internals.calls).toEqual([
    {
      cmd: "start_update_install",
      args: { url: FULL_PAYLOAD.downloadUrl, version: FULL_PAYLOAD.latest },
    },
  ]);
});

test("startUpdateInstall rejects with the refusal code so the card can say why", async () => {
  const internals = fakeInternals(async () => {
    throw "read-only";
  });
  await expect(
    startUpdateInstall(FULL_PAYLOAD.downloadUrl!, FULL_PAYLOAD.latest!, internals),
  ).rejects.toBe("read-only");
});

test("startUpdateInstall assumes a started download when the reply is unreadable", async () => {
  const internals = fakeInternals(async () => "started");
  await expect(startUpdateInstall("url", "0.2.0", internals)).resolves.toEqual({
    ...IDLE_INSTALL,
    phase: "downloading",
    version: "0.2.0",
  });
});

test("polling and cancelling survive a window process that is not there", async () => {
  await expect(readUpdateInstall(undefined)).resolves.toBeNull();
  await expect(cancelUpdateInstall(undefined)).resolves.toEqual(IDLE_INSTALL);
  await expect(canInstallUpdate(undefined)).resolves.toBe(false);

  const throwing = fakeInternals(async () => {
    throw new Error("gone");
  });
  await expect(readUpdateInstall(throwing)).resolves.toBeNull();
  await expect(cancelUpdateInstall(throwing)).resolves.toEqual(IDLE_INSTALL);
  await expect(canInstallUpdate(throwing)).resolves.toBe(false);
});

test("canInstallUpdate only believes a literal true", async () => {
  await expect(canInstallUpdate(fakeInternals(async () => true))).resolves.toBe(true);
  await expect(canInstallUpdate(fakeInternals(async () => "yes"))).resolves.toBe(false);
});

test("cancelUpdateInstall reports the state the window process went back to", async () => {
  const internals = fakeInternals(async () => IDLE_INSTALL);
  await expect(cancelUpdateInstall(internals)).resolves.toEqual(IDLE_INSTALL);
  expect(internals.calls).toEqual([{ cmd: "cancel_update_install", args: undefined }]);
});
