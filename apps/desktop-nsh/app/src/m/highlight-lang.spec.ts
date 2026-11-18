import { expect, test } from "bun:test";
import {
  highlightLangFromClass,
  highlightLangFromPath,
  highlightLangLabel,
  normalizeHighlightLang,
} from "./highlight-lang.ts";

test("normalizeHighlightLang maps aliases and rejects unknowns", () => {
  expect(normalizeHighlightLang("ts")).toBe("typescript");
  expect(normalizeHighlightLang("TSX")).toBe("tsx");
  expect(normalizeHighlightLang("bash")).toBe("shellscript");
  expect(normalizeHighlightLang("yml")).toBe("yaml");
  expect(normalizeHighlightLang("patch")).toBe("diff");
  expect(normalizeHighlightLang("kt")).toBe("kotlin");
  expect(normalizeHighlightLang("cpp")).toBe("cpp");
  expect(normalizeHighlightLang("cs")).toBe("csharp");
  expect(normalizeHighlightLang("dockerfile")).toBe("dockerfile");
  expect(normalizeHighlightLang("tf")).toBe("terraform");
  expect(normalizeHighlightLang("unknown")).toBeNull();
  expect(normalizeHighlightLang("")).toBeNull();
});

test("highlightLangFromClass reads language- / lang- tokens", () => {
  expect(highlightLangFromClass("language-ts")).toBe("typescript");
  expect(highlightLangFromClass("hljs lang-python")).toBe("python");
  expect(highlightLangFromClass("language-not-a-lang")).toBeNull();
  expect(highlightLangFromClass("")).toBeNull();
});

test("highlightLangFromPath uses the extension and falls back to plaintext", () => {
  expect(highlightLangFromPath("todo/src/store.ts")).toBe("typescript");
  expect(highlightLangFromPath("todo/index.html")).toBe("html");
  expect(highlightLangFromPath("todo-design.md")).toBe("markdown");
  expect(highlightLangFromPath("Makefile")).toBe("makefile");
  expect(highlightLangFromPath("src/Main.kt")).toBe("kotlin");
  expect(highlightLangFromPath("Dockerfile")).toBe("dockerfile");
  expect(highlightLangFromPath("README")).toBe("plaintext");
});

test("highlightLangLabel is a short uppercase chip", () => {
  expect(highlightLangLabel("typescript")).toBe("TS");
  expect(highlightLangLabel("shellscript")).toBe("SH");
  expect(highlightLangLabel("json")).toBe("JSON");
});
