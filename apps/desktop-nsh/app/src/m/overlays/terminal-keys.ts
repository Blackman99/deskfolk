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
  | "copy"
  | "paste"
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

/**
 * The Windows terminal's own bar, bound the way Windows Terminal does: copy and paste, find and
 * clear move onto Ctrl+Shift so plain Ctrl+K and Ctrl+F still reach the shell (kill-line,
 * forward-search); the font keys stay plain Ctrl, next to nothing the shell gives Ctrl+= or
 * Ctrl+- a meaning of its own.
 */
export function windowsTerminalShortcut(event: Key): TerminalShortcut | null {
  if (event.metaKey || event.altKey || !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    if (key === "f") return "find";
    if (key === "k") return "clear";
    return null;
  }
  if (key === "=" || key === "+") return "font-bigger";
  if (key === "-") return "font-smaller";
  if (key === "0") return "font-reset";
  return null;
}

/**
 * What a key means with the phone's Ctrl on: the control byte a hardware Ctrl gives it. `@`, the
 * letters and `[ \ ] ^ _` are 0x40–0x5F, and Ctrl clears their top bits; Space is NUL and `?` is
 * DEL, as in every terminal. Null for a key Ctrl has no byte for; that one goes as typed.
 */
export function controlByte(data: string): string | null {
  if (data.length !== 1) return null;
  if (data === " ") return "\x00";
  if (data === "?") return "\x7f";
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : null;
}

export type Arrow = "up" | "down" | "right" | "left";

const ARROW_FINAL: Record<Arrow, string> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * An arrow the way the program on screen asked for it: `ESC O A` once it has put the cursor keys
 * in application mode (vim, less, zsh's line editor), `ESC [ A` otherwise. With Ctrl it is the
 * modified form, which has no application variant.
 */
export function arrowBytes(arrow: Arrow, mode: { application: boolean; ctrl?: boolean }): string {
  const final = ARROW_FINAL[arrow];
  if (mode.ctrl) return `\x1b[1;5${final}`;
  return `${mode.application ? "\x1bO" : "\x1b["}${final}`;
}

/**
 * Whether DEC private mode `mode` is on once `text` (the program's output) is on the screen, from
 * `current` before it: set (`ESC [ ? 1 h`, alone or among others, `ESC [ ? 1 ; 1049 h`) or reset,
 * and a full reset (`ESC c`) turns it off. The phone's key bar reads it, since NSH's `Terminal`
 * keeps its modes to itself. A sequence split across two writes is missed, which leaves the mode as
 * it was; programs send it whole.
 */
export function privateMode(text: string, mode: string, current: boolean): boolean {
  let on = current;
  for (const match of text.matchAll(/\x1b(?:\[\?([0-9;]*)([hl])|c)/g)) {
    if (match[2] === undefined) on = false;
    else if (match[1]!.split(";").includes(mode)) on = match[2] === "h";
  }
  return on;
}

/** Application cursor keys (mode 1): what the phone's arrows send (`arrowBytes`). */
export function cursorKeysMode(text: string, current: boolean): boolean {
  return privateMode(text, "1", current);
}

/** Bracketed paste (mode 2004): whether the phone's Paste wraps what it sends. */
export function bracketedPasteMode(text: string, current: boolean): boolean {
  return privateMode(text, "2004", current);
}

/** Text pasted from the phone's bar, wrapped when the program asked for bracketed pastes. */
export function pasteBytes(text: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
}
