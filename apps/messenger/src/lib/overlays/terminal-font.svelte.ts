/**
 * The terminal's text size: ⌘+ / ⌘− / ⌘0, one size for every terminal on this machine.
 *
 * Shared rather than per tab, so a new tab opens at the size you last chose and two shells side by
 * side do not drift apart. Kept in localStorage with the rest of this window's arrangement.
 */
export const TERMINAL_FONT_SIZE = { min: 9, max: 28, initial: 12 } as const;

export const TERMINAL_FONT_STORAGE_KEY = "real-bot-terminal-font-size";

/** One point at a time; 0 is back to where it started. */
export function stepFontSize(current: number, step: 1 | -1 | 0): number {
  if (step === 0) return TERMINAL_FONT_SIZE.initial;
  return Math.min(TERMINAL_FONT_SIZE.max, Math.max(TERMINAL_FONT_SIZE.min, Math.round(current) + step));
}

export function parseFontSize(raw: string | null): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return TERMINAL_FONT_SIZE.initial;
  return Math.min(TERMINAL_FONT_SIZE.max, Math.max(TERMINAL_FONT_SIZE.min, Math.round(value)));
}

class TerminalFontSize {
  current = $state<number>(TERMINAL_FONT_SIZE.initial);

  constructor() {
    try {
      this.current = parseFontSize(globalThis.localStorage?.getItem(TERMINAL_FONT_STORAGE_KEY) ?? null);
    } catch {
      // Storage refused; the size just does not outlive the window.
    }
  }

  step(step: 1 | -1 | 0): void {
    this.current = stepFontSize(this.current, step);
    try {
      globalThis.localStorage?.setItem(TERMINAL_FONT_STORAGE_KEY, String(this.current));
    } catch {
      // As above.
    }
  }
}

export const terminalFontSize = new TerminalFontSize();
