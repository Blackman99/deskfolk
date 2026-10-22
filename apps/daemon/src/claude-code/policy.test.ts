import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { PathHost } from "../workspace-paths";
import { appToolName, decideAgentCall, isClaudeCredentialPath, touchesClaudeCredentials, type AgentCall } from "./policy";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-policy-")));
// Outside the workspace, already a real path (macOS's /etc is a link to /private/etc).
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "agent-policy-out-")));
const hosts = join(elsewhere, "hosts");
const home = "/Users/someone";
const base: Omit<AgentCall, "tool" | "input"> = { cwd: root, mode: "work", workspace: root, home, permission: "auto" };
// These read this machine's disk with POSIX paths; the Windows rules have their own tests below,
// on a fake Windows disk, which run everywhere.
const posixTest = test.skipIf(process.platform === "win32");

posixTest("a write counts as an effect and runs, asks or is refused by the Bot's permission mode, in the workspace or not", () => {
  expect(decideAgentCall({ ...base, tool: "Write", input: { file_path: join(root, "a.md") } })).toEqual({ kind: "allow", effect: true, appName: "write_file", target: "a.md" });
  expect(decideAgentCall({ ...base, tool: "Edit", input: { file_path: hosts } })).toEqual({ kind: "allow", effect: true, appName: "write_file", target: hosts });
  expect(decideAgentCall({ ...base, permission: "allow_all", tool: "Edit", input: { file_path: hosts } }).kind).toBe("allow");
  for (const file_path of [join(root, "a.md"), hosts]) {
    const asked = decideAgentCall({ ...base, permission: "ask_first", tool: "Edit", input: { file_path } });
    expect(asked.kind).toBe("ask");
    if (asked.kind === "ask") expect(asked.approval).toEqual({ kind_key: "file-write", target: file_path, summary: `file-write ${file_path}` });
    const refused = decideAgentCall({ ...base, permission: "read_only", tool: "Edit", input: { file_path } });
    expect(refused.kind).toBe("deny");
    if (refused.kind === "deny") expect(refused.reason).toContain("read-only");
  }
});

posixTest("a workspace path written as if the workspace were / is refused with where the workspace is, not put on a card", () => {
  const exists = (path: string) => path !== "/work" && path !== "/hello.txt";
  for (const [tool, file_path] of [["Write", "/work/job-x/01-a/hello.txt"], ["Write", "/hello.txt"], ["Read", "/work/job-x/notes.md"]] as const) {
    const call = decideAgentCall({ ...base, exists, tool, input: { file_path } });
    expect(call.kind).toBe("deny");
    if (call.kind === "deny") expect(call.reason).toContain(`The workspace root is ${root}`);
  }
  // A real place outside is read.
  expect(decideAgentCall({ ...base, exists, tool: "Read", input: { file_path: hosts } }).kind).toBe("allow");
});

posixTest("reading runs in every mode, wherever the file is", () => {
  for (const permission of ["read_only", "ask_first", "auto", "allow_all"] as const) {
    expect(decideAgentCall({ ...base, permission, tool: "Read", input: { file_path: hosts } })).toEqual({ kind: "allow", effect: false, appName: "read_file", target: hosts });
  }
});

posixTest("a command runs wherever it reaches in auto, asks under ask_first and is refused under read_only", () => {
  expect(decideAgentCall({ ...base, tool: "Bash", input: { command: "ls -la" } }).kind).toBe("allow");
  expect(decideAgentCall({ ...base, tool: "Bash", input: { command: "cat /etc/hosts" } }).kind).toBe("allow");
  const asked = decideAgentCall({ ...base, permission: "ask_first", tool: "Bash", input: { command: "ls -la" } });
  expect(asked.kind).toBe("ask");
  if (asked.kind === "ask") expect(asked.approval).toEqual({ kind_key: "shell", target: root, summary: "shell ls -la" });
  expect(decideAgentCall({ ...base, permission: "read_only", tool: "Bash", input: { command: "ls -la" } }).kind).toBe("deny");
});

