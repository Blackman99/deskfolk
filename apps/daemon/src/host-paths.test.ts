import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { HOST_LIST_LIMIT, isForeignHome, listHostDir, resolveHostPath } from "./host-paths";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-host-"));
  dirs.push(dir);
  return realpathSync(dir);
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("listHostDir lists a directory and skips dotfiles", () => {
  const root = tmp();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "brief.md"), "x");
  writeFileSync(join(root, ".env"), "secret");
  const page = listHostDir(root, { home: root });
  expect(page.path).toBe(root);
  expect(page.parent).toBe(join(root, "..") === "/" ? "/" : realpathSync(join(root, "..")));
  expect(page.items.map((row) => `${row.kind}:${row.name}`)).toEqual(["dir:src", "file:brief.md"]);
});

test("listHostDir follows a symlink then uses the resolved realpath boundary", () => {
  const root = tmp();
  const elsewhere = tmp();
  writeFileSync(join(elsewhere, "secret.txt"), "nope");
  symlinkSync(elsewhere, join(root, "escape"));
  mkdirSync(join(root, "keep"));
  const page = listHostDir(root, { home: root });
  expect(page.items.map((row) => row.name).sort()).toEqual(["escape", "keep"]);
  const linked = listHostDir(join(root, "escape"), { home: root });
  expect(linked.path).toBe(elsewhere);
  expect(linked.items.map((row) => row.name)).toEqual(["secret.txt"]);
});

test("isForeignHome rejects other users' homes and allows Shared and Volumes", () => {
  expect(isForeignHome("/Users/alice", "/Users/bob")).toBe(true);
  expect(isForeignHome("/Users/alice/Documents", "/Users/bob")).toBe(true);
  expect(isForeignHome("/Users/bob/Documents", "/Users/bob")).toBe(false);
  expect(isForeignHome("/Users/Shared/x", "/Users/bob")).toBe(false);
  expect(isForeignHome("/Volumes/Disk", "/Users/bob")).toBe(false);
});

test("listHostDir refuses another user's home", () => {
  const root = tmp();
  expect(() => listHostDir("/Users/not-this-user", { home: root })).toThrow(HttpError);
  try {
    listHostDir("/Users/not-this-user", { home: root });
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).code).toBe("host_permission");
    expect((error as HttpError).message).toBe("authorize once on the Mac");
  }
});

test("TCC denial is a typed host_permission error and does not hang", () => {
  const root = tmp();
  mkdirSync(join(root, "Documents"));
  expect(() => listHostDir(join(root, "Documents"), {
    home: root,
    readdir: () => { const err = new Error("denied") as NodeJS.ErrnoException; err.code = "EPERM"; throw err; },
  })).toThrow(HttpError);
  try {
    listHostDir(join(root, "Documents"), {
      home: root,
      readdir: () => { const err = new Error("denied") as NodeJS.ErrnoException; err.code = "EACCES"; throw err; },
    });
  } catch (error) {
    expect((error as HttpError).code).toBe("host_permission");
    expect((error as HttpError).message).toBe("authorize once on the Mac");
  }
});

test("listHostDir truncates oversized directories", () => {
  const root = tmp();
  for (let i = 0; i < HOST_LIST_LIMIT + 2; i++) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.txt`), "x");
  const page = listHostDir(root, { home: root });
  expect(page.truncated).toBe(true);
  expect(page.items).toHaveLength(HOST_LIST_LIMIT);
});

test("resolveHostPath walks a dangling-safe absolute path", () => {
  const root = tmp();
  mkdirSync(join(root, "nested"));
  expect(resolveHostPath(join(root, "nested"), { home: root })).toBe(join(root, "nested"));
});
