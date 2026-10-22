/**
 * The app's rules for a Claude Agent turn's own tool calls (ADR 0061), decided before Claude Code
 * runs them: the permission mode every Bot has (ADR 0092: reads run, a write or a command runs,
 * waits for your OK or is refused as the mode says, wherever it lands), the same recursive-search
 * refusal, nothing outside a short list of Claude Code's tools, nothing in the background, and
 * never Claude Code's own credentials — though a project session's file tools reach its memory of
 * that project and its saved plans, which live among them. A project session in plan mode (ADR
 * 0098) writes no file but its plan until you approve it; its commands go by the permission mode,
 * as at any other time. Pure: everything it needs is passed in,
 * so the rules are tested on their own — the Windows ones too, on a fake disk (`host`).
 */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { PLAN_APPROVAL_KIND, type PermissionMode } from "@real-bot/protocol";
import { FILE_WRITE_KIND, READ_ONLY_REFUSAL, SHELL_KIND, changeVerdict } from "../permission-gate";
import { isAgentCredentialPath, touchesAgentCredentials } from "../engine/agent/credentials";
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
  /** Your Claude accounts' config directories listed in Settings: as off limits as `~/.claude`. */
  configDirs?: string[];
  /**
   * Claude Code's memory folders for this project (a project session's, ADR 0095): inside its
   * config directory, yet its file tools read and write there as in any folder outside.
   */
  memoryDirs?: string[];
  /**
   * A project session's plan mode (ADR 0098): whether it is on, and the folders Claude Code saves
   * its plans in (inside its config directory, open to its file tools as `memoryDirs` are). Absent
   * for a Bot, which is never offered `ExitPlanMode`.
   */
  plan?: { on: boolean; dirs: string[] };
  /** The Bot's permission mode (ADR 0092): whether a write or a command runs, asks or is refused. */
  permission: PermissionMode;
  /** Whether a path exists; the disk's own when absent. */
  exists?: (path: string) => boolean;
  /** The file system and its rules; this machine's when absent. */
  host?: PathHost;
};

export type AgentDecision =
  | { kind: "allow"; effect: boolean; appName: string; target?: string }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; effect: boolean; appName: string; approval: { kind_key: string; target: string; summary: string } };

/**
 * A change — a write or a command — as the Bot's permission mode has it (ADR 0092): `allow` as
 * given, a card with `approval`, or the read-only refusal.
 */
export function gateChange(
  mode: PermissionMode,
  allow: Extract<AgentDecision, { kind: "allow" }>,
  approval: { kind_key: string; target: string; summary: string },
): AgentDecision {
  const verdict = changeVerdict(mode);
  if (verdict === "allow") return allow;
  if (verdict === "refuse") return { kind: "deny", reason: READ_ONLY_REFUSAL };
  return { kind: "ask", effect: allow.effect, appName: allow.appName, approval };
}

