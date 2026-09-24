const STORAGE_KEY = "real-bot-sidebar-width";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MAX = 480;
/** The avatars-only rail the list folds down to. */
export const SIDEBAR_RAIL = 64;

export function loadSidebarWidth(): number {
  if (typeof window === "undefined" || !window.localStorage) return SIDEBAR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
    return clampSidebarWidth(n);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveSidebarWidth(width: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

export function clampSidebarWidth(
  width: number,
  shellWidth: number = Number.POSITIVE_INFINITY,
): number {
  const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.floor(shellWidth * 0.42)));
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
}

const COLLAPSED_KEY = "real-bot-sidebar-collapsed";

/** Whether the desktop list is folded to its rail. Kept apart from the width, so opening it again restores that. */
export function loadSidebarCollapsed(): boolean {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // ignore
  }
}
