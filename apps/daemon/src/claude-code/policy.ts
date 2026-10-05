/**
 * The app's rules for a Claude Agent turn's own tool calls (ADR 0061), decided before Claude Code
 * runs them: the same workspace boundary every Bot has (inside runs, crossing out waits for your
 * OK unless an always-allow rule covers it), the same recursive-search refusal, nothing outside a
 * short list of Claude Code's tools, nothing in the background, and never Claude Code's own
 * credentials. Pure: everything it needs is passed in, so the rules are tested on their own — the
 * Windows ones too, on a fake disk (`host`).
 */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { recursiveSearchGuard, searchGuardMessage } from "../search-guard";
import { classifyPath, classifyShell, isAbsoluteHostPath, isWithinPath, nodePathHost, workspaceRelative, type PathHost } from "../workspace-paths";

/** The Claude Code tools a work turn is offered; anything else is refused. */
export const AGENT_WORK_TOOLS = ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Agent", "TodoWrite"] as const;
/** A read-only turn's: it can look and answer, nothing else (ADR 0040 I2). */
export const AGENT_READONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READS = new Set(["Read", "Glob", "Grep"]);
/** Tools that change nothing the app tracks and need no gate. */
const FREE = new Set(["WebFetch", "WebSearch", "TodoWrite"]);

/** The app tool a Claude Code call stands for, for its frames, records and the effect gate. */
export function appToolName(tool: string): string {
  if (tool === "Bash") return "shell";
  if (WRITES.has(tool)) return "write_file";
  if (tool === "Read") return "read_file";
  if (tool === "Glob" || tool === "Grep") return "list_dir";
  return tool;
}

export type AgentCall = {
  tool: string;
  input: Record<string, unknown>;
  /** Claude Code's current directory for the call (Bash keeps the one its last `cd` left). */
  cwd: string;
  /** Set when a subagent makes the call. */
  agentId?: string | null;
  mode: "work" | "desk" | "readonly";
  workspace: string;
  home?: string;
  /** Whether an always-allow rule you made covers this kind of call there. */
  allowed: (kind: string, target: string) => boolean;
  /** Whether a path exists; the disk's own when absent. */
  exists?: (path: string) => boolean;
  /** The file system and its rules; this machine's when absent. */
  host?: PathHost;
};

export type AgentDecision =
  | { kind: "allow"; effect: boolean; appName: string; target?: string }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; effect: boolean; appName: string; approval: { kind_key: string; target: string; summary: string } };

/** What to do with one call. `effect` calls also pass the app's effect gate before they run. */
export function decideAgentCall(call: AgentCall): AgentDecision {
  const host = call.host ?? nodePathHost;
  const platform = host.platform;
  const home = call.home ?? host.homedir();
  const appName = appToolName(call.tool);
  const known = (AGENT_WORK_TOOLS as readonly string[]).includes(call.tool) || call.tool === "MultiEdit";
  if (!known) return { kind: "deny", reason: `${call.tool} is not available in a Deskfolk turn` };
  if (call.mode === "readonly" && !(AGENT_READONLY_TOOLS as readonly string[]).includes(call.tool)) {
    return { kind: "deny", reason: "this is a read-only turn (a stop holds this work): look and answer, nothing else" };
  }
  if (call.input.run_in_background === true) {
    return { kind: "deny", reason: "background tasks are not available here: run it in the foreground and wait for it" };
  }
  if (call.tool === "Agent") {
    const isolation = call.input.isolation;
    if (typeof isolation === "string" && isolation !== "none") return { kind: "deny", reason: "subagents run here, in this workspace" };
    return { kind: "allow", effect: false, appName };
  }
  if (FREE.has(call.tool)) return { kind: "allow", effect: false, appName };

  if (call.tool === "Bash") {
    const command = typeof call.input.command === "string" ? call.input.command : "";
    if (touchesClaudeCredentials(command, home, platform)) {
      return { kind: "deny", reason: "Claude Code's own settings and credentials are off limits" };
    }
    const hit = recursiveSearchGuard(call.workspace, command, call.cwd, host);
    if (hit) return { kind: "deny", reason: searchGuardMessage(hit) };
    // Claude Code's Bash on Windows is Git Bash, so `/c/Users/…` is read as Git Bash reads it.
    const classified = classifyShell(call.workspace, command, call.cwd, host, platform === "win32" ? "bash" : undefined);
    if (classified.kind === "jailed") return { kind: "allow", effect: true, appName, target: command };
    if (call.allowed("unconstrained-shell", classified.cwdAbs)) return { kind: "allow", effect: true, appName, target: command };
    return { kind: "ask", effect: true, appName, approval: { kind_key: "unconstrained-shell", target: classified.cwdAbs, summary: `unconstrained-shell ${command}` } };
  }

  const raw = pathOf(call);
  const abs = raw === null ? call.cwd : anchorAt(call.cwd, expandHome(raw, home, platform), platform);
  // A Git Bash spelling (`/c/Users/…`) names the same file to Claude Code as `C:\Users\…` may.
  const named = [abs, ...(platform === "win32" && raw ? [gitBashToWindows(raw)].filter((path): path is string => path !== null) : [])];
  if (named.some((path) => isClaudeCredentialPath(path, home, platform))) {
    return { kind: "deny", reason: "Claude Code's own settings and credentials are off limits" };
  }
  // On Windows a path with no drive ("/work/a.md", "/c/Users/…") opens on whichever drive the
  // process is on, or as Git Bash would read it: which one is not ours to guess, nor yours to approve.
  if (platform === "win32" && raw !== null && /^[\\/](?![\\/])/.test(raw)) {
    return { kind: "deny", reason: `${raw} is not a Windows path: name files with their drive (C:\\…). The workspace root is ${call.workspace} and this call's directory is ${call.cwd}.` };
  }
  const classified = classifyPath(call.workspace, abs, host);
  // Outside the workspace under a top-level folder the disk does not have: a workspace path written
  // as if the workspace were `/` ("/work/…/a.md", "/notes.md"). Nothing can be read or written
  // there, so a card would only ask you about the mistake; Claude Code hears where the workspace is.
  // POSIX paths only: a Windows path has no such top.
  const top = platform !== "win32" && abs.startsWith("/") ? abs.split("/").find(Boolean) : undefined;
  if (classified.zone !== "inside" && (WRITES.has(call.tool) || READS.has(call.tool)) && top && !(call.exists ?? existsSync)(`/${top}`)) {
    return { kind: "deny", reason: `${abs} does not exist and is not in the workspace. The workspace root is ${call.workspace} and this call's directory is ${call.cwd}: put a workspace path after the root and use the absolute path.` };
  }
  if (WRITES.has(call.tool)) {
    if (classified.zone === "inside") return { kind: "allow", effect: true, appName, target: classified.rel };
    if (call.allowed("outside-write", classified.abs)) return { kind: "allow", effect: true, appName, target: classified.abs };
    return { kind: "ask", effect: true, appName, approval: { kind_key: "outside-write", target: classified.abs, summary: `outside-write ${classified.abs}` } };
  }
  if (READS.has(call.tool)) {
    if (classified.zone === "inside") return { kind: "allow", effect: false, appName, target: classified.rel };
    if (call.allowed("outside-read", classified.abs)) return { kind: "allow", effect: false, appName, target: classified.abs };
    return { kind: "ask", effect: false, appName, approval: { kind_key: "outside-read", target: classified.abs, summary: `outside-read ${classified.abs}` } };
  }
  return { kind: "deny", reason: `${call.tool} is not available in a Deskfolk turn` };
}

