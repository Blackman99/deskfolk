import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { listWorkspaceDir, locateWorkspaceFile, writeWorkspaceFile, WORKSPACE_LIST_LIMIT } from "./workspace-browse";

const dirs: string[] = [];

function ws(): string {
  const root = mkdtempSync(join(tmpdir(), "real-bot-browse-"));
  dirs.push(root);
  return root;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("listWorkspaceDir lists the workspace root and skips dotfiles and node_modules", () => {
  const root = ws();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "brief.md"), "# hi\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "node_modules", "pkg.js"), "x");
  const page = listWorkspaceDir(root, "");
  expect(page.path).toBe(".");
  expect(page.truncated).toBe(false);
  expect(page.items.map((row) => `${row.kind}:${row.path}`)).toEqual(["dir:src", "file:brief.md"]);
});

test("listWorkspaceDir lists one directory and rejects outside paths", () => {
  const root = ws();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "export {}\n");
  expect(listWorkspaceDir(root, "src").items.map((row) => row.path)).toEqual(["src/app.ts"]);
  expect(() => listWorkspaceDir(root, "../secret")).toThrow(HttpError);
  try {
    listWorkspaceDir(root, "../secret");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
  }
});

test("listWorkspaceDir skips a symlink that leaves the workspace", () => {
  const root = ws();
  const outside = mkdtempSync(join(tmpdir(), "real-bot-out-"));
  dirs.push(outside);
  writeFileSync(join(outside, "leak.txt"), "nope");
  symlinkSync(outside, join(root, "escape"));
  mkdirSync(join(root, "keep"));
  const page = listWorkspaceDir(root, ".");
  expect(page.items.map((row) => row.path)).toEqual(["keep"]);
});

test("listWorkspaceDir sets truncated when a directory exceeds the listing cap", () => {
  const root = ws();
  mkdirSync(join(root, "many"));
  for (let i = 0; i < WORKSPACE_LIST_LIMIT + 3; i++) {
    writeFileSync(join(root, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
  }
  const page = listWorkspaceDir(root, "many");
  expect(page.truncated).toBe(true);
  expect(page.items).toHaveLength(WORKSPACE_LIST_LIMIT);
});

test("writeWorkspaceFile overwrites an existing inside file and rejects missing or outside paths", () => {
  const root = ws();
  writeFileSync(join(root, "note.md"), "old");
  mkdirSync(join(root, "src"));
  expect(writeWorkspaceFile(root, "note.md", "new")).toEqual({ rel: "note.md" });
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("new");
  expect(() => writeWorkspaceFile(root, "missing.md", "x")).toThrow(HttpError);
  expect(() => writeWorkspaceFile(root, "src", "x")).toThrow(HttpError);
  expect(() => writeWorkspaceFile(root, "../secret", "x")).toThrow(HttpError);
});

test("locateWorkspaceFile returns an inside file and rejects directories", () => {
  const root = ws();
  writeFileSync(join(root, "note.md"), "hi");
  mkdirSync(join(root, "src"));
  const located = locateWorkspaceFile(root, "note.md");
  expect(located.rel).toBe("note.md");
  expect(located.mime).toBe("text/markdown");
  expect(() => locateWorkspaceFile(root, "src")).toThrow(HttpError);
  expect(() => locateWorkspaceFile(root, "missing.md")).toThrow(HttpError);
});

test("locateWorkspaceFile serves files larger than the UTF-8 write cap", () => {
  const root = ws();
  const big = join(root, "clip.mp4");
  writeFileSync(big, Buffer.alloc(1_000_001, 7));
  const located = locateWorkspaceFile(root, "clip.mp4");
  expect(located.rel).toBe("clip.mp4");
  expect(located.mime).toBe("video/mp4");
  expect(() => writeWorkspaceFile(root, "clip.mp4", "x".repeat(1_000_001))).toThrow(HttpError);
});