/** What to do with one call. `effect` calls also pass the app's effect gate before they run. */
export function decideAgentCall(call: AgentCall): AgentDecision {
  const host = call.host ?? nodePathHost;
  const platform = host.platform;
  const home = call.home ?? host.homedir();
  const appName = appToolName(call.tool);
  const known = (AGENT_WORK_TOOLS as readonly string[]).includes(call.tool) || call.tool === "MultiEdit" || (call.plan !== undefined && call.tool === "ExitPlanMode");
  if (!known) return { kind: "deny", reason: `${call.tool} is not available in a Deskfolk turn` };
  // The plan it presents is yours to approve, whatever the mode: approving is what ends planning.
  if (call.tool === "ExitPlanMode") return { kind: "ask", effect: false, appName, approval: planApproval(call.input) };
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
    if (touchesClaudeCredentials(command, home, platform, call.configDirs)) {
      // Its memory and plans are open to the file tools only: a command could `cd` there and on to the rest.
      const memory = call.memoryDirs?.some((dir) => namesDir(command, dir, home, platform));
      const plans = call.plan?.dirs.some((dir) => namesDir(command, dir, home, platform));
      return { kind: "deny", reason: memory ? MEMORY_BY_FILE_TOOLS : plans ? PLANS_BY_FILE_TOOLS : "Claude Code's own settings and credentials are off limits" };
    }
    // Every other local agent's too (ADR 0079): a Bot reads no agent's sign-in, its own or another's.
    if (touchesAgentCredentials(command, home, platform, call.configDirs)) {
      return { kind: "deny", reason: "your local agents' own settings and credentials are off limits" };
    }
    const hit = recursiveSearchGuard(call.workspace, command, call.cwd, host);
    if (hit) return { kind: "deny", reason: searchGuardMessage(hit) };
    // Claude Code's Bash on Windows is Git Bash, so `/c/Users/…` is read as Git Bash reads it.
    const classified = classifyShell(call.workspace, command, call.cwd, host, platform === "win32" ? "bash" : undefined);
    // Plan mode too: Claude Code's plan mode is what keeps its commands to looking.
    return gateChange(call.permission,
      { kind: "allow", effect: true, appName, target: command },
      { kind_key: SHELL_KIND, target: classified.cwdAbs, summary: `${SHELL_KIND} ${command}` });
  }

  const raw = pathOf(call);
  const abs = raw === null ? call.cwd : anchorAt(call.cwd, expandHome(raw, home, platform), platform);
  // A Git Bash spelling (`/c/Users/…`) names the same file to Claude Code as `C:\Users\…` may.
  const named = [abs, ...(platform === "win32" && raw ? [gitBashToWindows(raw)].filter((path): path is string => path !== null) : [])];
  // The project's memory and the saved plans hold no sign-in: open as a folder outside is, while the
  // path and where its links lead stay in it.
  const plans = named.every((path) => inMemoryDir(path, call.plan?.dirs ?? [], host)) && !globLeaves(call, platform);
  const memory = plans || (named.every((path) => inMemoryDir(path, call.memoryDirs ?? [], host)) && !globLeaves(call, platform));
  if (!memory && named.some((path) => isClaudeCredentialPath(path, home, platform, call.configDirs))) {
    return { kind: "deny", reason: "Claude Code's own settings and credentials are off limits" };
  }
  if (!memory && named.some((path) => isAgentCredentialPath(path, home, platform, call.configDirs))) {
    return { kind: "deny", reason: "your local agents' own settings and credentials are off limits" };
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
  const target = classified.zone === "inside" ? classified.rel : classified.abs;
  // Plan mode: the plan is the one thing it writes, as its to-do list is, in every permission mode;
  // anything else waits for the plan to be approved.
  if (WRITES.has(call.tool) && call.plan?.on) {
    return plans ? { kind: "allow", effect: false, appName, target } : { kind: "deny", reason: PLAN_MODE_REFUSAL };
  }
  if (WRITES.has(call.tool)) {
    return gateChange(call.permission, { kind: "allow", effect: true, appName, target },
      { kind_key: FILE_WRITE_KIND, target: classified.abs, summary: `${FILE_WRITE_KIND} ${classified.abs}` });
  }
  if (READS.has(call.tool)) return { kind: "allow", effect: false, appName, target };
  return { kind: "deny", reason: `${call.tool} is not available in a Deskfolk turn` };
}

const PLAN_MODE_REFUSAL = "plan mode is on: nothing changes before the user approves your plan. Write the plan to your plan file and present it with ExitPlanMode";

/** The plan `ExitPlanMode` presents, as its card: Claude Code puts the plan and its file in the call. */
export function planApproval(input: Record<string, unknown>): { kind_key: string; target: string; summary: string } {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const file = typeof input.planFilePath === "string" ? input.planFilePath : "";
  return { kind_key: PLAN_APPROVAL_KIND, target: file, summary: plan };
}

const MEMORY_BY_FILE_TOOLS = "Claude Code's memory files for this project open with Read, Write, Edit, Glob and Grep, not in a command; its other settings and credentials are off limits";
const PLANS_BY_FILE_TOOLS = "Claude Code's saved plans open with Read, Write, Edit, Glob and Grep, not in a command; its other settings and credentials are off limits";

/**
 * Whether a file tool's path is in one of the memory folders: as named, and, as far as it exists,
 * where its links lead (a link there to `~/.claude.json` is that file). A dangling link is not.
 */
function inMemoryDir(path: string, dirs: string[], host: PathHost): boolean {
  const dir = dirs.find((candidate) => isWithinPath(candidate, path, host.platform));
  if (dir === undefined) return false;
  const realDir = throughLinks(dir, host);
  const realPath = throughLinks(path, host);
  return realDir !== null && realPath !== null && isWithinPath(realDir, realPath, host.platform);
}

/** A path with its nearest part on disk resolved through links and the rest as named; null at a dangling link. */
function throughLinks(path: string, host: PathHost): string | null {
  const p = host.platform === "win32" ? win32 : posix;
  const rest: string[] = [];
  for (let at = path; ;) {
    try {
      return p.join(host.realpath(at), ...rest);
    } catch {
      // not there, or a link to nothing
    }
    try {
      if (host.lstat(at).isSymbolicLink()) return null;
    } catch {
      // not there: look one folder up
    }
    const up = p.dirname(at);
    if (up === at) return null;
    rest.unshift(p.basename(at));
    at = up;
  }
}

