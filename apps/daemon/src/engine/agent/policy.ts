/**
 * The app's rules for a local agent's own calls (ADR 0079), whichever agent makes them: each
 * agent's tools are first told as one of a few app actions — read a file, list or search, write
 * one, run a command, fetch from the web, something else — and then decided exactly as a Claude
 * Agent turn's are (ADR 0061, `claude-code/policy.ts`): reads run, a write or a command goes as the
 * Bot's permission mode says (ADR 0092), the same recursive-search refusal, nothing in the
 * background, and never any agent's own credentials. Pure, like Claude's.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { posix } from "node:path";
import { recursiveSearchGuard, searchGuardMessage } from "../../search-guard";
import { classifyPath, classifyShell, isWithinPath, nodePathHost, type PathHost } from "../../workspace-paths";
import type { PermissionMode } from "@real-bot/protocol";
import { anchorAt, expandHome, gateChange, gitBashToWindows, inMemoryDir, type AgentDecision } from "../../claude-code/policy";
import { FILE_WRITE_KIND, SHELL_KIND } from "../../permission-gate";
import { AGENT_CREDENTIALS_REFUSAL, isAgentCredentialPath, isAgentSecretPath, namesAgentSecret, namesAgentSettingsFile, touchesAgentCredentials, withoutHomeGlobs, withoutOpenDirs, withoutQuotedHomes } from "./credentials";

/** What a call of an agent's own does, as the app counts it. */
export type AppActionName = "shell" | "write_file" | "read_file" | "list_dir" | "web" | "other";

export type AppAction = {
  appName: AppActionName;
  /** The agent's own name for the tool, for what you read on a card and in records. */
  vendorTool: string;
  /** The files it names: absolute, or relative to `cwd`; empty when it names none. */
  paths: string[];
  /** For `shell`: the command as the shell reads it (any `sh -lc '…'` around it already taken off). */
  command?: string;
  cwd: string;
  /** It asked to run in the background. */
  background?: boolean;
};

export type ActionContext = {
  mode: "work" | "desk" | "readonly";
  workspace: string;
  home?: string;
  /** Your accounts' config directories listed in Settings, of every agent. */
  configDirs?: string[];
  /** The Bot's permission mode (ADR 0092): whether a write or a command runs, asks or is refused. */
  permission: PermissionMode;
  exists?: (path: string) => boolean;
  host?: PathHost;
  /**
   * Folders of the agent's own that this session may use as any folder outside the workspace (ADR
   * 0111): its memory, its skills, the plans and notes it writes for itself. A path in one — and,
   * as far as it exists, where its links lead — is no credential; a write there still goes by the
   * permission mode. A command may name them only where it cannot leave them (`withoutOpenDirs`).
   */
  openDirs?: string[];
  /**
   * Folders this session may read, and only read, wherever they are: your agents' conversation
   * records (`agentRecordDirs`, ADR 0095 addendum 2026-11-23). A file tool's read there runs, a
   * write is refused as the rest of an agent's folder is. A command may name them, and goes by the
   * permission mode as any command does; their being here also marks a project session, where a
   * command building paths the rules cannot place may name no sign-in or settings file instead
   * (`namesOnlyWhatOpens`).
   */
  readableDirs?: string[];
  /**
   * Set for a project session whose agent cannot be made to ask first (Antigravity, ADR 0111
   * addendum 2026-11-24): the folders of that agent itself. Its calls are checked as they run, so a
   * refusal here stops the turn and holds nothing back. For such a session its own agent's folders
   * are its own, as in its terminal, and your other agents' folders are read as any folder outside
   * the workspace: only what signs one of them in or sets it up is off limits, file by file
   * (`isAgentSecretPath`, `namesAgentSecret`). A file written into another agent's folder is still
   * refused: that changes how the other is set up.
   */
  ownAgentDirs?: string[];
  /** The folders in a folder, links to folders too; this machine's disk when absent. */
  foldersIn?: (dir: string) => string[];
};

