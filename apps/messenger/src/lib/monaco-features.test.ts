import { expect, test } from "bun:test";
import { installMonacoShortcutGuard } from "./monaco-features.ts";

test("installMonacoShortcutGuard is a no-op without window", () => {
  expect(() => installMonacoShortcutGuard()).not.toThrow();
});
