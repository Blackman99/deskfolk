import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, classifyShell } from "./workspace-paths";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-path-"));
  dirs.push(dir);
  return realpathSync(dir);
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("classifyPath", () => {
  test("relative workspace paths and dot are inside", () => {
    const root = tmp();
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "brief.md"), "x");
    writeFileSync(join(root, "notes/a.md"), "y");
    expect(classifyPath(root, ".")).toEqual({ zone: "inside", abs: root, rel: "." });
    expect(classifyPath(root, "brief.md")).toEqual({
      zone: "inside",
      abs: join(root, "brief.md"),
      rel: "brief.md",
    });
    expect(classifyPath(root, "notes/a.md")).toEqual({
      zone: "inside",
      abs: join(root, "notes/a.md"),
      rel: "notes/a.md",
    });
  });

  test("a host absolute path under the root is inside and returns the relative path", () => {
    const root = tmp();
    writeFileSync(join(root, "brief.md"), "x");
    const abs = join(root, "brief.md");
    expect(classifyPath(root, abs)).toEqual({ zone: "inside", abs, rel: "brief.md" });
  });

  test("dot-dot and an outside absolute path are outside", () => {
    const root = tmp();
    const parent = join(root, "..");
    const outside = classifyPath(root, "../escape.txt");
    expect(outside.zone).toBe("outside");
    if (outside.zone === "outside") {
      expect(outside.abs).toBe(join(realpathSync(parent), "escape.txt"));
    }
    const abs = classifyPath(root, "/etc/passwd");
    expect(abs.zone).toBe("outside");
    if (abs.zone === "outside") expect(abs.abs).toBe(realpathSync("/etc/passwd"));
  });

  test("a symlink inside the workspace to an outside target is outside", () => {
    const root = tmp();
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, "secret.txt"), "nope");
    symlinkSync(join(elsewhere, "secret.txt"), join(root, "link.txt"));
    const got = classifyPath(root, "link.txt");
    expect(got).toEqual({ zone: "outside", abs: join(elsewhere, "secret.txt") });
  });

  test("a dangling symlink is classified from the link text", () => {
    const root = tmp();
    symlinkSync("/no/such/real-bot-target", join(root, "dangling"));
    const got = classifyPath(root, "dangling");
    expect(got.zone).toBe("outside");
    if (got.zone === "outside") expect(got.abs).toBe("/no/such/real-bot-target");
  });

  test("a hard link inside the workspace to an outside inode is still inside", () => {
    const root = tmp();
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, "blob"), "data");
    linkSync(join(elsewhere, "blob"), join(root, "hard"));
    expect(classifyPath(root, "hard")).toEqual({
      zone: "inside",
      abs: join(root, "hard"),
      rel: "hard",
    });
  });

  test("a workspace root that is itself a symlink is compared after realpath", () => {
    const real = tmp();
    const holder = tmp();
    const linkRoot = join(holder, "ws");
    symlinkSync(real, linkRoot);
    writeFileSync(join(real, "brief.md"), "x");
    expect(classifyPath(linkRoot, "brief.md")).toEqual({
      zone: "inside",
      abs: join(real, "brief.md"),
      rel: "brief.md",
    });
  });

  test("a write target that does not exist yet stays inside when remaining segments stay under the prefix", () => {
    const root = tmp();
    expect(classifyPath(root, "notes/a.md")).toEqual({
      zone: "inside",
      abs: join(root, "notes/a.md"),
      rel: "notes/a.md",
    });
  });

  test("remaining dot-dot that leaves the existing prefix is outside", () => {
    const root = tmp();
    const got = classifyPath(root, "notes/../../etc/passwd");
    expect(got.zone).toBe("outside");
  });
});

describe("classifyShell", () => {
  test("a command with no visible outside path is jailed", () => {
    const root = tmp();
    const got = classifyShell(root, "git status", ".");
    expect(got).toEqual({ kind: "jailed", cwdAbs: root, cwdRel: "." });
  });

  test("an executable prefix stays jailed", () => {
    const root = tmp();
    const got = classifyShell(root, "/usr/bin/git status");
    expect(got.kind).toBe("jailed");
  });

  test("a visible outside path upgrades to unconstrained", () => {
    const root = tmp();
    expect(classifyShell(root, "cat /etc/passwd").kind).toBe("unconstrained");
    expect(classifyShell(root, "cat ~/.ssh/id_ed25519").kind).toBe("unconstrained");
    expect(classifyShell(root, "git --git-dir=/tmp/x").kind).toBe("unconstrained");
  });

  test("an absolute path hidden inside a python -c string still upgrades", () => {
    const root = tmp();
    expect(classifyShell(root, `python -c "open('/etc/passwd')"`).kind).toBe("unconstrained");
  });

  test("cwd outside the workspace is unconstrained", () => {
    const root = tmp();
    const got = classifyShell(root, "echo hi", "/tmp");
    expect(got.kind).toBe("unconstrained");
  });
});

describe("classifyPath existence check is not required for the helper itself", () => {
  test("does not create files", () => {
    const root = tmp();
    classifyPath(root, "ghost.md");
    expect(existsSync(join(root, "ghost.md"))).toBe(false);
  });
});