/** The folders in `dir` on this machine's disk, a link counted by where it leads. */
function foldersIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(posix.join(dir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    }).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Whether a command that names your agents' own folders names only what this session may use: its
 * open folders and the records it reads, by path or by a glob over every account's folder. In a
 * project session (it has `readableDirs`) the rules also let through what they cannot place: a path
 * built on one of those folders, and an agent's folder handed as a quoted string to a program that
 * builds its own paths on it (`withoutQuotedHomes`). Such a command goes by the permission mode as
 * any command does, unless it also names a sign-in or settings file (ADR 0095 addendum 2026-11-23).
 */
function namesOnlyWhatOpens(command: string, ctx: ActionContext, host: PathHost, home: string, configDirs: string[]): boolean {
  const platform = host.platform;
  const open = [...(ctx.openDirs ?? []), ...(ctx.readableDirs ?? [])];
  let built = false;
  const unplaced = (ctx.readableDirs ?? []).length > 0 ? () => { built = true; } : undefined;
  const named = withoutOpenDirs(command, open, home, platform, (abs) => inMemoryDir(abs, open, host), unplaced);
  // Every account's folder at once (`~/.claude*/projects`): each folder the glob matches is read as if named.
  const globbed = named === null || open.length === 0 ? named
    : withoutHomeGlobs(named, home, platform, ctx.foldersIn ?? foldersIn, (abs) => inMemoryDir(abs, open, host) || !isAgentCredentialPath(abs, home, platform, configDirs), unplaced);
  const rest = globbed === null || !unplaced ? globbed : withoutQuotedHomes(globbed, home, platform, configDirs, unplaced);
  if (rest === null || touchesAgentCredentials(rest, home, platform, configDirs)) return false;
  return !(built && namesAgentSettingsFile(command));
}

/** Where a path leads through its links, when it is there; null when it is not. */
function realOf(path: string, host: PathHost): string | null {
  try {
    return host.realpath(path);
  } catch {
    return null;
  }
}

/** What to do with one call. `effect` calls also pass the app's effect gate before they run. */
export function decideAction(action: AppAction, ctx: ActionContext): AgentDecision {
  const host = ctx.host ?? nodePathHost;
  const platform = host.platform;
  const home = ctx.home ?? host.homedir();
  const configDirs = ctx.configDirs ?? [];
  const own = ctx.ownAgentDirs;
  const appName = action.appName;
  if (ctx.mode === "readonly" && !["read_file", "list_dir", "web"].includes(appName)) {
    return { kind: "deny", reason: "this is a read-only turn (a stop holds this work): look and answer, nothing else" };
  }
  if (action.background) return { kind: "deny", reason: "background tasks are not available here: run it in the foreground and wait for it" };
  if (appName === "shell") {
    const command = action.command ?? "";
    const refused = own
      ? namesAgentSecret(command, home, platform, configDirs, own, {
        open: (abs) => inMemoryDir(abs, ctx.openDirs ?? [], host),
        read: (abs) => inMemoryDir(abs, ctx.readableDirs ?? [], host),
        real: (abs) => realOf(abs, host),
      })
      : touchesAgentCredentials(command, home, platform, configDirs) && !namesOnlyWhatOpens(command, ctx, host, home, configDirs);
    if (refused) return { kind: "deny", reason: AGENT_CREDENTIALS_REFUSAL };
    const hit = recursiveSearchGuard(ctx.workspace, command, action.cwd, host);
    if (hit) return { kind: "deny", reason: searchGuardMessage(hit) };
    const classified = classifyShell(ctx.workspace, command, action.cwd, host, platform === "win32" ? "bash" : undefined);
    return gateChange(ctx.permission, { kind: "allow", effect: true, appName, target: command },
      { kind_key: SHELL_KIND, target: classified.cwdAbs, summary: `${SHELL_KIND} ${command}` });
  }
  if (appName === "web" || appName === "other") return { kind: "allow", effect: false, appName };

  const writes = appName === "write_file";
  const named = action.paths.length > 0 ? action.paths : [action.cwd];
  const targets: Array<{ shown: string; abs: string }> = [];
  for (const raw of named) {
    const abs = anchorAt(action.cwd, expandHome(raw, home, platform), platform);
    const spellings = [abs, ...(platform === "win32" ? [gitBashToWindows(raw)].filter((path): path is string => path !== null) : [])];
    const open = spellings.every((path) => inMemoryDir(path, ctx.openDirs ?? [], host))
      || (!writes && spellings.every((path) => inMemoryDir(path, ctx.readableDirs ?? [], host)));
    // Every agent's folder is shut, or (`ownAgentDirs`) only the files that sign one in or set it up, and writing into another's.
    const shut = own
      ? spellings.some((path) => {
        const real = realOf(path, host);
        if (isAgentSecretPath(path, home, platform, configDirs, own) || (real !== null && isAgentSecretPath(real, home, platform, configDirs, own))) return true;
        return writes && isAgentCredentialPath(path, home, platform, configDirs) && !own.some((dir) => isWithinPath(dir, path, platform));
      })
      : spellings.some((path) => isAgentCredentialPath(path, home, platform, configDirs));
    if (!open && shut) return { kind: "deny", reason: AGENT_CREDENTIALS_REFUSAL };
    if (platform === "win32" && /^[\\/](?![\\/])/.test(raw)) {
      return { kind: "deny", reason: `${raw} is not a Windows path: name files with their drive (C:\\…). The workspace root is ${ctx.workspace} and this call's directory is ${action.cwd}.` };
    }
    const classified = classifyPath(ctx.workspace, abs, host);
    const top = platform !== "win32" && abs.startsWith("/") ? abs.split("/").find(Boolean) : undefined;
    if (classified.zone !== "inside" && top && !(ctx.exists ?? existsSync)(`/${top}`)) {
      return { kind: "deny", reason: `${abs} does not exist and is not in the workspace. The workspace root is ${ctx.workspace} and this call's directory is ${action.cwd}: put a workspace path after the root and use the absolute path.` };
    }
    targets.push({ shown: classified.zone === "inside" ? classified.rel : classified.abs, abs: classified.abs });
  }
  const target = targets[0]?.shown;
  const allow: Extract<AgentDecision, { kind: "allow" }> = { kind: "allow", effect: writes, appName, ...(target !== undefined ? { target } : {}) };
  if (!writes) return allow;
  // One card for the whole change, naming every file in it.
  const files = targets.map((one) => one.abs).join(", ");
  return gateChange(ctx.permission, allow, { kind_key: FILE_WRITE_KIND, target: targets[0]?.abs ?? action.cwd, summary: `${FILE_WRITE_KIND} ${files || action.cwd}` });
}

