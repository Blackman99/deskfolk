import { desktopPlatform } from "./platform.ts";
import { isTauri } from "./tauri.ts";

/**
 * How the desktop window frames the page. On macOS the window has no title bar of its own
 * (`v0.5.1:apps/desktop/src-tauri/tauri.macos.conf.json`: overlay title bar, traffic lights inset, the sidebar material behind a
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
