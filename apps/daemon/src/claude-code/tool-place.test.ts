import { expect, test } from "bun:test";
import { fileOfCall, placeOfCall, placeOfCommand, placeOfPath, shellActionOf } from "./tool-place";

const ctx = { projectDir: "/work/app", cwd: "/work/app", home: "/Users/me", configDirs: ["/Volumes/x/claude-team"] };

test("a path is in the project (relative to it), among Claude Code's own files, or outside", () => {
  expect(placeOfPath("/work/app", ctx)).toEqual({ zone: "project", path: "" });
  expect(placeOfPath("/work/app/src/a.ts", ctx)).toEqual({ zone: "project", path: "src/a.ts" });
  expect(placeOfPath("/work/apple/a.ts", ctx)).toEqual({ zone: "outside", path: "/work/apple/a.ts" });
  expect(placeOfPath("/Users/me/.claude/projects/x.jsonl", ctx).zone).toBe("claude_home");
  expect(placeOfPath("/Users/me/.claude-b/settings.json", ctx).zone).toBe("claude_home");
  expect(placeOfPath("/Users/me/.claude.json", ctx).zone).toBe("claude_home");
  expect(placeOfPath("/Volumes/x/claude-team/projects", ctx).zone).toBe("claude_home");
  expect(placeOfPath("/Users/me/.clauderc-not", ctx).zone).toBe("claude_home");
  expect(placeOfPath("/Users/me/my/.claude/x", ctx).zone).toBe("outside");
});

test("file tools name their place; a call that names none has no place", () => {
  expect(placeOfCall("Read", { file_path: "src/a.ts" }, { ...ctx, cwd: "/work/app/apps" })).toEqual({ place: { zone: "project", path: "apps/src/a.ts" } });
  expect(placeOfCall("Grep", { pattern: "x", path: "~/.claude/projects" }, ctx).place.zone).toBe("claude_home");
  expect(placeOfCall("Glob", { pattern: "**/*.ts" }, { ...ctx, cwd: "/work/app/docs" })).toEqual({ place: { zone: "project", path: "docs" } });
  expect(placeOfCall("Agent", { description: "look around" }, ctx)).toEqual({ place: { zone: "none" } });
  expect(placeOfCall("AskUserQuestion", {}, ctx)).toEqual({ place: { zone: "none" } });
});

test("a test or type check and git are places of their own", () => {
  expect(placeOfCommand("cd apps/daemon && bun test src/a.test.ts", ctx)).toEqual({ zone: "check", check: "test" });
  expect(placeOfCommand("./node_modules/.bin/tsc --noEmit -p tsconfig.json", ctx)).toEqual({ zone: "check", check: "typecheck" });
  expect(placeOfCommand("pnpm typecheck", ctx)).toEqual({ zone: "check", check: "typecheck" });
  expect(placeOfCommand("git status --short", ctx)).toEqual({ zone: "git" });
  expect(placeOfCommand("cd /work/app && git log -1", ctx)).toEqual({ zone: "git" });
  // Searching a file for the word is not using git.
  expect(placeOfCommand("grep -n git docs/a.md", ctx)).toEqual({ zone: "project", path: "docs/a.md" });
});

test("otherwise a command works where most of its paths are, the later on a tie, after its cd", () => {
  expect(placeOfCommand("sed -n 1,20p src/a.ts src/b.ts docs/c.md", ctx)).toEqual({ zone: "project", path: "src/b.ts" });
  expect(placeOfCommand("cat src/a.ts docs/c.md", ctx)).toEqual({ zone: "project", path: "docs/c.md" });
  expect(placeOfCommand("cd apps/messenger && cat src/lib/x.svelte", ctx)).toEqual({ zone: "project", path: "apps/messenger/src/lib/x.svelte" });
  expect(placeOfCommand("ls ~/.claude/projects | head", ctx).zone).toBe("claude_home");
  expect(placeOfCommand("cat $S/out.json", ctx)).toEqual({ zone: "outside", path: "$S/out.json" });
  expect(placeOfCommand("curl -s https://example.com/a/b", ctx)).toEqual({ zone: "project", path: "" });
  // No path at all: where it runs.
  expect(placeOfCommand("cd /tmp && ls", ctx)).toEqual({ zone: "outside", path: "/tmp" });
  expect(placeOfCommand("echo hi", { ...ctx, cwd: "/work/app/apps" })).toEqual({ zone: "project", path: "apps" });
});

test("a command's kind is read from its words, and a call names its file by its last name", () => {
  expect(shellActionOf("bun test")).toBe("check");
  expect(shellActionOf("git diff")).toBe("git");
  expect(shellActionOf("sed -i '' 's/a/b/' x.ts")).toBe("write");
  expect(shellActionOf("rg -n foo src")).toBe("search");
  expect(shellActionOf("head -20 a.md")).toBe("read");
  expect(shellActionOf("bun scripts/x.ts")).toBe("script");
  expect(shellActionOf("lsof -i :5173")).toBe("run");
  expect(fileOfCall("Edit", { file_path: "/work/app/src/a.ts" })).toBe("a.ts");
  expect(fileOfCall("Bash", { command: "cat src/a.ts src/b.svelte | head" })).toBe("b.svelte");
  expect(fileOfCall("Grep", { pattern: "x" })).toBeNull();
});

test("a cd's target ends at the shell's punctuation, and one that is a variable never becomes part of a path", () => {
  expect(placeOfCommand("cd apps/messenger; cat src/lib/a.ts", ctx)).toEqual({ zone: "project", path: "apps/messenger/src/lib/a.ts" });
  expect(placeOfCommand("cd apps/messenger&&ls src/lib", ctx)).toEqual({ zone: "project", path: "apps/messenger/src/lib" });
  expect(placeOfCommand("(cd apps/daemon) | head", ctx)).toEqual({ zone: "project", path: "apps/daemon" });
  // `cd $R; ls apps/daemon/src`: the base is wherever $R is, so the path is said under it.
  expect(placeOfCommand("cd $R; ls apps/daemon/src", ctx)).toEqual({ zone: "outside", path: "$R/apps/daemon/src" });
  expect(placeOfCommand('cd "$W/apps/messenger" && sed -n 1,9p src/lib/x.ts', ctx)).toEqual({ zone: "outside", path: "$W/apps/messenger/src/lib/x.ts" });
  expect(placeOfCommand("cd $R && ls", ctx)).toEqual({ zone: "outside", path: "$R" });
  // An absolute path after it still says where it is.
  expect(placeOfCommand("cd $R; cat /work/app/docs/a.md", ctx)).toEqual({ zone: "project", path: "docs/a.md" });
  expect(placeOfCommand("cat apps/$X/a.ts", ctx)).toEqual({ zone: "outside", path: "apps/$X/a.ts" });
  // A search pattern with slashes is not a path.
  expect(placeOfCommand('grep -n "test\\|routes/system" src/a.ts', ctx)).toEqual({ zone: "project", path: "src/a.ts" });
});
