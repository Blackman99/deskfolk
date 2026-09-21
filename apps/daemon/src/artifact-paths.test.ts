import { describe, expect, test } from "bun:test";
import {
  extractWorkspacePathsFromBody,
  linkifyWorkspacePaths,
  looksLikeWorkspacePath,
  writtenPathFromToolData,
  resolveBodyPathsToWorkDir,
} from "./artifact-paths";

describe("looksLikeWorkspacePath", () => {
  test("accepts slash paths and known extensions", () => {
    expect(looksLikeWorkspacePath("out/mock.png")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts")).toBe(true);
    expect(looksLikeWorkspacePath("report.md")).toBe(true);
    expect(looksLikeWorkspacePath("./notes/a.txt")).toBe(true);
  });

  test("rejects bare words, versions, urls, and mentions", () => {
    expect(looksLikeWorkspacePath("v1.2")).toBe(false);
    expect(looksLikeWorkspacePath("hello")).toBe(false);
    expect(looksLikeWorkspacePath("https://example.com/spec")).toBe(false);
    expect(looksLikeWorkspacePath("mailto:a@b.c")).toBe(false);
    expect(looksLikeWorkspacePath("@开发")).toBe(false);
  });
});

describe("extractWorkspacePathsFromBody", () => {
  test("collects markdown hrefs and backtick paths, skips urls and bare words", () => {
    const body = [
      "首页稿在 [mock](out/mock.png)，请按此切。@开发",
      "代码在 `src/ui/Home.svelte`",
      "规格 https://example.com/spec 和 [文档](https://example.com/doc)",
      "版本 `v1.2` 不是路径",
      "根目录报告 `report.md`",
    ].join("\n");
    expect(extractWorkspacePathsFromBody(body)).toEqual([
      "out/mock.png",
      "src/ui/Home.svelte",
      "report.md",
    ]);
  });

  test("dedupes and keeps first-seen order", () => {
    expect(extractWorkspacePathsFromBody("[a](out/a.png) and `out/a.png` then [b](out/b.pdf)")).toEqual([
      "out/a.png",
      "out/b.pdf",
    ]);
  });
});

describe("linkifyWorkspacePaths", () => {
  test("turns backticks and bare written paths into markdown links", () => {
    expect(linkifyWorkspacePaths("稿在 `out/mock.png`", [])).toBe("稿在 [out/mock.png](out/mock.png)");
    expect(linkifyWorkspacePaths("写了 report.md", ["report.md"])).toBe("写了 [report.md](report.md)");
  });

  test("appends written paths that the body never mentioned", () => {
    expect(linkifyWorkspacePaths("写好了", ["report.md", "out/mock.png"])).toBe(
      "写好了\n\n[report.md](report.md)\n[out/mock.png](out/mock.png)",
    );
  });

  test("does not rewrite fenced code or existing links", () => {
    const body = "见 [已有](out/a.png)\n\n```\nreport.md\n```";
    expect(linkifyWorkspacePaths(body, ["out/a.png"])).toBe(body);
  });

  test("empty body becomes just the written paths", () => {
    expect(linkifyWorkspacePaths("", ["notes/a.md"])).toBe("[notes/a.md](notes/a.md)");
  });
});

describe("writtenPathFromToolData", () => {
  test("collects path, file, output_path, and paths arrays", () => {
    expect(writtenPathFromToolData({ path: "report.md" })).toEqual(["report.md"]);
    expect(writtenPathFromToolData({ file: "out/a.png", paths: ["src/app.ts", "v1.2"] })).toEqual([
      "out/a.png",
      "src/app.ts",
    ]);
  });
});

const WORK = "work/2026-09-21-x-7f3k";
const onlyInWorkDir = (rel: string) => rel === `${WORK}/sales.csv`;

test("a path the Bot named from its shell's cwd is corrected to the one that resolves", () => {
  // What a Bot actually writes after `echo ... > sales.csv`: from the shell it is just that name.
  const body = "已写好 [sales.csv](sales.csv)。";
  expect(resolveBodyPathsToWorkDir(body, WORK, onlyInWorkDir)).toBe(
    `已写好 [${WORK}/sales.csv](${WORK}/sales.csv)。`,
  );
});

test("a path that exists at the workspace root is left exactly as written", () => {
  const body = "见 `brief.md`。";
  expect(resolveBodyPathsToWorkDir(body, WORK, (rel) => rel === "brief.md")).toBe(body);
});

test("a file nobody has made yet is left alone, not invented into the work dir", () => {
  const body = "接下来我会写 `report.md`。";
  expect(resolveBodyPathsToWorkDir(body, WORK, () => false)).toBe(body);
});

test("a path already inside the work dir is untouched", () => {
  const body = `见 [${WORK}/sales.csv](${WORK}/sales.csv)。`;
  expect(resolveBodyPathsToWorkDir(body, WORK, () => true)).toBe(body);
});

test("a turn with no work dir changes nothing", () => {
  const body = "已写好 `sales.csv`。";
  expect(resolveBodyPathsToWorkDir(body, null, onlyInWorkDir)).toBe(body);
});
