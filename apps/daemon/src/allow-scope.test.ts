import { describe, expect, test } from "bun:test";
import { proposedAllowScope } from "./allow-scope";
import type { PathHost } from "./workspace-paths";

/** A disk of these folders (ending in `/` or `\`) and files, with this home. */
function disk(platform: NodeJS.Platform, home: string, entries: string[]): PathHost {
  const sep = platform === "win32" ? "\\" : "/";
  const dirs = new Set(entries.filter((e) => e.endsWith(sep)).map((e) => e.slice(0, -1)));
  const files = new Set(entries.filter((e) => !e.endsWith(sep)));
  return {
    platform,
    homedir: () => home,
    lstat: (path) => {
      if (!dirs.has(path) && !files.has(path)) throw new Error(`ENOENT ${path}`);
      return { isSymbolicLink: () => false, isDirectory: () => dirs.has(path) };
    },
    realpath: (path) => path,
    readlink: () => {
      throw new Error("not a link");
    },
  };
}

describe("what an Always allow on a path outside the workspace covers (ADR 0087)", () => {
  const mac = disk("darwin", "/Users/me", [
    "/Users/me/my-projects/sveltepress/",
    "/Users/me/my-projects/sveltepress/.git/",
    "/Users/me/my-projects/sveltepress/packages/theme/src/components/",
    "/Users/me/my-projects/sveltepress/packages/theme/src/components/Navbar.svelte",
    "/Users/me/my-projects/worktree-of/",
    "/Users/me/my-projects/worktree-of/.git",
    "/Users/me/Downloads/report/",
    "/Users/me/Downloads/report/a.pdf",
    "/Users/me/notes.txt",
    "/Users/me/.git/",
    "/Users/me/dotfiles-child/",
    "/private/tmp/scratch/",
    "/etc/hosts",
  ]);

  test("a file in a project: the project, the folder holding .git", () => {
    expect(proposedAllowScope("outside-write", "/Users/me/my-projects/sveltepress/packages/theme/src/components/Navbar.svelte", mac))
      .toBe("/Users/me/my-projects/sveltepress");
    // A file not written yet, in a folder not made yet: still that project.
    expect(proposedAllowScope("outside-write", "/Users/me/my-projects/sveltepress/.changeset/new.md", mac))
      .toBe("/Users/me/my-projects/sveltepress");
    expect(proposedAllowScope("outside-read", "/Users/me/my-projects/sveltepress", mac)).toBe("/Users/me/my-projects/sveltepress");
  });

  test("a worktree's .git is a file and still marks the project", () => {
    expect(proposedAllowScope("outside-read", "/Users/me/my-projects/worktree-of/README.md", mac)).toBe("/Users/me/my-projects/worktree-of");
  });

  test("no project above it: the folder it is in, or the folder itself", () => {
    expect(proposedAllowScope("outside-read", "/Users/me/Downloads/report/a.pdf", mac)).toBe("/Users/me/Downloads/report");
    expect(proposedAllowScope("outside-read", "/Users/me/Downloads/report", mac)).toBe("/Users/me/Downloads/report");
    expect(proposedAllowScope("outside-write", "/private/tmp/scratch/out.txt", mac)).toBe("/private/tmp/scratch");
  });

  test("never your home, above it, a root or a folder right under one: then the path alone", () => {
    // Home holds a .git (dotfiles) — still not the project of everything in it.
    expect(proposedAllowScope("outside-write", "/Users/me/dotfiles-child/x.conf", mac)).toBe("/Users/me/dotfiles-child");
    expect(proposedAllowScope("outside-write", "/Users/me/notes.txt", mac)).toBe("/Users/me/notes.txt");
    expect(proposedAllowScope("outside-read", "/Users/me", mac)).toBe("/Users/me");
    expect(proposedAllowScope("outside-write", "/etc/hosts", mac)).toBe("/etc/hosts");
    expect(proposedAllowScope("outside-read", "/Users", mac)).toBe("/Users");
  });

  test("only path cards propose a folder", () => {
    expect(proposedAllowScope("unconstrained-shell", "/Users/me/my-projects/sveltepress", mac)).toBeNull();
    expect(proposedAllowScope("outbound-http", "https://example.com/a", mac)).toBeNull();
    expect(proposedAllowScope("outside-read", "relative/path", mac)).toBeNull();
  });

  test("Windows paths walk the same way", () => {
    const win = disk("win32", "C:\\Users\\me", [
      "C:\\Users\\me\\src\\app\\",
      "C:\\Users\\me\\src\\app\\.git\\",
      "C:\\Users\\me\\src\\app\\lib\\",
      "D:\\data\\",
    ]);
    expect(proposedAllowScope("outside-write", "C:\\Users\\me\\src\\app\\lib\\a.ts", win)).toBe("C:\\Users\\me\\src\\app");
    expect(proposedAllowScope("outside-read", "D:\\data\\set\\b.csv", win)).toBe("D:\\data\\set");
    expect(proposedAllowScope("outside-read", "D:\\data\\b.csv", win)).toBe("D:\\data\\b.csv");
    expect(proposedAllowScope("outside-read", "C:\\Users\\me\\a.txt", win)).toBe("C:\\Users\\me\\a.txt");
  });
});
