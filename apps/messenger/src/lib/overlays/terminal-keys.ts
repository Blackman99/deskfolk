/**
 * What a keystroke in the terminal means before xterm gets it.
 *
 * xterm already sends what a Mac shell expects for ⌥←/→ (a word back and forward) and ⌥⌫ (a
 * word deleted). What it leaves alone is every ⌘ key, because on a Mac those belong to the app —
 * so the ones a Mac terminal gives meaning to are answered here, the way iTerm's "Natural Text
 * Editing" keys and Terminal.app's menu do.
 */

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The terminal's own commands, not bytes for the shell. */
export type TerminalShortcut =
  | "clear"
  | "find"
  | "find-next"
  | "find-previous"
  | "font-bigger"
  | "font-smaller"
  | "font-reset";

/**
 * The bytes a Mac editing key stands for in a readline-style prompt: ⌘←/→ to the start and end of
 * the line, ⌘⌫ everything before the cursor, ⌥⌦ the word after it.
 */
export function macEditingBytes(event: Key): string | null {
  if (event.ctrlKey || event.shiftKey) return null;
  if (event.metaKey && !event.altKey) {
    if (event.key === "ArrowLeft") return "\x01";
    if (event.key === "ArrowRight") return "\x05";
    if (event.key === "Backspace") return "\x15";
    return null;
  }
  if (event.altKey && !event.metaKey && event.key === "Delete") return "\x1bd";
  return null;
}

/** ⌘K, ⌘F, ⌘G and the font size keys, with no other modifier than the Shift some of them take. */
export function terminalShortcut(event: Key): TerminalShortcut | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "g") return event.shiftKey ? "find-previous" : "find-next";
  // ⌘+ is ⌘= on most layouts, and ⌘⇧= on the rest.
  if (key === "=" || key === "+") return "font-bigger";
  if (event.shiftKey) return null;
  if (key === "k") return "clear";
  if (key === "f") return "find";
  if (key === "-") return "font-smaller";
  if (key === "0") return "font-reset";
  return null;
}