posixTest("a recursive search over the home folder is refused, as for every Bot, in allow_all too", () => {
  const call = decideAgentCall({ ...base, permission: "allow_all", home: root, tool: "Bash", input: { command: "grep -r secret ~" } });
  expect(call.kind).toBe("deny");
});

posixTest("the config directories of your other Claude accounts are as off limits, whatever they are called", () => {
  const configDirs = [`${home}/cc-work`, "/opt/claude-acct"];
  for (const file_path of [`${home}/cc-work/.claude.json`, `${home}/cc-work`, "~/cc-work/settings.json", "/opt/claude-acct/.credentials.json"]) {
    const call = decideAgentCall({ ...base, configDirs, tool: "Read", input: { file_path } });
    expect(call.kind).toBe("deny");
    if (call.kind === "deny") expect(call.reason).toContain("credentials");
  }
  // Off limits in allow_all too: that is a refusal, not an approval.
  expect(decideAgentCall({ ...base, permission: "allow_all", configDirs, tool: "Read", input: { file_path: `${home}/cc-work/.claude.json` } }).kind).toBe("deny");
  // Not listed, it is any other folder. The fake home's top folder is a disk one here: Linux has no
  // /Users, and a path under a missing top is refused before anyone is asked.
  expect(decideAgentCall({ ...base, exists: () => true, tool: "Read", input: { file_path: `${home}/cc-work/.claude.json` } }).kind).toBe("allow");
  for (const command of ["cat ~/cc-work/.claude.json", "ls $HOME/cc-work", "cp ${HOME}/cc-work/x .", `tar cf - ${home}/cc-work`, "cat /opt/claude-acct/.claude.json"]) {
    expect(touchesClaudeCredentials(command, home, "darwin", configDirs)).toBe(true);
  }
  for (const command of ["ls ~/cc-work2", "ls ~/projects/cc-work", "cat /opt/claude-acct-notes"]) {
    expect(touchesClaudeCredentials(command, home, "darwin", configDirs)).toBe(false);
  }
  expect(decideAgentCall({ ...base, configDirs, tool: "Bash", input: { command: "cat ~/cc-work/.claude.json" } }).kind).toBe("deny");
});

posixTest("Claude Code's own credentials are never reachable", () => {
  expect(decideAgentCall({ ...base, tool: "Read", input: { file_path: `${home}/.claude/.credentials.json` } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, tool: "Read", input: { file_path: "~/.claude.json" } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, tool: "Bash", input: { command: "security find-generic-password -s 'Claude Code-credentials' -w" } }).kind).toBe("deny");
  expect(touchesClaudeCredentials("cat $HOME/.claude/settings.json", home)).toBe(true);
  expect(touchesClaudeCredentials("ls ~/.claudex", home)).toBe(false);
  expect(isClaudeCredentialPath(`${home}/Library/Keychains/login.keychain-db`, home)).toBe(true);
  expect(isClaudeCredentialPath(`${home}/projects/.claude-notes`, home)).toBe(false);
});

