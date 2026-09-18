import { expect, test } from "bun:test";
import {
  COMPOSER_IME_ENTER_GRACE_MS,
  COMPOSER_IME_IDLE,
  IME_KEYCODE,
  composerImeKeyAction,
  composerImeOnEnd,
  composerImeOnStart,
  composerImeOnUpdate,
} from "./composer-ime.ts";

function enter(
  partial: Partial<Parameters<typeof composerImeKeyAction>[0]> = {},
): Parameters<typeof composerImeKeyAction>[0] {
  return {
    isComposing: false,
    key: "Enter",
    keyCode: 13,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...partial,
  };
}

test("idle Enter is a send, not an IME key", () => {
  expect(composerImeKeyAction(enter(), COMPOSER_IME_IDLE, 1_000)).toBe("pass");
});

test("Shift+Enter and chorded Enter still pass when idle", () => {
  expect(composerImeKeyAction(enter({ shiftKey: true }), COMPOSER_IME_IDLE, 1_000)).toBe("pass");
  expect(composerImeKeyAction(enter({ metaKey: true }), COMPOSER_IME_IDLE, 1_000)).toBe("pass");
  expect(composerImeKeyAction(enter({ ctrlKey: true }), COMPOSER_IME_IDLE, 1_000)).toBe("pass");
});

test("event.isComposing blocks send even if our composing flag is off", () => {
  expect(composerImeKeyAction(enter({ isComposing: true }), COMPOSER_IME_IDLE, 1_000)).toBe(
    "ignore",
  );
});

test("WebKit IME keyCode 229 blocks send while the candidate window is open", () => {
  expect(composerImeKeyAction(enter({ keyCode: IME_KEYCODE }), COMPOSER_IME_IDLE, 1_000)).toBe(
    "ignore",
  );
  expect(
    composerImeKeyAction(
      { isComposing: false, key: "Enter", keyCode: IME_KEYCODE },
      COMPOSER_IME_IDLE,
      1_000,
    ),
  ).toBe("ignore");
  expect(composerImeKeyAction(enter({ keyCode: 13, which: IME_KEYCODE }), COMPOSER_IME_IDLE, 1_000)).toBe(
    "ignore",
  );
});

test("Firefox Process key is treated as composing", () => {
  expect(
    composerImeKeyAction({ isComposing: false, key: "Process", keyCode: 229 }, COMPOSER_IME_IDLE, 1_000),
  ).toBe("ignore");
});

test("compositionstart keeps Enter from sending until compositionend", () => {
  const ime = composerImeOnStart();
  expect(ime).toEqual({ composing: true, endedAt: null });
  expect(composerImeKeyAction(enter(), ime, 1_000)).toBe("ignore");
  expect(composerImeKeyAction(enter({ isComposing: false, keyCode: 13 }), ime, 1_000)).toBe(
    "ignore",
  );
});

test("compositionupdate starts composing if start was missed", () => {
  expect(composerImeOnUpdate(COMPOSER_IME_IDLE)).toEqual({ composing: true, endedAt: null });
  const already = composerImeOnStart();
  expect(composerImeOnUpdate(already)).toBe(already);
});

test("Enter right after compositionend is a leftover confirm, not a send", () => {
  const ended = composerImeOnEnd(1_000);
  expect(ended).toEqual({ composing: false, endedAt: 1_000 });
  expect(composerImeKeyAction(enter(), ended, 1_000)).toBe("swallow");
  expect(composerImeKeyAction(enter(), ended, 1_000 + COMPOSER_IME_ENTER_GRACE_MS - 1)).toBe(
    "swallow",
  );
});

test("a later Enter after the candidate is committed does send", () => {
  const ended = composerImeOnEnd(1_000);
  expect(
    composerImeKeyAction(enter(), ended, 1_000 + COMPOSER_IME_ENTER_GRACE_MS),
  ).toBe("pass");
});

test("Shift+Enter after compositionend still inserts a newline", () => {
  const ended = composerImeOnEnd(1_000);
  expect(composerImeKeyAction(enter({ shiftKey: true }), ended, 1_000)).toBe("pass");
});

test("⌘/Ctrl+Enter after compositionend is still a send chord", () => {
  const ended = composerImeOnEnd(1_000);
  expect(composerImeKeyAction(enter({ metaKey: true }), ended, 1_010)).toBe("pass");
  expect(composerImeKeyAction(enter({ ctrlKey: true }), ended, 1_010)).toBe("pass");
});

test("after the leftover Enter is swallowed, a later idle Enter sends", () => {
  const leftover = composerImeKeyAction(enter(), composerImeOnEnd(1_000), 1_010);
  expect(leftover).toBe("swallow");
  expect(composerImeKeyAction(enter(), COMPOSER_IME_IDLE, 1_011)).toBe("pass");
});
