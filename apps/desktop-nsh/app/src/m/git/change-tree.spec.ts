import type { GitChangeFile } from "@real-bot/protocol";
import { expect, test } from "bun:test";
import {
  ancestorGitChangeTreeDirPaths,
  buildGitChangeTree,
  collectGitChangeTreeDirPaths,
  flattenGitChangeTreeFiles,
} from "./change-tree.ts";

function file(path: string, status: GitChangeFile["status"] = "M"): GitChangeFile {
  return {
    path,
    old_path: null,
    status,
    staged: false,
    unstaged: true,
    additions: 3,
    deletions: 1,
    binary: false,
  };
}

test("buildGitChangeTree groups files into folders, sorts dirs before files, and compacts single-child dir chains", () => {
  const tree = buildGitChangeTree([
    file("README.md"),
    file("apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx"),
    file("apps/desktop-nsh/app/src/ui/git/GitPane.tsx"),
    file("apps/desktop-nsh/app/src/m/git/change-tree.ts", "A"),
    file("package.json"),
  ]);

  expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
    "dir:apps/desktop-nsh/app/src",
    "file:package.json",
    "file:README.md",
  ]);

  const srcDir = tree[0]!;
  expect(srcDir.kind).toBe("dir");
  if (srcDir.kind !== "dir") return;
  expect(srcDir.path).toBe("apps/desktop-nsh/app/src");
  expect(srcDir.fileCount).toBe(3);
  expect(srcDir.children.map((n) => `${n.kind}:${n.name}:${n.path}`)).toEqual([
    "dir:m/git:apps/desktop-nsh/app/src/m/git",
    "dir:ui/git:apps/desktop-nsh/app/src/ui/git",
  ]);

  const uiGit = srcDir.children[1]!;
  expect(uiGit.kind).toBe("dir");
  if (uiGit.kind !== "dir") return;
  expect(uiGit.fileCount).toBe(2);
  expect(uiGit.children.map((n) => `${n.kind}:${n.name}:${n.path}`)).toEqual([
    "file:GitChangesView.tsx:apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx",
    "file:GitPane.tsx:apps/desktop-nsh/app/src/ui/git/GitPane.tsx",
  ]);
});

test("single file nested deeply compacts all ancestor folders into one folder node without merging the file", () => {
  const tree = buildGitChangeTree([file("a/b/c/file.ts")]);
  expect(tree).toHaveLength(1);
  const dir = tree[0]!;
  expect(dir.kind).toBe("dir");
  if (dir.kind !== "dir") return;
  expect(dir.name).toBe("a/b/c");
  expect(dir.path).toBe("a/b/c");
  expect(dir.fileCount).toBe(1);
  expect(dir.children).toHaveLength(1);
  expect(dir.children[0]!.kind).toBe("file");
  expect(dir.children[0]!.name).toBe("file.ts");
  expect(dir.children[0]!.path).toBe("a/b/c/file.ts");
});

test("folder with both a file and a subfolder does not compact with the subfolder", () => {
  const tree = buildGitChangeTree([file("src/index.ts"), file("src/git/view.tsx")]);
  const src = tree[0]!;
  expect(src.kind).toBe("dir");
  if (src.kind !== "dir") return;
  expect(src.name).toBe("src");
  expect(src.children.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:git", "file:index.ts"]);
});

test("flattenGitChangeTreeFiles matches visual depth-first order and ancestorGitChangeTreeDirPaths finds compacted ancestors", () => {
  const tree = buildGitChangeTree([
    file("z.md"),
    file("apps/web/src/b.ts"),
    file("apps/web/src/a.ts"),
    file("a.md"),
  ]);

  expect(flattenGitChangeTreeFiles(tree).map((f) => f.path)).toEqual([
    "apps/web/src/a.ts",
    "apps/web/src/b.ts",
    "a.md",
    "z.md",
  ]);
  expect(collectGitChangeTreeDirPaths(tree)).toEqual(["apps/web/src"]);
  expect(ancestorGitChangeTreeDirPaths(tree, "apps/web/src/b.ts")).toEqual(["apps/web/src"]);
  expect(ancestorGitChangeTreeDirPaths(tree, "a.md")).toEqual([]);
  expect(ancestorGitChangeTreeDirPaths(tree, null)).toEqual([]);
});

test("preserves both a file and a directory when their path segment collides", () => {
  const tree = buildGitChangeTree([file("foo"), file("foo/bar.ts")]);
  expect(flattenGitChangeTreeFiles(tree).map((f) => f.path)).toEqual(["foo/bar.ts", "foo"]);
});