posixTest("a project session's file tools open its memory of the project, by the mode as any folder outside; the rest of ~/.claude stays shut", () => {
  const memory = `${home}/.claude/projects/-Users-someone-proj/memory`;
  // The fake home's top folder is a disk one here, as above.
  const at = { ...base, exists: () => true, memoryDirs: [memory] };
  for (const permission of ["read_only", "ask_first", "auto", "allow_all"] as const) {
    expect(decideAgentCall({ ...at, permission, tool: "Read", input: { file_path: `${memory}/kyt_notes.md` } }))
      .toEqual({ kind: "allow", effect: false, appName: "read_file", target: `${memory}/kyt_notes.md` });
  }
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: "~/.claude/projects/-Users-someone-proj/memory/MEMORY.md" } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Grep", input: { pattern: "api key", path: memory } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Glob", input: { pattern: "*.md", path: memory } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Write", input: { file_path: `${memory}/new.md` } })).toEqual({ kind: "allow", effect: true, appName: "write_file", target: `${memory}/new.md` });
  expect(decideAgentCall({ ...at, permission: "ask_first", tool: "Edit", input: { file_path: `${memory}/MEMORY.md` } }).kind).toBe("ask");
  expect(decideAgentCall({ ...at, permission: "read_only", tool: "Write", input: { file_path: `${memory}/new.md` } })).toEqual({ kind: "deny", reason: expect.stringContaining("read-only") });
  // A Bot names no memory folder: the same file is Claude Code's as before.
  expect(decideAgentCall({ ...base, exists: () => true, tool: "Read", input: { file_path: `${memory}/kyt_notes.md` } }).kind).toBe("deny");
  // Out of it by climbing, the transcripts beside it, another project's memory, a folder named like it.
  for (const file_path of [`${memory}/../../../settings.json`, `${memory}/../47ce0671.jsonl`, `${home}/.claude/projects/-Users-someone-other/memory/a.md`,
    `${memory}-old/a.md`, `${home}/.claude.json`, `${home}/.claude/.credentials.json`]) {
    const call = decideAgentCall({ ...at, permission: "allow_all", tool: "Read", input: { file_path } });
    expect([file_path, call.kind]).toEqual([file_path, "deny"]);
    if (call.kind === "deny") expect(call.reason).toContain("credentials");
  }
  for (const pattern of ["../../*.json", "**/../../../.credentials.json", `${home}/.claude/*.json`, "~/.claude/*"]) {
    expect([pattern, decideAgentCall({ ...at, tool: "Glob", input: { pattern, path: memory } }).kind]).toEqual([pattern, "deny"]);
  }
  // A command does not get in: from there it could go on to the rest. It is told to use the file tools.
  for (const command of [`cd ${memory} && cat kyt_notes.md`, "cat ~/.claude/projects/-Users-someone-proj/memory/MEMORY.md"]) {
    expect(decideAgentCall({ ...at, permission: "allow_all", tool: "Bash", input: { command } })).toEqual({ kind: "deny", reason: expect.stringContaining("open with Read, Write, Edit") });
  }
  expect(decideAgentCall({ ...at, tool: "Bash", input: { command: "cat ~/.claude.json" } })).toEqual({ kind: "deny", reason: "Claude Code's own settings and credentials are off limits" });
});

posixTest("a session on a listed account opens its memory there, and nothing else of that account", () => {
  const configDirs = [`${home}/.claude-b`];
  const at = { ...base, exists: () => true, configDirs, memoryDirs: [`${home}/.claude-b/projects/-Users-someone-proj/memory`] };
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: `${home}/.claude-b/projects/-Users-someone-proj/memory/a.md` } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: `${home}/.claude-b/.claude.json` } }).kind).toBe("deny");
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: `${home}/.claude/projects/-Users-someone-proj/memory/a.md` } }).kind).toBe("deny");
});

posixTest("a link in the memory folder is followed: one leading to a sign-in, or to nothing yet, stays shut", () => {
  const config = join(elsewhere, "cfg");
  const memory = join(config, "projects", "-proj", "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(config, ".credentials.json"), "{}");
  writeFileSync(join(memory, "notes.md"), "x");
  symlinkSync(join(config, ".credentials.json"), join(memory, "leak.md"));
  symlinkSync(join(config, "settings.json"), join(memory, "later.md"));
  const at = { ...base, configDirs: [config], memoryDirs: [memory] };
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: join(memory, "notes.md") } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Write", input: { file_path: join(memory, "fresh", "a.md") } }).kind).toBe("allow");
  expect(decideAgentCall({ ...at, tool: "Read", input: { file_path: join(memory, "leak.md") } }).kind).toBe("deny");
  expect(decideAgentCall({ ...at, tool: "Write", input: { file_path: join(memory, "later.md") } }).kind).toBe("deny");
});

posixTest("a read-only turn can look and nothing else; background work and unlisted tools are refused", () => {
  expect(decideAgentCall({ ...base, mode: "readonly", tool: "Write", input: { file_path: join(root, "a") } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, mode: "readonly", tool: "Read", input: { file_path: join(root, "a") } }).kind).toBe("allow");
  expect(decideAgentCall({ ...base, tool: "Bash", input: { command: "npm run dev", run_in_background: true } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, tool: "Agent", input: { prompt: "x", isolation: "worktree" } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, tool: "Agent", input: { prompt: "x" } }).kind).toBe("allow");
  expect(decideAgentCall({ ...base, tool: "CronCreate", input: {} }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, tool: "AskUserQuestion", input: {} }).kind).toBe("deny");
});

