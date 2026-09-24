/** Editors keep their unmodified K binding; Shift makes this the app-wide search command. */
export function matchesSearchShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return false;
  const target = event.target as Element | null;
  return event.shiftKey || !target?.closest?.('.xterm, .monaco-editor');
}

export function searchShortcutLabel(global = false): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? (global ? "⌘⇧K" : "⌘K") : (global ? "Ctrl+Shift+K" : "Ctrl+K");
}
