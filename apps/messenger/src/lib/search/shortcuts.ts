import { formatShortcut } from "../keymap.ts";

/** Editors keep their unmodified K binding; Shift makes this the app-wide search command. */
export function matchesSearchShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return false;
  const target = event.target as Element | null;
  return event.shiftKey || !target?.closest?.('.xterm, .monaco-editor');
}

export function searchShortcutLabel(global = false): string {
  // The caller's order is the mac glyph order too — kept as ⌘⇧K, this label's order from before
  // `formatShortcut` existed.
  return global ? formatShortcut(["mod", "shift", "K"]) : formatShortcut(["mod", "K"]);
}
