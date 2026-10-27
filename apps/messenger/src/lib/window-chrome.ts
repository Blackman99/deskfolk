import { desktopPlatform } from "./platform.ts";
import { isTauri, readTauriInternals, type TauriInternals } from "./tauri.ts";
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

/**
 * For a drag region that scrolls (the sidebar's list, the rail). A press on its scrollbar lands on
 * the element itself, which is all Tauri checks, so grabbing the scrollbar moved the window: the
 * user's window draws classic scrollbars. For that one press the element says it is not a drag
 * region, and says so again once the event is through; the press itself goes on as before.
 */
export function scrollbarIsNotDrag(node: HTMLElement): { destroy(): void } {
  const onDown = (event: MouseEvent) => {
    const was = node.getAttribute("data-tauri-drag-region");
    if (event.target !== node || was === null) return;
    const box = node.getBoundingClientRect();
    const x = event.clientX - box.left - node.clientLeft;
    const y = event.clientY - box.top - node.clientTop;
    if (x < node.clientWidth && y < node.clientHeight) return;
    node.setAttribute("data-tauri-drag-region", "false");
    setTimeout(() => node.setAttribute("data-tauri-drag-region", was));
  };
  node.addEventListener("mousedown", onDown);
  return { destroy: () => node.removeEventListener("mousedown", onDown) };
}

/** `<html data-chrome="mac|system">`, for `window-chrome.css`. */
export function applyWindowChromeAttribute(chrome: WindowChrome = WINDOW_CHROME): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.chrome = chrome;
}

/**
 * What is behind the page: the window's frosted material (the sidebar material on macOS, Mica on
 * Windows 11) or nothing. Where there is material the page is clear and the shell paints a tinted
 * ground over it (`base.css`, `--ground-tint`); where there is none the page keeps its solid
 * ground, since a clear page over a plain window shows the desktop. The frame and the material
 * are separate questions: Windows keeps the system's title bar and still gets the material.
 */
export type WindowMaterial = "glass" | "none";

/**
 * On macOS the material is in the window's config, so the answer is known before the first paint
 * and the page never goes solid first. Everywhere else it starts as none.
 */
export function windowMaterialAtStart(chrome: WindowChrome = WINDOW_CHROME): WindowMaterial {
  return chrome === "mac" ? "glass" : "none";
}

/**
 * On Windows the window asks for Mica at startup and only Windows 11 grants it, so the page asks
 * the window what it got (`window_material`). None outside the desktop window, on macOS (which
 * has its answer already), and when the window refuses or answers with something else.
 */
export async function askWindowMaterial(
  internals: TauriInternals | undefined = readTauriInternals(),
  platform = desktopPlatform(),
): Promise<WindowMaterial> {
  if (!internals?.invoke || platform !== "windows") return "none";
  try {
    const answer = await internals.invoke("window_material");
    return answer === "glass" ? "glass" : "none";
  } catch {
    return "none";
  }
}

/** `<html data-material="glass|none">`, for the rules that let the material through. */
export function applyWindowMaterialAttribute(material: WindowMaterial): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.material = material;
}

/**
 * What the window's own appearance should be for a theme setting: the chosen one when you picked
 * light or dark, so the window's material, the native menus and (on Windows) the title bar match
 * the app rather than the system (a dark app on a light system would otherwise draw light glass
 * under light text); and `null` when the app follows the system. Pinning the window there too
 * broke following: the page reads the system's theme through the window (`prefers-color-scheme`),
 * so a pinned window never told it the system had changed.
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
