import { readTauriInternals, type TauriInternals } from "./tauri.ts";

export type UpdateCheck = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  downloadUrl: string | null;
  publishedAt: string | null;
  /** The release body — this version's CHANGELOG section, which the About card renders. */
  notes: string | null;
};

export const AUTO_CHECK_DELAY_MS = 15_000;
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const IGNORED_UPDATE_KEY = "real-bot-ignored-update";

export type UpdateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseUpdateCheck(body: unknown): UpdateCheck | null {
  if (!body || typeof body !== "object") return null;
  const record = body as {
    current?: unknown;
    latest?: unknown;
    updateAvailable?: unknown;
    releaseUrl?: unknown;
    downloadUrl?: unknown;
    publishedAt?: unknown;
    notes?: unknown;
  };
  if (typeof record.current !== "string") return null;
  if (typeof record.updateAvailable !== "boolean") return null;
  return {
    current: record.current,
    latest: optionalString(record.latest),
    updateAvailable: record.updateAvailable,
    releaseUrl: optionalString(record.releaseUrl),
    downloadUrl: optionalString(record.downloadUrl),
    publishedAt: optionalString(record.publishedAt),
    notes: optionalString(record.notes),
  };
}

export async function fetchAppVersion(
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<string | null> {
  if (!internals?.invoke) return null;
  try {
    const version = await internals.invoke("app_version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(
  force: boolean,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<UpdateCheck> {
  if (!internals?.invoke) throw new Error("tauri unavailable");
  const body = await internals.invoke("check_for_update", { force });
  const parsed = parseUpdateCheck(body);
  if (!parsed) throw new Error("bad update payload");
  return parsed;
}

export async function openExternalUrl(
  url: string,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<boolean> {
  if (!internals?.invoke) return false;
  try {
    await internals.invoke("open_external_url", { url });
    return true;
  } catch {
    return false;
  }
}

export function defaultStorage(): UpdateStorage | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

export function loadIgnoredVersion(
  storage: UpdateStorage | null = defaultStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(IGNORED_UPDATE_KEY);
    return raw ? raw : null;
  } catch {
    return null;
  }
}

export function saveIgnoredVersion(
  version: string | null,
  storage: UpdateStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (version === null) {
      storage.removeItem(IGNORED_UPDATE_KEY);
    } else {
      storage.setItem(IGNORED_UPDATE_KEY, version);
    }
  } catch {
    // ignore
  }
}

export function shouldShowUpdate(check: UpdateCheck | null, ignored: string | null): boolean {
  return Boolean(check?.updateAvailable && check.latest && check.latest !== ignored);
}

/**
 * The in-app install job, polled from the window process while it runs.
 * `failed` carries a code the About card turns into a sentence; `detail` is the
 * technical line under it.
 */
export type UpdateInstallPhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "failed";

export type UpdateInstallState = {
  phase: UpdateInstallPhase;
  downloaded: number;
  total: number | null;
  version: string | null;
  error: string | null;
  detail: string | null;
};

export const IDLE_INSTALL: UpdateInstallState = {
  phase: "idle",
  downloaded: 0,
  total: null,
  version: null,
  error: null,
  detail: null,
};

/** How often the About card asks the window process where the download is. */
export const INSTALL_POLL_MS = 300;

const INSTALL_PHASES: readonly UpdateInstallPhase[] = [
  "idle",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "failed",
];

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseUpdateInstallState(body: unknown): UpdateInstallState | null {
  if (!body || typeof body !== "object") return null;
  const record = body as {
    phase?: unknown;
    downloaded?: unknown;
    total?: unknown;
    version?: unknown;
    error?: unknown;
    detail?: unknown;
  };
  const phase = INSTALL_PHASES.find((known) => known === record.phase);
  if (!phase) return null;
  return {
    phase,
    downloaded: optionalNumber(record.downloaded) ?? 0,
    total: optionalNumber(record.total),
    version: optionalString(record.version),
    error: optionalString(record.error),
    detail: optionalString(record.detail),
  };
}

/** A job is in flight: keep polling, and keep the button out of the way. */
export function isInstallActive(state: UpdateInstallState): boolean {
  return state.phase !== "idle" && state.phase !== "failed";
}

/**
 * Whole percent for the bar, or `null` when the server sent no length — the
 * bar then runs indeterminate rather than claiming a number.
 */
export function installPercent(state: UpdateInstallState): number | null {
  if (state.phase === "verifying" || state.phase === "installing" || state.phase === "restarting") {
    return 100;
  }
  if (!state.total || state.total <= 0) return null;
  return Math.round((Math.min(state.downloaded, state.total) / state.total) * 100);
}

/** `86.4 MB` — the download size next to the bar. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** The code behind a rejected command, for the sentence the card shows. */
export function installErrorCode(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "install-failed";
}

/**
 * Can this copy replace itself? False for a dev build, a bundle someone else
 * owns, and the browser — the card then offers the browser download.
 */
export async function canInstallUpdate(
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<boolean> {
  if (!internals?.invoke) return false;
  try {
    return (await internals.invoke("can_install_update")) === true;
  } catch {
    return false;
  }
}

/** Start the download. Rejects with a code (`read-only`, `busy`, …). */
export async function startUpdateInstall(
  url: string,
  version: string,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<UpdateInstallState> {
  if (!internals?.invoke) throw new Error("tauri unavailable");
  const body = await internals.invoke("start_update_install", { url, version });
  return parseUpdateInstallState(body) ?? {
    ...IDLE_INSTALL,
    phase: "downloading",
    version,
  };
}

export async function readUpdateInstall(
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<UpdateInstallState | null> {
  if (!internals?.invoke) return null;
  try {
    return parseUpdateInstallState(await internals.invoke("update_install_state"));
  } catch {
    return null;
  }
}

/** Cancel a running download, or clear a failed one. */
export async function cancelUpdateInstall(
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<UpdateInstallState> {
  if (!internals?.invoke) return IDLE_INSTALL;
  try {
    return parseUpdateInstallState(await internals.invoke("cancel_update_install")) ?? IDLE_INSTALL;
  } catch {
    return IDLE_INSTALL;
  }
}

/** The sentence the About card shows for a phase, and for a failure code. */
export type InstallPhaseCopyKey =
  | "updateDownloading"
  | "updateVerifying"
  | "updateInstalling"
  | "updateRestarting";

export function installPhaseCopyKey(phase: UpdateInstallPhase): InstallPhaseCopyKey | null {
  switch (phase) {
    case "downloading":
      return "updateDownloading";
    case "verifying":
      return "updateVerifying";
    case "installing":
      return "updateInstalling";
    case "restarting":
      return "updateRestarting";
    default:
      return null;
  }
}

export type InstallErrorCopyKey =
  | "updateInstallFailedDownload"
  | "updateInstallFailedVerify"
  | "updateInstallFailedInstall"
  | "updateInstallFailedReadOnly"
  | "updateInstallFailedNotInstalled"
  | "updateInstallFailedOther";

export function installErrorCopyKey(code: string | null): InstallErrorCopyKey {
  switch (code) {
    case "download-failed":
      return "updateInstallFailedDownload";
    case "verify-failed":
      return "updateInstallFailedVerify";
    case "install-failed":
      return "updateInstallFailedInstall";
    case "read-only":
      return "updateInstallFailedReadOnly";
    case "not-installed":
      return "updateInstallFailedNotInstalled";
    default:
      return "updateInstallFailedOther";
  }
}
