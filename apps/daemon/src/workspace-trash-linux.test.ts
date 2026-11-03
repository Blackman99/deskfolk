import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_TRASH_OTHER_DISK, homeTrashDir, trashInfo, trashOnLinux } from "./workspace-trash-linux";

describe("homeTrashDir", () => {
  test("uses an absolute XDG_DATA_HOME and strips trailing slashes", () => {
    expect(homeTrashDir({ XDG_DATA_HOME: "/data/xdg//" }, "/home/me")).toBe("/data/xdg/Trash");
  });
  test("falls back for empty, relative and unset", () => {
    expect(homeTrashDir({ XDG_DATA_HOME: "" }, "/home/me")).toBe("/home/me/.local/share/Trash");
    expect(homeTrashDir({ XDG_DATA_HOME: "rel/dir" }, "/home/me")).toBe("/home/me/.local/share/Trash");
    expect(homeTrashDir({}, "/home/me/")).toBe("/home/me/.local/share/Trash");
  });
});

describe("trashInfo", () => {
  const when = new Date(2026, 0, 2, 3, 4, 5);
  test("encodes spaces, CJK and reserved characters; keeps slashes", () => {
    const body = trashInfo("/tmp/a b/目录.md", when);
    expect(body).toContain("Path=/tmp/a%20b/%E7%9B%AE%E5%BD%95.md\n");
    expect(trashInfo("/x/100%/a#b?c", when)).toContain("Path=/x/100%25/a%23b%3Fc\n");
    expect(trashInfo("/x/it's (a)~*!-_.", when)).toContain("Path=/x/it's%20(a)~*!-_.\n");
  });
  test("writes the local date with zero padding and a trailing newline", () => {
    expect(trashInfo("/a", when)).toBe("[Trash Info]\nPath=/a\nDeletionDate=2026-01-02T03:04:05\n");
  });
});

describe("trashOnLinux", () => {
  let root = "";
  let home = "";
  let src = "";
  const when = () => new Date(2026, 5, 7, 8, 9, 10);
  const run = (abs: string[], extra: Parameters<typeof trashOnLinux>[1] = {}) =>
    trashOnLinux(abs, { env: { XDG_DATA_HOME: undefined }, home, now: when, gio: null, ...extra });
  const trash = () => join(home, ".local", "share", "Trash");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rb-trash-"));
    home = join(root, "home");
    src = join(root, "src");
    mkdirSync(home);
    mkdirSync(src);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const originalOf = (name: string) => decodeURIComponent(/^Path=(.*)$/m.exec(readFileSync(join(trash(), "info", `${name}.trashinfo`), "utf8"))![1]!);

  test("moves a file and a folder with matching info files", async () => {
    const file = join(src, "a b.md");
    const dir = join(src, "folder");
    writeFileSync(file, "hi");
    mkdirSync(dir);
    writeFileSync(join(dir, "inner.txt"), "x");
    expect(await run([file, dir])).toEqual(["", ""]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(trash(), "files", "a b.md"), "utf8")).toBe("hi");
    expect(existsSync(join(trash(), "files", "folder", "inner.txt"))).toBe(true);
    expect(originalOf("a b.md")).toBe(file);
    expect(originalOf("folder")).toBe(dir);
    expect(readFileSync(join(trash(), "info", "folder.trashinfo"), "utf8")).toContain("DeletionDate=2026-06-07T08:09:10");
  });

  test("numbers colliding names", async () => {
    const one = join(src, "one");
    const two = join(src, "two");
    mkdirSync(one);
    mkdirSync(two);
    writeFileSync(join(one, "notes.md"), "1");
    writeFileSync(join(two, "notes.md"), "2");
    expect(await run([join(one, "notes.md"), join(two, "notes.md")])).toEqual(["", ""]);
    expect(readdirSync(join(trash(), "files")).sort()).toEqual(["notes 2.md", "notes.md"]);
    expect(readFileSync(join(trash(), "files", "notes 2.md"), "utf8")).toBe("2");
  });

  test("a leftover info file reserves its name; dotfiles have no extension", async () => {
    mkdirSync(join(trash(), "info"), { recursive: true });
    writeFileSync(join(trash(), "info", "report.trashinfo"), "");
    writeFileSync(join(trash(), "info", ".env.trashinfo"), "");
    const report = join(src, "report");
    const env = join(src, ".env");
    writeFileSync(report, "r");
    writeFileSync(env, "e");
    expect(await run([report, env])).toEqual(["", ""]);
    expect(existsSync(join(trash(), "files", "report 2"))).toBe(true);
    expect(existsSync(join(trash(), "files", ".env 2"))).toBe(true);
  });

  test("trashes a symlink as the link, not its target", async () => {
    const target = join(src, "target.txt");
    const link = join(src, "link");
    writeFileSync(target, "t");
    symlinkSync(target, link);
    expect(await run([link])).toEqual([""]);
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(join(trash(), "files", "link")).isSymbolicLink()).toBe(true);
  });

  test("a bad path in the middle fails alone", async () => {
    const a = join(src, "a");
    const b = join(src, "b");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const answers = await run([a, join(src, "missing"), b]);
    expect(answers[0]).toBe("");
    expect(answers[1]).not.toBe("");
    expect(answers[2]).toBe("");
    expect(existsSync(join(trash(), "info", "missing.trashinfo"))).toBe(false);
  });

  const crossDisk = () => {
    throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  };

  test("another disk goes to gio when it is there", async () => {
    const file = join(src, "far.txt");
    writeFileSync(file, "");
    const calls: string[][] = [];
    const answers = await run([file], {
      gio: "/usr/bin/gio",
      rename: crossDisk,
      runGio: async (gio, path) => {
        calls.push([gio, path]);
        return "";
      },
    });
    expect(answers).toEqual([""]);
    expect(calls).toEqual([["/usr/bin/gio", file]]);
    expect(existsSync(join(trash(), "info", "far.txt.trashinfo"))).toBe(false);
  });

  test("another disk without gio is refused and leaves no info file", async () => {
    const file = join(src, "far.txt");
    writeFileSync(file, "");
    expect(await run([file], { rename: crossDisk })).toEqual([LINUX_TRASH_OTHER_DISK]);
    expect(readdirSync(join(trash(), "info"))).toEqual([]);
  });

  test("another rename error is its message, with the info file removed", async () => {
    const file = join(src, "locked.txt");
    writeFileSync(file, "");
    const answers = await run([file], {
      rename: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    expect(answers).toEqual(["permission denied"]);
    expect(readdirSync(join(trash(), "info"))).toEqual([]);
  });
});