test("Claude Code's tools are named the way the app's own frames and records name them", () => {
  expect(["Bash", "Write", "Edit", "Read", "Grep", "WebFetch"].map(appToolName)).toEqual(["shell", "write_file", "write_file", "read_file", "list_dir", "WebFetch"]);
});

// Windows -----------------------------------------------------------------------------------------
// The win32 rules on a fake disk: names looked up regardless of case and answered in their own
// spelling, as NTFS does.

const WIN_HOME = "C:\\Users\\Someone";
const WIN_WS = "C:\\Users\\Someone\\ws";

function windowsHost(paths: Record<string, "dir" | "file">): PathHost {
  const spelling = new Map<string, { path: string; kind: "dir" | "file" }>();
  for (const [path, kind] of Object.entries(paths)) {
    spelling.set(path.toLowerCase(), { path, kind });
    for (let up = win32.dirname(path); up !== win32.dirname(up); up = win32.dirname(up)) {
      if (!spelling.has(up.toLowerCase())) spelling.set(up.toLowerCase(), { path: up, kind: "dir" });
    }
  }
  const find = (path: string) => {
    const clean = win32.resolve(path);
    if (/^[A-Za-z]:\\$/.test(clean)) return { path: clean.toUpperCase(), kind: "dir" as const };
    const hit = spelling.get(clean.toLowerCase());
    if (!hit) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return hit;
  };
  return {
    platform: "win32",
    lstat: (path) => ({ isSymbolicLink: () => false, isDirectory: () => find(path).kind === "dir" }),
    realpath: (path) => find(path).path,
    readlink: () => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); },
    homedir: () => WIN_HOME,
    fileId: (path) => find(path).path.toLowerCase(),
  };
}

const winHost = windowsHost({
  [`${WIN_WS}\\notes`]: "dir",
  [`${WIN_HOME}\\.claude\\.credentials.json`]: "file",
  [`${WIN_HOME}\\.claude.json`]: "file",
  [`${WIN_HOME}\\Documents`]: "dir",
  "C:\\Windows\\System32\\drivers\\etc\\hosts": "file",
});
const winBase: Omit<AgentCall, "tool" | "input"> = { cwd: WIN_WS, mode: "work", workspace: WIN_WS, home: WIN_HOME, permission: "auto", host: winHost };

test("on Windows, Claude Code's own credentials are never reachable, however the path is spelled", () => {
  for (const file_path of [
    `${WIN_HOME}\\.claude\\.credentials.json`,
    "c:/users/someone/.CLAUDE/.credentials.json",
    "~\\.claude.json",
    "/c/Users/Someone/.claude/.credentials.json",
  ]) {
    const call = decideAgentCall({ ...winBase, tool: "Read", input: { file_path } });
    expect([file_path, call.kind]).toEqual([file_path, "deny"]);
    if (call.kind === "deny") expect(call.reason).toContain("credentials");
  }
  for (const command of [
    "type %USERPROFILE%\\.claude\\.credentials.json",
    "Get-Content $env:USERPROFILE\\.claude\\.credentials.json",
    "cat /c/Users/someone/.claude/.credentials.json",
    "cat ~/.claude/.credentials.json",
    "cat C:/Users/Someone/.claude.json",
  ]) {
    expect([command, decideAgentCall({ ...winBase, tool: "Bash", input: { command } }).kind]).toEqual([command, "deny"]);
  }
  expect(touchesClaudeCredentials("ls ~/.claudex", WIN_HOME, "win32")).toBe(false);
  const configDirs = [`${WIN_HOME}\\cc-work`, "D:\\claude-acct"];
  for (const command of ["type %USERPROFILE%\\cc-work\\.claude.json", "Get-Content $env:USERPROFILE/CC-WORK/x", "cat /c/Users/someone/cc-work/x",
    "cat ~/cc-work/.claude.json", "type d:\\Claude-Acct\\.credentials.json", "cat /d/claude-acct/x"]) {
    expect(touchesClaudeCredentials(command, WIN_HOME, "win32", configDirs)).toBe(true);
  }
  expect(touchesClaudeCredentials("dir %USERPROFILE%\\cc-work2", WIN_HOME, "win32", configDirs)).toBe(false);
  expect(isClaudeCredentialPath("c:\\users\\someone\\CC-WORK\\.claude.json", WIN_HOME, "win32", configDirs)).toBe(true);
  expect(isClaudeCredentialPath(`${WIN_HOME}\\projects\\.claude-notes`, WIN_HOME, "win32")).toBe(false);
});

