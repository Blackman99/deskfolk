import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMemoryDirs, claudeProjectKey, gitCheckoutRoot } from "./memory-dir";

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-memory-dir-")));
const posixTest = test.skipIf(process.platform === "win32");

test("a folder's key is its path with everything but letters and digits as -, as Claude Code names it", () => {
  expect(claudeProjectKey("/Users/someone/trustin")).toBe("-Users-someone-trustin");
  expect(claudeProjectKey("/Users/someone/my-projects/real-bot/.claude/worktrees/x")).toBe("-Users-someone-my-projects-real-bot--claude-worktrees-x");
  expect(claudeProjectKey("C:\\Users\\Someone\\ws")).toBe("C--Users-Someone-ws");
  expect(claudeProjectKey("/项目/a")).toBe("----a");
  // Past 200 characters it is cut there and a hash of the whole path added.
  const long = `/${"a".repeat(250)}`;
  expect(claudeProjectKey(long)).toMatch(new RegExp(`^-${"a".repeat(199)}-[0-9a-z]+$`));
  expect(claudeProjectKey(long)).not.toBe(claudeProjectKey(`/${"a".repeat(251)}`));
});

posixTest("a project is keyed by its repository: a subfolder and a linked worktree by the main checkout", () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(join(repo, "apps", "daemon"), { recursive: true });
  const worktree = join(root, "wt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const plain = join(root, "plain");
  mkdirSync(plain);
  expect(gitCheckoutRoot(repo)).toBe(repo);
  expect(gitCheckoutRoot(join(repo, "apps", "daemon"))).toBe(repo);
  expect(gitCheckoutRoot(worktree)).toBe(repo);
  expect(gitCheckoutRoot(plain)).toBeNull();

  const config = join(root, "cfg");
  const memory = (folder: string) => join(config, "projects", claudeProjectKey(folder), "memory");
  expect(claudeMemoryDirs(plain, config)).toEqual([memory(plain)]);
  expect(claudeMemoryDirs(repo, config)).toEqual([memory(repo)]);
  expect(claudeMemoryDirs(worktree, config)).toEqual([memory(worktree), memory(repo)]);
  // A folder reached through a link: its spelling and its real path both.
  const link = join(root, "link-to-plain");
  symlinkSync(plain, link);
  expect(claudeMemoryDirs(link, config)).toEqual([memory(link), memory(plain)]);
});

posixTest("a .git that is a link, or a worktree file that cannot be followed, keys nothing past it", () => {
  const linked = join(root, "linked");
  mkdirSync(join(root, "elsewhere-git"), { recursive: true });
  mkdirSync(linked);
  symlinkSync(join(root, "elsewhere-git"), join(linked, ".git"));
  expect(gitCheckoutRoot(linked)).toBeNull();
  const broken = join(root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "gitdir: /nowhere/at/all\n");
  expect(gitCheckoutRoot(broken)).toBe(broken);
});
