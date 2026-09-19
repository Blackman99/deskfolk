import { describe, expect, test } from "bun:test";
import { extensionOf, looksLikeWorkspacePath, normalizeCitedPath } from "./cited-path.ts";

describe("looksLikeWorkspacePath", () => {
  test("accepts slash paths and known extensions", () => {
    expect(looksLikeWorkspacePath("out/mock.png")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts")).toBe(true);
    expect(looksLikeWorkspacePath("report.md")).toBe(true);
    expect(looksLikeWorkspacePath("notes.markdown")).toBe(true);
    expect(looksLikeWorkspacePath("./notes/a.txt")).toBe(true);
    expect(looksLikeWorkspacePath("src/ui/Home.svelte")).toBe(true);
  });

  test("rejects bare words, versions, urls, and mentions", () => {
    expect(looksLikeWorkspacePath("v1.2")).toBe(false);
    expect(looksLikeWorkspacePath("hello")).toBe(false);
    expect(looksLikeWorkspacePath("https://example.com/spec")).toBe(false);
    expect(looksLikeWorkspacePath("mailto:a@b.c")).toBe(false);
    expect(looksLikeWorkspacePath("artifact:out/a.png")).toBe(false);
    expect(looksLikeWorkspacePath("@开发")).toBe(false);
  });
});

describe("normalizeCitedPath", () => {
  test("strips angle brackets and a leading ./", () => {
    expect(normalizeCitedPath(" <out/a.png> ")).toBe("out/a.png");
    expect(normalizeCitedPath("./notes/a.txt")).toBe("notes/a.txt");
    expect(normalizeCitedPath("")).toBeNull();
  });
});

describe("extensionOf", () => {
  test("returns the lowercased suffix after the last dot", () => {
    expect(extensionOf("Main.KT")).toBe("kt");
    expect(extensionOf("out/mock.png")).toBe("png");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});
