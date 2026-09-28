import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { HttpError } from "./errors";
import { HOST_LIST_LIMIT, isForeignHome, listHostDir, resolveHostPath, type HostFs } from "./host-paths";

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

/** A Windows disk of folders and files, looked up regardless of case and answered in its own spelling. */
function windowsDisk(paths: string[], denied: string[] = []): HostFs {
  const entries = new Map<string, "dir" | "file">();
  for (const path of paths) {
    entries.set(path.toLowerCase(), path.endsWith(".txt") ? "file" : "dir");
    for (let up = win32.dirname(path); up !== win32.dirname(up); up = win32.dirname(up)) entries.set(up.toLowerCase(), "dir");
  }
  const spelling = new Map([...paths, ...paths.flatMap((p) => ancestors(p))].map((p) => [p.toLowerCase(), p]));
  const canonical = (path: string): string => {
    const clean = win32.resolve(path);
    if (/^[A-Za-z]:\\$/.test(clean)) return clean.toUpperCase();
    const real = spelling.get(clean.toLowerCase());
    if (!real) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return real;
  };
  const kindOf = (path: string) => (/^[A-Za-z]:\\$/.test(win32.resolve(path)) ? "dir" : entries.get(canonical(path).toLowerCase())!);
  return {
    home: "C:\\Users\\me",
    paths: {
      platform: "win32",
      lstat: (path) => ({ isSymbolicLink: () => false, isDirectory: () => kindOf(path) === "dir" }),
      realpath: canonical,
      readlink: () => { throw new Error("EINVAL"); },
      homedir: () => "C:\\Users\\me",
      fileId: canonical,
    },
    stat: ((path: string) => ({ isDirectory: () => kindOf(path) === "dir" })) as unknown as typeof statSync,
    readdir: ((path: string) => {
      const dir = canonical(path);
      if (denied.includes(dir)) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return [...spelling.values()].filter((p) => p !== dir && win32.dirname(p) === dir).map((p) => win32.basename(p));
    }) as unknown as typeof readdirSync,
  };
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let up = win32.dirname(path); up !== win32.dirname(up); up = win32.dirname(up)) out.push(up);
  return out;
}

describe("on Windows", () => {
  const disk = windowsDisk([
    "C:\\Users\\me\\ws\\notes",
    "C:\\Users\\me\\ws\\brief.txt",
    "C:\\Users\\alice\\Documents",
    "C:\\Users\\Public\\Music",
    "C:\\Projects",
    "C:\\Locked",
  ], ["C:\\Locked"]);

  test("a folder lists with native child paths, and its parent", () => {
    const page = listHostDir("c:/users/ME/ws", disk);
    expect(page.path).toBe("C:\\Users\\me\\ws");
    expect(page.parent).toBe("C:\\Users\\me");
    expect(page.items).toEqual([
      { name: "notes", path: "C:\\Users\\me\\ws\\notes", kind: "dir" },
      { name: "brief.txt", path: "C:\\Users\\me\\ws\\brief.txt", kind: "file" },
    ]);
  });

  test("the drive root lists with no parent, and the home folder is the default", () => {
    const root = listHostDir("C:\\", disk);
    expect(root.path).toBe("C:\\");
    expect(root.parent).toBeNull();
    expect(root.items.map((row) => row.path)).toEqual(["C:\\Locked", "C:\\Projects", "C:\\Users"]);
    expect(listHostDir("", disk).path).toBe("C:\\Users\\me");
  });

  test("other users' profiles are hidden and refused; Public and your own are not", () => {
    expect(listHostDir("C:\\Users", disk).items.map((row) => row.name)).toEqual(["me", "Public"]);
    try {
      listHostDir("C:\\USERS\\alice\\Documents", disk);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
      expect((error as HttpError).code).toBe("host_permission");
      expect((error as HttpError).message).toBe("access is denied on this computer");
    }
    expect(isForeignHome("C:\\Users\\alice", "C:\\Users\\me", "win32")).toBe(true);
    expect(isForeignHome("c:\\users\\ALICE\\x", "C:\\Users\\me", "win32")).toBe(true);
    expect(isForeignHome("C:\\Users\\ME\\x", "C:\\Users\\me", "win32")).toBe(false);
    expect(isForeignHome("C:\\Users\\Public\\x", "C:\\Users\\me", "win32")).toBe(false);
    expect(isForeignHome("C:\\Users", "C:\\Users\\me", "win32")).toBe(false);
    expect(isForeignHome("D:\\Users\\alice", "C:\\Users\\me", "win32")).toBe(false);
    // A profile right under a drive root has no folder of other profiles beside it.
    expect(isForeignHome("D:\\projects", "D:\\me", "win32")).toBe(false);
  });

  test("an access denial is a typed host_permission error", () => {
    expect(() => listHostDir("C:\\Locked", disk)).toThrow("access is denied on this computer");
  });

  test("only absolute Windows paths are accepted", () => {
    for (const path of ["ws", "\\Users\\me", "/Users/me", "C:", "C:Users"]) {
      expect(() => resolveHostPath(path, disk)).toThrow("path must be an absolute host directory");
    }
    expect(resolveHostPath("C:/Users/me/ws/", disk)).toBe("C:\\Users\\me\\ws");
  });
});
