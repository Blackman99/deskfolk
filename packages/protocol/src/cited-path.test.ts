import { describe, expect, test } from "bun:test";
import {
  attachmentLinePaths,
  extensionOf,
  looksLikeHostAbsolutePath,
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

  test("a relative path with Windows separators is the same workspace path with slashes", () => {
    expect(normalizeCitedPath("src\\foo.ts")).toBe("src/foo.ts");
    expect(normalizeCitedPath(".\\notes\\a.txt")).toBe("notes/a.txt");
    expect(normalizeCitedPath("..\\x\\y.csv")).toBe("../x/y.csv");
    expect(normalizeCitedPath("<work\\周报 v2\\out.md>")).toBe("work/周报 v2/out.md");
    expect(normalizeCitedPath("src/ui\\Home.svelte")).toBe("src/ui/Home.svelte");
    expect(normalizeCitedPath("src\\components\\")).toBe("src/components/");
  });

  test("a Windows host path, and backslashes that are not separators, stay as written", () => {
    expect(normalizeCitedPath("C:\\Users\\me\\ws\\a.csv")).toBe("C:\\Users\\me\\ws\\a.csv");
    expect(normalizeCitedPath("C:/Users/me/ws/a.csv")).toBe("C:/Users/me/ws/a.csv");
    expect(normalizeCitedPath("\\\\server\\share\\a.csv")).toBe("\\\\server\\share\\a.csv");
    expect(normalizeCitedPath("\\d+")).toBe("\\d+");
    expect(normalizeCitedPath("a \\ b")).toBe("a \\ b");
    expect(normalizeCitedPath("a\\\\b")).toBe("a\\\\b");
    expect(normalizeCitedPath("artifact:out\\a.png")).toBe("artifact:out\\a.png");
  });
});

describe("Windows paths in citations", () => {
  test("a backslashed relative path looks like a path with a known suffix or a leading .\\", () => {
    expect(looksLikeWorkspacePath("src\\foo.ts")).toBe(true);
    expect(looksLikeWorkspacePath("a\\b.csv")).toBe(true);
    expect(looksLikeWorkspacePath(".\\build")).toBe(true);
    expect(looksLikeWorkspacePath("..\\docs")).toBe(true);
    // A registry key, an escape, a regex: text.
    expect(looksLikeWorkspacePath("HKCU\\Software\\Deskfolk")).toBe(false);
    expect(looksLikeWorkspacePath("a\\n")).toBe(false);
    expect(looksLikeWorkspacePath("\\d+")).toBe(false);
    expect(looksLikeWorkspacePath("\\\\n")).toBe(false);
  });

  test("a Windows host path is a host path, with or without a suffix", () => {
    for (const path of ["C:\\x\\y.csv", "C:\\Users\\me\\ws", "C:/Users/me/ws", "\\\\server\\share\\dir"]) {
      expect([path, looksLikeWorkspacePath(path), looksLikeHostAbsolutePath(path)]).toEqual([path, true, true]);
    }
    expect(looksLikeHostAbsolutePath("/Users/me/ws")).toBe(true);
    for (const path of ["src\\foo.ts", "src/foo.ts", "~/x", "\\x", "C:", "C:x", "\\\\server"]) {
      expect([path, looksLikeHostAbsolutePath(path)]).toEqual([path, false]);
    }
  });

  test("the attachment line shape takes backslashed paths too", () => {
    expect(attachmentLinePaths("附件：out\\mock.png")).toEqual(["out/mock.png"]);
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