test("on Windows, a write runs or asks by the mode wherever it lands, and a path with no drive is refused with where the workspace is", () => {
  expect(decideAgentCall({ ...winBase, tool: "Write", input: { file_path: `${WIN_WS}\\notes\\a.md` } }))
    .toEqual({ kind: "allow", effect: true, appName: "write_file", target: "notes/a.md" });
  expect(decideAgentCall({ ...winBase, tool: "Write", input: { file_path: `${WIN_HOME}\\Documents\\x.md` } }).kind).toBe("allow");
  const asked = decideAgentCall({ ...winBase, permission: "ask_first", tool: "Write", input: { file_path: `${WIN_HOME}\\Documents\\x.md` } });
  expect(asked.kind).toBe("ask");
  if (asked.kind === "ask") expect(asked.approval).toMatchObject({ kind_key: "file-write", target: `${WIN_HOME}\\Documents\\x.md` });
  expect(decideAgentCall({ ...winBase, permission: "read_only", tool: "Read", input: { file_path: "C:\\Windows\\System32\\drivers\\etc\\hosts" } }).kind).toBe("allow");
  for (const file_path of ["/work/job-x/a.md", "\\notes.md", "/c/Users/Someone/ws/a.md"]) {
    const call = decideAgentCall({ ...winBase, tool: "Write", input: { file_path } });
    expect([file_path, call.kind]).toEqual([file_path, "deny"]);
    if (call.kind === "deny") expect(call.reason).toContain(WIN_WS);
  }
});

test("on Windows, Claude Code's Bash is Git Bash: a command runs or asks by the mode, its card naming where it runs", () => {
  expect(decideAgentCall({ ...winBase, tool: "Bash", input: { command: "ls -la notes" } }).kind).toBe("allow");
  expect(decideAgentCall({ ...winBase, tool: "Bash", input: { command: "cat /c/Users/Someone/Documents/x.md" } }).kind).toBe("allow");
  const asked = decideAgentCall({ ...winBase, permission: "ask_first", tool: "Bash", input: { command: "cat /c/Users/Someone/Documents/x.md" } });
  expect(asked.kind).toBe("ask");
  if (asked.kind === "ask") expect(asked.approval).toMatchObject({ kind_key: "shell", target: WIN_WS });
});

test("on Windows, a project session's memory opens with the file tools however its path is spelled; the rest of .claude does not", () => {
  const memory = `${WIN_HOME}\\.claude\\projects\\C--Users-Someone-ws\\memory`;
  const at = { ...winBase, memoryDirs: [memory] };
  for (const file_path of [`${memory}\\MEMORY.md`, "c:/users/someone/.CLAUDE/projects/c--users-someone-ws/memory/a.md", "~\\.claude\\projects\\C--Users-Someone-ws\\memory\\a.md"]) {
    expect([file_path, decideAgentCall({ ...at, tool: "Read", input: { file_path } }).kind]).toEqual([file_path, "allow"]);
  }
  for (const file_path of [`${memory}\\..\\..\\..\\.credentials.json`, `${WIN_HOME}\\.claude\\.credentials.json`, "/c/Users/Someone/.claude/projects/C--Users-Someone-ws/memory/a.md"]) {
    expect([file_path, decideAgentCall({ ...at, tool: "Read", input: { file_path } }).kind]).toEqual([file_path, "deny"]);
  }
});

