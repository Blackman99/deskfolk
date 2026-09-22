import { describe, expect, test } from "bun:test";
import {
  attachmentLinePaths,
  extensionOf,
  looksLikeWorkspacePath,
  normalizeCitedPath,
  withoutAttachmentDeclarations,
} from "./cited-path.ts";

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

describe("attachmentLinePaths", () => {
  test("collects paths written the way the transcript writes an attachment", () => {
    const body = [
      "成果已归档。",
      "附件：BEACON_ZERO/assets/storyboards/EP01/C01_START.png",
      "- 附件: BEACON_ZERO/assets/storyboards/EP01/C01_END.png",
      "附件：https://example.com/a.png",
      "正文里提到附件：但不是单独一行 out/skip.png",
    ].join("\n");
    expect(attachmentLinePaths(body)).toEqual([
      "BEACON_ZERO/assets/storyboards/EP01/C01_START.png",
      "BEACON_ZERO/assets/storyboards/EP01/C01_END.png",
    ]);
  });

  test("leaves an already-linkified handoff line alone", () => {
    const path = "out/mock.png";
    expect(attachmentLinePaths(`附件：[${path}](${path})`)).toEqual([]);
  });
});

describe("withoutAttachmentDeclarations", () => {
  test("drops raw and linkified handoff lines and keeps the report", () => {
    const path = "BEACON_ZERO/assets/storyboards/EP01/C01_START.png";
    const body = [`成果已归档。`, `附件：${path}`, `附件：[out/mock.png](out/mock.png)`, ``, `请复核。`].join("\n");
    expect(withoutAttachmentDeclarations(body)).toBe("成果已归档。\n\n请复核。");
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
