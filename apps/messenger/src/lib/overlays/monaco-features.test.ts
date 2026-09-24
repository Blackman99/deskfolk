import { expect, test } from "bun:test";
import { installMonacoShortcutGuard } from "./monaco-features.ts";

test("installMonacoShortcutGuard is a no-op without window", () => {
  // happy-dom gives every test a window. Installed for real, the guard's capture listener would
  // outlive this file and swallow ⌘F in whichever test file runs after it (PdfViewer's find).
  const saved = globalThis.window;
  (globalThis as { window?: unknown }).window = undefined;
  try {
    expect(() => installMonacoShortcutGuard()).not.toThrow();
  } finally {
    globalThis.window = saved;
  }
  expect((window as unknown as { __RB_MONACO_SHORTCUT_GUARD__?: boolean }).__RB_MONACO_SHORTCUT_GUARD__).toBeUndefined();
});
