import { formatShortcut } from "../keymap.ts";
import { desktopPlatform, type DesktopPlatform } from "../platform.ts";

/**
 * Editors keep their unmodified K binding; Shift makes this the app-wide search command — from
 * anywhere but a terminal off the Mac, where Ctrl+Shift+K is the terminal's own clear
 * (`windowsTerminalShortcut`), beside its Ctrl+Shift+C, V and F.
 */
export function matchesSearchShortcut(event: KeyboardEvent, platform: DesktopPlatform = desktopPlatform()): boolean {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return false;
  const target = event.target as Element | null;
  if (!event.shiftKey) return !target?.closest?.('.xterm, .monaco-editor');
  return !(platform !== "mac" && event.ctrlKey && !event.metaKey && target?.closest?.(".xterm"));
}

export function searchShortcutLabel(global = false): string {
  // The caller's order is the mac glyph order too — kept as ⌘⇧K, this label's order from before
  // `formatShortcut` existed.
  return global ? formatShortcut(["mod", "shift", "K"]) : formatShortcut(["mod", "K"]);
}