/** A Glob pattern that leaves the folder it searches: absolute, from `~`, or climbing with `..`. */
function globLeaves(call: AgentCall, platform: NodeJS.Platform): boolean {
  const pattern = call.tool === "Glob" ? call.input.pattern : undefined;
  return typeof pattern === "string" && (isAbsoluteHostPath(pattern, platform) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes(".."));
}

/** The path a file tool names: `file_path`, `notebook_path`, or a search's `path` (its cwd when absent). */
export function pathOf(call: Pick<AgentCall, "input">): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = call.input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function expandHome(path: string, home: string, platform: NodeJS.Platform): string {
  if (path === "~") return home;
  if (platform === "win32" ? /^~[\\/]/.test(path) : path.startsWith("~/")) return (platform === "win32" ? win32 : posix).join(home, path.slice(2));
  return path;
}

/**
 * Where a file tool's path points from `cwd`. On Windows only a plain relative path is joined: a
 * rooted (`\x`) or drive-relative (`C:x`) one is anchored by the classifier, as Win32 opens it.
 */
export function anchorAt(cwd: string, path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return posix.resolve(cwd, path);
  return /^(?:[A-Za-z]:|[\\/])/.test(path) ? path : win32.join(cwd, path);
}

/** Git Bash's `/c/Users/…` as the Windows path it stands for; null for anything else. */
export function gitBashToWindows(path: string): string | null {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(path);
  return match ? `${match[1]!.toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}` : null;
}

/**
 * `~/.claude`, `~/.claude.json`, the keychains and the config directories your other Claude accounts
 * live in (`configDirs`): where Claude Code keeps what signs it in.
 */
export function isClaudeCredentialPath(abs: string, home: string, platform: NodeJS.Platform = process.platform, configDirs: string[] = []): boolean {
  if (!isAbsoluteHostPath(abs, platform)) return false;
  const norm = platform === "win32" ? abs : posix.resolve(abs);
  if (platform !== "win32" && (norm.startsWith(`${posix.join(home, "Library", "Keychains")}/`) || norm.startsWith("/Library/Keychains/"))) return true;
  if (configDirs.some((dir) => isWithinPath(dir, norm, platform))) return true;
  if (!isWithinPath(home, norm, platform)) return false;
  // Names compare as the file system does: regardless of case on Windows.
  const rel = workspaceRelative(home, norm, platform);
  const name = platform === "win32" ? rel.toLowerCase() : rel;
  return name === ".claude" || name.startsWith(".claude/") || name === ".claude.json" || name.startsWith(".claude.json.");
}

/**
 * A command that names Claude Code's own config — `~/.claude`, `~/.claude.json`, or one of your
 * accounts' config directories (`configDirs`) — or asks the keychain for a secret.
 */
export function touchesClaudeCredentials(command: string, home: string, platform: NodeJS.Platform = process.platform, configDirs: string[] = []): boolean {
  if (configDirs.some((dir) => namesDir(command, dir, home, platform))) return true;
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

/**
 * Whether a command names `dir` or something in it: spelled out, or under your home folder through
 * `~`, `$HOME` (and on Windows `%USERPROFILE%` and the like), either slash on Windows, any case there.
 * A longer name that only starts the same (`~/.claude-b2` for `~/.claude-b`) is another directory.
 */
function namesDir(command: string, dir: string, home: string, platform: NodeJS.Platform): boolean {
  const win = platform === "win32";
  const sep = win ? "[\\\\/]+" : "/+";
  const spelled = (path: string) => path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).map(escapeRegExp).join(sep);
  // Spelled out: `/Users/a/cc`; on Windows `C:\Users\a\cc` with either slash, Git Bash's
  // `/c/Users/a/cc`, or a share's `\\server\share\cc`.
  const prefixes: string[] = [];
  if (!win) prefixes.push(`/${spelled(dir)}`);
  else if (/^\\\\/.test(dir)) prefixes.push(`[\\\\/]{2}${spelled(dir)}`);
  else {
    prefixes.push(spelled(dir));
    const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(dir);
    if (drive) prefixes.push(`[\\\\/]${drive[1]}${sep}${spelled(drive[2]!)}`);
  }
  if (dir.length > home.length && isWithinPath(home, dir, platform)) {
    const rel = spelled(dir.slice(home.length));
    const homes = win
      ? ["~", "\\$HOME", "\\$\\{HOME\\}", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", "%HOMEDRIVE%%HOMEPATH%"]
      : ["~", "\\$HOME", "\\$\\{HOME\\}"];
    for (const spelling of homes) prefixes.push(`${spelling}${sep}${rel}`);
  }
  return new RegExp(`(?:${prefixes.join("|")})(?![A-Za-z0-9._-])`, win ? "i" : "").test(command);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
