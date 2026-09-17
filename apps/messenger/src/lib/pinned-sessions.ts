export const PINNED_STORAGE_KEY = "real_bot_pinned_sessions";

export function loadPinnedIds(): string[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function savePinnedIds(ids: readonly string[]): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export function togglePinnedId(ids: readonly string[], targetId: string): string[] {
  if (ids.includes(targetId)) {
    return ids.filter((id) => id !== targetId);
  }
  return [...ids, targetId];
}

export function isSessionPinned(
  ids: readonly string[] | ReadonlySet<string>,
  sessionId: string,
): boolean {
  if (ids instanceof Set) return ids.has(sessionId);
  return (ids as readonly string[]).includes(sessionId);
}

export function cleanPinnedIds(
  ids: readonly string[],
  validSessionIds: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => validSessionIds.has(id));
}
