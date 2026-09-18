import { expect, test } from "bun:test";
import {
  applyMonacoTheme,
  MONACO_EDITOR_BASE_OPTIONS,
  monacoLanguageFromPath,
  monacoThemeName,
  registerLoadedShikiLanguages,
  shouldHighlightMonaco,
} from "./artifact-monaco.ts";
import { HIGHLIGHT_CHAR_LIMIT } from "./highlight-mount.ts";

test("monacoLanguageFromPath uses highlight-lang ids", () => {
  expect(monacoLanguageFromPath("src/app.ts")).toBe("typescript");
  expect(monacoLanguageFromPath("src/app.tsx")).toBe("tsx");
  expect(monacoLanguageFromPath("README.md")).toBe("markdown");
  expect(monacoLanguageFromPath("todo/index.html")).toBe("html");
  expect(monacoLanguageFromPath("Cargo.toml")).toBe("toml");
  expect(monacoLanguageFromPath("notes.txt")).toBe("plaintext");
});

test("monacoThemeName follows the resolved messenger theme", () => {
  expect(monacoThemeName("light")).toBe("vitesse-light");
  expect(monacoThemeName("dark")).toBe("vitesse-dark");
});

test("applyMonacoTheme sets vitesse for the app light and dark", () => {
  const applied: string[] = [];
  const monaco = { setTheme: (name: string) => applied.push(name) };
  applyMonacoTheme(monaco, "light");
  applyMonacoTheme(monaco, "dark");
  expect(applied).toEqual(["vitesse-light", "vitesse-dark"]);
});

test("shouldHighlightMonaco skips plaintext, empty, and oversized docs", () => {
  expect(shouldHighlightMonaco("const x = 1", "typescript")).toBe(true);
  expect(shouldHighlightMonaco("<h1>ok</h1>", "html")).toBe(true);
  expect(shouldHighlightMonaco("const x = 1", "plaintext")).toBe(false);
  expect(shouldHighlightMonaco("", "typescript")).toBe(false);
  expect(shouldHighlightMonaco("x".repeat(HIGHLIGHT_CHAR_LIMIT + 1), "typescript")).toBe(false);
});

test("MONACO_EDITOR_BASE_OPTIONS turns on find, folding, and matching brackets", () => {
  expect(MONACO_EDITOR_BASE_OPTIONS.folding).toBe(true);
  expect(MONACO_EDITOR_BASE_OPTIONS.showFoldingControls).toBe("always");
  expect(MONACO_EDITOR_BASE_OPTIONS.matchBrackets).toBe("always");
  expect(MONACO_EDITOR_BASE_OPTIONS.find.seedSearchStringFromSelection).toBe("always");
});

test("registerLoadedShikiLanguages adds html and its embedded langs monaco does not ship", () => {
  const registered: string[] = ["plaintext"];
  const monaco = {
    getLanguages: () => registered.map((id) => ({ id })),
    register: ({ id }: { id: string }) => {
      registered.push(id);
    },
  };
  const added = registerLoadedShikiLanguages(monaco, ["javascript", "css", "html", "js", "plaintext"]);
  expect(added).toEqual(["javascript", "css", "html", "js"]);
  expect(registered).toEqual(["plaintext", "javascript", "css", "html", "js"]);
  expect(registerLoadedShikiLanguages(monaco, ["html", "css"])).toEqual([]);
});
