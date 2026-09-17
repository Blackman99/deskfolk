import { expect, test } from "bun:test";
import { monacoLanguageFromPath, monacoThemeName, shouldHighlightMonaco } from "./artifact-monaco.ts";
import { HIGHLIGHT_CHAR_LIMIT } from "./highlight-mount.ts";

test("monacoLanguageFromPath uses highlight-lang ids", () => {
  expect(monacoLanguageFromPath("src/app.ts")).toBe("typescript");
  expect(monacoLanguageFromPath("src/app.tsx")).toBe("tsx");
  expect(monacoLanguageFromPath("README.md")).toBe("markdown");
  expect(monacoLanguageFromPath("Cargo.toml")).toBe("toml");
  expect(monacoLanguageFromPath("notes.txt")).toBe("plaintext");
});

test("monacoThemeName follows the resolved messenger theme", () => {
  expect(monacoThemeName("light")).toBe("vitesse-light");
  expect(monacoThemeName("dark")).toBe("vitesse-dark");
});

test("shouldHighlightMonaco skips plaintext, empty, and oversized docs", () => {
  expect(shouldHighlightMonaco("const x = 1", "typescript")).toBe(true);
  expect(shouldHighlightMonaco("const x = 1", "plaintext")).toBe(false);
  expect(shouldHighlightMonaco("", "typescript")).toBe(false);
  expect(shouldHighlightMonaco("x".repeat(HIGHLIGHT_CHAR_LIMIT + 1), "typescript")).toBe(false);
});
