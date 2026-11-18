export type ComposerImeState = {
  composing: boolean;
  endedAt: number | null;
};

export const COMPOSER_IME_IDLE: ComposerImeState = {
  composing: false,
  endedAt: null,
};

/** WebKit reports this keyCode on keydown while an IME is composing. */
export const IME_KEYCODE = 229;

/**
 * Confirming an IME candidate can fire `compositionend` and then a leftover
 * Enter. Swallow that Enter so it does not send. A later, deliberate Enter
 * is outside this window.
 */
export const COMPOSER_IME_ENTER_GRACE_MS = 100;

export type ComposerImeKeyAction = "pass" | "ignore" | "swallow";

export type ComposerImeKeyEvent = {
  isComposing: boolean;
  key: string;
  keyCode: number;
  which?: number;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

export function composerImeOnStart(): ComposerImeState {
  return { composing: true, endedAt: null };
}

export function composerImeOnUpdate(ime: ComposerImeState): ComposerImeState {
  if (ime.composing) return ime;
  return { composing: true, endedAt: null };
}

export function composerImeOnEnd(now: number): ComposerImeState {
  return { composing: false, endedAt: now };
}

export function composerImeKeyAction(
  ev: ComposerImeKeyEvent,
  ime: ComposerImeState,
  now: number,
): ComposerImeKeyAction {
  if (
    ime.composing ||
    ev.isComposing ||
    ev.keyCode === IME_KEYCODE ||
    ev.which === IME_KEYCODE ||
    ev.key === "Process"
  ) {
    return "ignore";
  }
  if (
    ev.key === "Enter" &&
    !ev.shiftKey &&
    !ev.metaKey &&
    !ev.ctrlKey &&
    ime.endedAt !== null &&
    now - ime.endedAt < COMPOSER_IME_ENTER_GRACE_MS
  ) {
    return "swallow";
  }
  return "pass";
}
