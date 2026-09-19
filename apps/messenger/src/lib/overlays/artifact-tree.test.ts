import { expect, test } from "bun:test";
import {
  buildCitedPathTree,
  citedBundleRoot,
  collectTreePaths,
  countCitedFiles,
  expandedDirsForSelection,
  mergeWorkspaceChildren,
  workspaceEntriesToNodes,
} from "./artifact-tree.ts";

test("buildCitedPathTree nests workspace-relative paths and sorts dirs first", () => {
  const tree = buildCitedPathTree([
    "todo/src/ui.ts",
    "todo-design.md",
    "todo/src/store.ts",
    "todo/test/store.test.ts",
    "index.html",
    "brief.md",
    "todo/src/types.ts",
    "todo/src/main.ts",
  ]);
  expect(tree.map((n) => n.name)).toEqual(["todo", "brief.md", "index.html", "todo-design.md"]);
  const todo = tree[0]!;
  expect(todo.kind).toBe("dir");
  expect(todo.children?.map((n) => n.name)).toEqual(["src", "test"]);
  expect(todo.children?.[0]?.children?.map((n) => n.name)).toEqual([
    "main.ts",
    "store.ts",
    "types.ts",
    "ui.ts",
  ]);
});

test("buildCitedPathTree drops duplicates, escapes, and empty segments", () => {
  const tree = buildCitedPathTree(["a/b.ts", "a/b.ts", "../secret", "/abs.ts", ".", ""]);
  expect(collectTreePaths(tree)).toEqual(["a", "a/b.ts"]);
});

test("a nested file keeps an ancestor that was also cited as a path", () => {
  const tree = buildCitedPathTree(["todo/src", "todo/src/store.ts"]);
  expect(tree[0]?.kind).toBe("dir");
  expect(tree[0]?.children?.[0]).toMatchObject({ name: "src", kind: "dir" });
  expect(tree[0]?.children?.[0]?.children?.map((n) => n.name)).toEqual(["store.ts"]);
});

test("countCitedFiles and citedBundleRoot summarize a nested project", () => {
  const tree = buildCitedPathTree([
    "mall/web",
    "mall/server",
    "mall/ARCHITECTURE.md",
    "brief.md",
  ]);
  expect(countCitedFiles(tree)).toBe(4);
  expect(citedBundleRoot(tree)).toBe("mall");
  expect(citedBundleRoot(buildCitedPathTree(["mall/web", "mall/server"]))).toBe("mall");
  expect(citedBundleRoot(buildCitedPathTree(["a.md", "b.md", "c.md"]))).toBeNull();
});

test("expandedDirsForSelection opens ancestors of the selected file", () => {
  const tree = buildCitedPathTree(["todo/src/store.ts", "brief.md"]);
  expect([...expandedDirsForSelection(tree, "todo/src/store.ts")].sort()).toEqual(["todo", "todo/src"]);
  expect(expandedDirsForSelection(tree, "brief.md").size).toBe(0);
});

test("workspaceEntriesToNodes keeps empty dirs expandable", () => {
  const nodes = workspaceEntriesToNodes([
    { name: "src", path: "src", kind: "dir" },
    { name: "brief.md", path: "brief.md", kind: "file" },
  ]);
  expect(nodes[0]).toEqual({ name: "src", path: "src", kind: "dir", children: [] });
  expect(nodes[1]?.kind).toBe("file");
});

test("mergeWorkspaceChildren fills a directory without rewriting siblings", () => {
  const root = workspaceEntriesToNodes([
    { name: "src", path: "src", kind: "dir" },
    { name: "brief.md", path: "brief.md", kind: "file" },
  ]);
  const next = mergeWorkspaceChildren(
    root,
    "src",
    workspaceEntriesToNodes([{ name: "app.ts", path: "src/app.ts", kind: "file" }]),
    false,
  );
  expect(next[0]?.children?.map((row) => row.path)).toEqual(["src/app.ts"]);
  expect(next[1]?.path).toBe("brief.md");
});
