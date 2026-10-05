import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { PathHost } from "../workspace-paths";
import { appToolName, decideAgentCall, isClaudeCredentialPath, touchesClaudeCredentials, type AgentCall } from "./policy";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-policy-")));
// Outside the workspace, already a real path (macOS's /etc is a link to /private/etc).
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "agent-policy-out-")));
const hosts = join(elsewhere, "hosts");
const home = "/Users/someone";
const base: Omit<AgentCall, "tool" | "input"> = { cwd: root, mode: "work", workspace: root, home, allowed: () => false };
// These read this machine's disk with POSIX paths; the Windows rules have their own tests below,
// on a fake Windows disk, which run everywhere.
const posixTest = test.skipIf(process.platform === "win32");

posixTest("inside the workspace a write runs and counts as an effect; outside it asks as outside-write", () => {
  expect(decideAgentCall({ ...base, tool: "Write", input: { file_path: join(root, "a.md") } })).toEqual({ kind: "allow", effect: true, appName: "write_file", target: "a.md" });
  const outside = decideAgentCall({ ...base, tool: "Edit", input: { file_path: hosts } });
  expect(outside.kind).toBe("ask");
  if (outside.kind === "ask") expect(outside.approval).toEqual({ kind_key: "outside-write", target: hosts, summary: `outside-write ${hosts}` });
});

posixTest("a workspace path written as if the workspace were / is refused with where the workspace is, not put on a card", () => {
  const exists = (path: string) => path !== "/work" && path !== "/hello.txt";
  for (const [tool, file_path] of [["Write", "/work/job-x/01-a/hello.txt"], ["Write", "/hello.txt"], ["Read", "/work/job-x/notes.md"]] as const) {
    const call = decideAgentCall({ ...base, exists, tool, input: { file_path } });
    expect(call.kind).toBe("deny");
    if (call.kind === "deny") expect(call.reason).toContain(`The workspace root is ${root}`);
  }
  // A real place outside still asks.
  expect(decideAgentCall({ ...base, exists, tool: "Read", input: { file_path: hosts } }).kind).toBe("ask");
});

posixTest("an always-allow rule you made lets the same kind of call through without a card", () => {
  const call = decideAgentCall({ ...base, allowed: (kind) => kind === "outside-read", tool: "Read", input: { file_path: hosts } });
  expect(call).toEqual({ kind: "allow", effect: false, appName: "read_file", target: hosts });
});

posixTest("a command that stays in the workspace runs; one that reaches out asks as unconstrained-shell", () => {
  expect(decideAgentCall({ ...base, tool: "Bash", input: { command: "ls -la" } }).kind).toBe("allow");
  const out = decideAgentCall({ ...base, tool: "Bash", input: { command: "cat /etc/hosts" } });
  expect(out.kind).toBe("ask");
  if (out.kind === "ask") expect(out.approval.kind_key).toBe("unconstrained-shell");
});

posixTest("a recursive search over the home folder is refused, as for every Bot", () => {
  const call = decideAgentCall({ ...base, home: root, tool: "Bash", input: { command: "grep -r secret ~" } });
  expect(call.kind).toBe("deny");
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
const winBase: Omit<AgentCall, "tool" | "input"> = { cwd: WIN_WS, mode: "work", workspace: WIN_WS, home: WIN_HOME, allowed: () => false, host: winHost };

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
  expect(isClaudeCredentialPath(`${WIN_HOME}\\projects\\.claude-notes`, WIN_HOME, "win32")).toBe(false);
});

test("on Windows, inside the workspace runs, outside asks, and a path with no drive is refused with where the workspace is", () => {
  expect(decideAgentCall({ ...winBase, tool: "Write", input: { file_path: `${WIN_WS}\\notes\\a.md` } }))
    .toEqual({ kind: "allow", effect: true, appName: "write_file", target: "notes/a.md" });
  const outside = decideAgentCall({ ...winBase, tool: "Write", input: { file_path: `${WIN_HOME}\\Documents\\x.md` } });
  expect(outside.kind).toBe("ask");
  if (outside.kind === "ask") expect(outside.approval).toMatchObject({ kind_key: "outside-write", target: `${WIN_HOME}\\Documents\\x.md` });
  expect(decideAgentCall({ ...winBase, tool: "Read", input: { file_path: "C:\\Windows\\System32\\drivers\\etc\\hosts" } }).kind).toBe("ask");
  for (const file_path of ["/work/job-x/a.md", "\\notes.md", "/c/Users/Someone/ws/a.md"]) {
    const call = decideAgentCall({ ...winBase, tool: "Write", input: { file_path } });
    expect([file_path, call.kind]).toEqual([file_path, "deny"]);
    if (call.kind === "deny") expect(call.reason).toContain(WIN_WS);
  }
});

test("on Windows, Claude Code's Bash is Git Bash: /c/… paths are read the way it reads them", () => {
  expect(decideAgentCall({ ...winBase, tool: "Bash", input: { command: "ls -la notes" } }).kind).toBe("allow");
  const out = decideAgentCall({ ...winBase, tool: "Bash", input: { command: "cat /c/Users/Someone/Documents/x.md" } });
  expect(out.kind).toBe("ask");
  if (out.kind === "ask") expect(out.approval.kind_key).toBe("unconstrained-shell");
});