/**
 * A command as the shell reads it: agents hand commands over wrapped in their shell —
 * `/bin/zsh -lc 'cat notes.txt'` (Codex), `/opt/homebrew/bin/bash -lc 'ls -la'` (Grok), or as a
 * program and arguments (`["sh", "-c", "…"]`). The wrapper only says which shell; what it runs is
 * what the rules have to read.
 */
export function unwrapShell(command: string, args: string[] = []): string {
  const shell = /(?:^|[\\/])(?:ba|z|da|k|fi)?sh(?:\.exe)?$/i;
  if (args.length > 0) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    if (shell.test(command) && flag >= 0 && args[flag + 1] !== undefined) return args[flag + 1]!;
    return [command, ...args].map(shellQuote).join(" ");
  }
  const match = /^\s*(\S+)\s+-[a-z]*c[a-z]*\s+([\s\S]+)$/i.exec(command);
  if (!match || !shell.test(match[1]!)) return command;
  return unquote(match[2]!.trim());
}

/** One shell word, unquoted the way sh reads it: `'…'` literally, `"…"` with `\"` `\\` `\$` taken off. */
function unquote(word: string): string {
  let out = "";
  let i = 0;
  let quoted = false;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      if (end < 0) return word;
      out += word.slice(i + 1, end);
      i = end + 1;
      quoted = true;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        if (word[j] === "\\" && j + 1 < word.length && '"\\$`'.includes(word[j + 1]!)) {
          out += word[j + 1];
          j += 2;
        } else {
          out += word[j];
          j += 1;
        }
      }
      if (j >= word.length) return word;
      i = j + 1;
      quoted = true;
    } else if (ch === "\\" && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (/\s/.test(ch)) {
      // More than one word after `-c`: the rest are $0, $1, … to the script; the script is the first.
      return quoted || out ? out : word;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** An absolute path for a path an agent named relative to its directory. */
export function absoluteFrom(cwd: string, path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? anchorAt(cwd, path, platform) : posix.resolve(cwd, path);
}
