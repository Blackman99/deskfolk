import { expect, test } from "bun:test";
import {
  buildCitedPathTree,
  buildTaskArtifactTree,
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

const DIR = "work/2026-09-21-导出季度报表-7f3k";

test("buildTaskArtifactTree anchors the work dir and keeps full paths on its children", () => {
  const nodes = buildTaskArtifactTree(DIR, [`${DIR}/data.csv`, `${DIR}/charts/q3.png`]);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.path).toBe(DIR);
  expect(nodes[0]!.name).toBe("2026-09-21-导出季度报表-7f3k");
  const charts = nodes[0]!.children!.find((n) => n.kind === "dir")!;
  expect(charts.path).toBe(`${DIR}/charts`);
  expect(charts.children![0]!.path).toBe(`${DIR}/charts/q3.png`);
});

test("buildTaskArtifactTree lays outside paths flat beside the work dir, never under work/", () => {
  const nodes = buildTaskArtifactTree(DIR, [`${DIR}/data.csv`, "report.md", "inbox/raw.xlsx"]);
  expect(nodes.map((n) => n.path)).toEqual([DIR, "inbox", "report.md"]);
  expect(nodes.some((n) => n.path === "work")).toBe(false);
});

test("buildTaskArtifactTree marks only what this message cited", () => {
  const nodes = buildTaskArtifactTree(
    DIR,
    [`${DIR}/data.csv`, `${DIR}/charts/q3.png`, "report.md"],
    [`${DIR}/charts/q3.png`, "report.md"],
  );
  const inside = nodes[0]!.children!;
  expect(inside.find((n) => n.name === "data.csv")!.fresh).toBeUndefined();
  expect(inside.find((n) => n.kind === "dir")!.children![0]!.fresh).toBe(true);
  expect(nodes.find((n) => n.path === "report.md")!.fresh).toBe(true);
});

test("buildTaskArtifactTree is just the outside paths when the work dir holds nothing cited", () => {
  expect(buildTaskArtifactTree(DIR, ["report.md"]).map((n) => n.path)).toEqual(["report.md"]);
});
