import { forgetStored, persistedWidth, readStored, writeStored } from "../storage.ts";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MAX = 480;
/** The avatars-only rail the list folds down to. */
export const SIDEBAR_RAIL = 64;

const width = persistedWidth({
  key: "real-bot-sidebar-width",
  min: SIDEBAR_MIN,
  default: SIDEBAR_DEFAULT,
  max: SIDEBAR_MAX,
  ratio: 0.42,
});

export function loadSidebarWidth(): number {
  return width.load();
}

export function saveSidebarWidth(w: number): void {
  width.save(w);
}

export function clampSidebarWidth(w: number, shellWidth?: number): number {
  return width.clamp(w, shellWidth);
}

const COLLAPSED_KEY = "real-bot-sidebar-collapsed";

/** Whether the desktop list is folded to its rail. Kept apart from the width, so opening it again restores that. */
export function loadSidebarCollapsed(): boolean {
  return readStored(COLLAPSED_KEY) === "1";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  if (collapsed) writeStored(COLLAPSED_KEY, "1");
  else forgetStored(COLLAPSED_KEY);
}