posixTest("plan mode changes nothing but the plan: its file is written in every mode, any other write waits for the plan", () => {
  const configDir = join(home, ".claude");
  const plans = join(configDir, "plans");
  const plan = { on: true, dirs: [plans] };
  for (const permission of ["read_only", "ask_first", "auto", "allow_all"] as const) {
    expect(decideAgentCall({ ...base, permission, plan, tool: "Write", input: { file_path: join(plans, "cozy-newt.md") } }))
      .toEqual({ kind: "allow", effect: false, appName: "write_file", target: join(plans, "cozy-newt.md") });
    const refused = decideAgentCall({ ...base, permission, plan, tool: "Edit", input: { file_path: join(root, "a.md") } });
    expect(refused.kind).toBe("deny");
    if (refused.kind === "deny") expect(refused.reason).toContain("plan mode is on");
  }
  // Its saved plans read in any mode, as its memory does; written by the mode once plan mode is off.
  const off = { on: false, dirs: [plans] };
  expect(decideAgentCall({ ...base, permission: "read_only", plan: off, tool: "Read", input: { file_path: join(plans, "cozy-newt.md") } }).kind).toBe("allow");
  expect(decideAgentCall({ ...base, permission: "ask_first", plan: off, tool: "Write", input: { file_path: join(plans, "cozy-newt.md") } }).kind).toBe("ask");
  // The rest of the config directory stays shut, plan mode or not, and so does a climb out of the plans.
  for (const file_path of [join(configDir, ".credentials.json"), join(plans, "..", "settings.json")]) {
    expect([file_path, decideAgentCall({ ...base, plan, tool: "Read", input: { file_path } }).kind]).toEqual([file_path, "deny"]);
  }
  const named = decideAgentCall({ ...base, plan, tool: "Bash", input: { command: `cat ${join(plans, "cozy-newt.md")}` } });
  expect(named.kind).toBe("deny");
  if (named.kind === "deny") expect(named.reason).toContain("saved plans open with Read");
});

posixTest("plan mode: a command goes by the permission mode, as with plan mode off", () => {
  const plan = { on: true, dirs: [join(home, ".claude", "plans")] };
  for (const on of [true, false]) {
    for (const permission of ["auto", "allow_all"] as const) {
      expect(decideAgentCall({ ...base, permission, plan: { ...plan, on }, tool: "Bash", input: { command: "git log --oneline" } }))
        .toEqual({ kind: "allow", effect: true, appName: "shell", target: "git log --oneline" });
    }
    const asked = decideAgentCall({ ...base, permission: "ask_first", plan: { ...plan, on }, tool: "Bash", input: { command: "git log --oneline" } });
    expect(asked.kind).toBe("ask");
    if (asked.kind === "ask") expect(asked.approval).toEqual({ kind_key: "shell", target: root, summary: "shell git log --oneline" });
    expect(decideAgentCall({ ...base, permission: "read_only", plan: { ...plan, on }, tool: "Bash", input: { command: "git log --oneline" } }).kind).toBe("deny");
  }
  // Reads and the to-do list are not changes.
  expect(decideAgentCall({ ...base, plan, tool: "Grep", input: { pattern: "x", path: root } }).kind).toBe("allow");
  expect(decideAgentCall({ ...base, plan, tool: "TodoWrite", input: {} }).kind).toBe("allow");
});

test("the plan it presents is a card of its own in every mode; a Bot is never offered ExitPlanMode", () => {
  const plan = { on: true, dirs: ["/Users/someone/.claude/plans"] };
  for (const permission of ["read_only", "auto", "allow_all"] as const) {
    const asked = decideAgentCall({ ...base, permission, plan, tool: "ExitPlanMode", input: { plan: "# 计划\n1. 写", planFilePath: "/Users/someone/.claude/plans/p.md" } });
    expect(asked).toEqual({ kind: "ask", effect: false, appName: "ExitPlanMode", approval: { kind_key: "plan", target: "/Users/someone/.claude/plans/p.md", summary: "# 计划\n1. 写" } });
  }
  expect(decideAgentCall({ ...base, tool: "ExitPlanMode", input: { plan: "x" } }).kind).toBe("deny");
  expect(decideAgentCall({ ...base, plan, tool: "EnterPlanMode", input: {} }).kind).toBe("deny");
});
