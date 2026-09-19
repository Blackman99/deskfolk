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
