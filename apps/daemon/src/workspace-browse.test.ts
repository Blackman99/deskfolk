import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { listCitedDir, listWorkspaceDir, locateCitedFile, locateWorkspaceFile, writeWorkspaceFile, WORKSPACE_LIST_LIMIT } from "./workspace-browse";

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
  expect(writeWorkspaceFile(root, "note.md", "new")).toMatchObject({ rel: "note.md" });
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
  try {
    writeWorkspaceFile(root, "clip.mp4", "x".repeat(1_000_001));
  } catch (error) {
    expect((error as HttpError).code).toBe("too_large");
    expect((error as HttpError).status).toBe(422);
  }
});

function statusOf(run: () => unknown): number | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
}

test("a folder elsewhere on the Mac lists by its absolute path, with absolute entries", () => {
  const root = ws();
  const outside = realpathSync(ws());
  mkdirSync(join(outside, "site"));
  writeFileSync(join(outside, "index.html"), "<p>hi</p>");
  writeFileSync(join(outside, ".env"), "SECRET=1");
  const page = listCitedDir(root, outside);
  expect(page.path).toBe(outside);
  expect(page.items.map((row) => `${row.kind}:${row.path}`)).toEqual([`dir:${join(outside, "site")}`, `file:${join(outside, "index.html")}`]);
  // Without a workspace too: the path says where it is.
  expect(listCitedDir(null, outside).items).toHaveLength(2);
  // Written relative, a path is the workspace's, and leaving it is still an escape.
  expect(statusOf(() => listCitedDir(root, "../x"))).toBe(422);
  expect(statusOf(() => listCitedDir(null, "src"))).toBe(422);
  expect(statusOf(() => listCitedDir(root, join(outside, "index.html")))).toBe(422);
  expect(statusOf(() => listCitedDir(root, join(outside, "gone")))).toBe(404);
});

test("an absolute path into the workspace keeps the workspace's rules", () => {
  const root = realpathSync(ws());
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "export {}\n");
  writeFileSync(join(root, "src", ".hidden"), "x");
  expect(listCitedDir(root, join(root, "src")).items.map((row) => row.path)).toEqual([join(root, "src", "app.ts")]);
  expect(locateCitedFile(root, join(root, "src", "app.ts"))).toMatchObject({ abs: join(root, "src", "app.ts"), name: "app.ts" });
});

test("a file elsewhere on the Mac reads by its absolute path or from ~", () => {
  const root = ws();
  const home = realpathSync(ws());
  mkdirSync(join(home, "projects"));
  writeFileSync(join(home, "projects", "notes.md"), "# notes\n");
  expect(locateCitedFile(root, join(home, "projects", "notes.md"))).toEqual({ abs: join(home, "projects", "notes.md"), name: "notes.md", mime: "text/markdown" });
  expect(locateCitedFile(root, "~/projects/notes.md", { home }).abs).toBe(join(home, "projects", "notes.md"));
  // A folder named from ~ answers with where it is, so the window can open it on the Mac.
  const page = listCitedDir(root, "~/projects", { home });
  expect(page.path).toBe(join(home, "projects"));
  expect(page.items.map((row) => row.path)).toEqual([join(home, "projects", "notes.md")]);
  expect(statusOf(() => locateCitedFile(root, "~/projects", { home }))).toBe(422);
  expect(statusOf(() => locateCitedFile(root, "~/projects/gone.md", { home }))).toBe(404);
  expect(statusOf(() => locateCitedFile(root, "../projects/notes.md", { home }))).toBe(422);
  // Saving stays inside the workspace.
  expect(statusOf(() => writeWorkspaceFile(root, join(home, "projects", "notes.md"), "x"))).toBe(422);
  expect(readFileSync(join(home, "projects", "notes.md"), "utf8")).toBe("# notes\n");
});
