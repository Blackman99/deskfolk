/**
 * X11 keysyms for what a phone sends to the Mac's screen. RFB speaks keysyms, not characters, and
 * noVNC exports no keysym table of its own (its package exposes only `rfb.js`), so the handful a
 * soft keyboard and the key row need are spelled out here.
 */
export const KEYSYM = {
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
  escape: 0xff1b,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  delete: 0xffff,
  shift: 0xffe1,
  control: 0xffe3,
  /** Option. */
  alt: 0xffe9,
  /** Command: what noVNC itself sends for a Mac keyboard's ⌘ (domkeytable's Meta). */
  command: 0xffeb,
} as const;

export type Modifier = "command" | "alt" | "control" | "shift";
export const MODIFIERS: ReadonlyArray<{ id: Modifier; label: string; name: string }> = [
  { id: "command", label: "⌘", name: "Command" },
  { id: "alt", label: "⌥", name: "Option" },
  { id: "control", label: "⌃", name: "Control" },
  { id: "shift", label: "⇧", name: "Shift" },
];

export type ScreenKey = { id: string; label: string; keysym: number };
export const SCREEN_KEYS: ReadonlyArray<ScreenKey> = [
  { id: "escape", label: "esc", keysym: KEYSYM.escape },
  { id: "tab", label: "⇥", keysym: KEYSYM.tab },
  { id: "left", label: "←", keysym: KEYSYM.left },
  { id: "up", label: "↑", keysym: KEYSYM.up },
  { id: "down", label: "↓", keysym: KEYSYM.down },
  { id: "right", label: "→", keysym: KEYSYM.right },
];

/** Latin-1 is its own keysym; anything above it is 0x01000000 + the code point (X11's rule). */
export function keysymFor(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (char === "\n" || char === "\r") return KEYSYM.enter;
  if (char === "\t") return KEYSYM.tab;
  if (code < 0x20 || code === 0x7f) return null;
  return code < 0x100 ? code : 0x01000000 + code;
}

export type SendKey = (keysym: number, down: boolean) => void;

/**
 * One key press with the armed modifiers held around it, in the order a keyboard would: modifiers
 * down, the key, then the modifiers up again in reverse.
 */
export function press(send: SendKey, keysym: number, modifiers: ReadonlyArray<Modifier> = []): void {
  for (const modifier of modifiers) send(KEYSYM[modifier], true);
  send(keysym, true);
  send(keysym, false);
  for (const modifier of [...modifiers].reverse()) send(KEYSYM[modifier], false);
}

/** Typed text, a character at a time; the first one carries any armed modifiers. */
export function typeText(send: SendKey, text: string, modifiers: ReadonlyArray<Modifier> = []): void {
  let first = true;
  for (const char of text) {
    const keysym = keysymFor(char);
    if (keysym === null) continue;
    press(send, keysym, first ? modifiers : []);
    first = false;
  }
}