/** The path a file tool names: `file_path`, `notebook_path`, or a search's `path` (its cwd when absent). */
function pathOf(call: AgentCall): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = call.input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function expandHome(path: string, home: string, platform: NodeJS.Platform): string {
  if (path === "~") return home;
  if (platform === "win32" ? /^~[\\/]/.test(path) : path.startsWith("~/")) return (platform === "win32" ? win32 : posix).join(home, path.slice(2));
  return path;
}

/**
 * Where a file tool's path points from `cwd`. On Windows only a plain relative path is joined: a
 * rooted (`\x`) or drive-relative (`C:x`) one is anchored by the classifier, as Win32 opens it.
 */
function anchorAt(cwd: string, path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return posix.resolve(cwd, path);
  return /^(?:[A-Za-z]:|[\\/])/.test(path) ? path : win32.join(cwd, path);
}

/** Git Bash's `/c/Users/…` as the Windows path it stands for; null for anything else. */
function gitBashToWindows(path: string): string | null {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(path);
  return match ? `${match[1]!.toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}` : null;
}

/** `~/.claude`, `~/.claude.json` and the keychains: where Claude Code keeps what signs it in. */
export function isClaudeCredentialPath(abs: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isAbsoluteHostPath(abs, platform)) return false;
  const norm = platform === "win32" ? abs : posix.resolve(abs);
  if (platform !== "win32" && (norm.startsWith(`${posix.join(home, "Library", "Keychains")}/`) || norm.startsWith("/Library/Keychains/"))) return true;
  if (!isWithinPath(home, norm, platform)) return false;
  // Names compare as the file system does: regardless of case on Windows.
  const rel = workspaceRelative(home, norm, platform);
  const name = platform === "win32" ? rel.toLowerCase() : rel;
  return name === ".claude" || name.startsWith(".claude/") || name === ".claude.json" || name.startsWith(".claude.json.");
}

/** A command that names Claude Code's own config or asks the keychain for a secret. */
export function touchesClaudeCredentials(command: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") {
    const claude = new RegExp(`(~|\\$HOME|\\$\\{HOME\\}|${escapeRegExp(home)})/\\.claude(\\.json|/|\\b)`);
    if (claude.test(command)) return true;
    return /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(command);
  }
  // Windows: the home folder as Git Bash, cmd and PowerShell spell it, either slash, any case.
  const spelled = (path: string) => path.split(/[\\/]+/).filter(Boolean).map(escapeRegExp).join("[\\\\/]+");
  const homes = ["~", "\\$HOME", "\\$\\{HOME\\}", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", "%HOMEDRIVE%%HOMEPATH%", spelled(home)];
  const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(home);
  if (drive) homes.push(`[\\\\/]${drive[1]}[\\\\/]+${spelled(drive[2]!)}`);
  return new RegExp(`(?:${homes.join("|")})[\\\\/]+\\.claude(?:\\.json|[\\\\/]|\\b)`, "i").test(command);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
