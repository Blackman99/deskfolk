import { desktopPlatform } from "./platform.ts";
import { isTauri, readTauriInternals } from "./tauri.ts";
import type { Theme } from "@real-bot/protocol";
import type { ResolvedTheme } from "./theme.ts";

/**
 * How the desktop window frames the page. On macOS the window has no title bar of its own
 * (`tauri.macos.conf.json`: overlay title bar, traffic lights inset, the sidebar material behind a
 * transparent webview), so the page draws the frame: the lights sit at the start of the sidebar's
 * top row, the empty parts of the top rows drag the window, and the content is a card on the
 * material. Everywhere else (Windows, the browser, the phone) the system frames the window and
 * this is `"system"`.
 */
export type WindowChrome = "mac" | "system";

export function windowChrome(tauri = isTauri(), platform = desktopPlatform()): WindowChrome {
  return tauri && platform === "mac" ? "mac" : "system";
}

/** Read once at startup: the window's frame does not change while the page lives. */
export const WINDOW_CHROME: WindowChrome = windowChrome();

/**
 * `data-tauri-drag-region` for an element whose own empty area should move the window, or nothing
 * where the system draws a title bar. Tauri drags only when the press lands on the marked element
 * itself, so its buttons and tabs keep their clicks.
 */
export const dragRegion: "" | undefined = WINDOW_CHROME === "mac" ? "" : undefined;

/** `<html data-chrome="mac|system">`, for `window-chrome.css`. */
export function applyWindowChromeAttribute(chrome: WindowChrome = WINDOW_CHROME): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.chrome = chrome;
}

/**
 * What the window's own appearance should be for a theme setting: the chosen one when you picked
 * light or dark, so the sidebar material and the native menus match the app rather than the
 * system (a dark app on a light system would otherwise draw light glass under light text); and
 * `null` when the app follows the system. Pinning the window there too broke following: the page
 * reads the system's theme through the window (`prefers-color-scheme`), so a pinned window never
 * told it the system had changed.
 */
export function windowTheme(preference: Theme, resolved: ResolvedTheme): ResolvedTheme | null {
  return preference === "system" ? null : resolved;
}

/** Sets the window's appearance (`windowTheme`). Outside the desktop window it does nothing. */
export function syncWindowTheme(preference: Theme, resolved: ResolvedTheme): void {
  const internals = readTauriInternals();
  if (!internals?.invoke) return;
  const value = windowTheme(preference, resolved);
  void internals.invoke("plugin:window|set_theme", { label: "main", value }).catch(() => {});
}
