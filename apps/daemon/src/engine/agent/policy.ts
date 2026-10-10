/**
 * The app's rules for a local agent's own calls (ADR 0079), whichever agent makes them: each
 * agent's tools are first told as one of a few app actions — read a file, list or search, write
 * one, run a command, fetch from the web, something else — and then decided exactly as a Claude
 * Agent turn's are (ADR 0061, `claude-code/policy.ts`): inside the workspace runs, crossing out
 * waits for your OK unless an always-allow rule covers it, the same recursive-search refusal,
 * nothing in the background, and never any agent's own credentials. Pure, like Claude's.
 */
import { existsSync } from "node:fs";
import { posix } from "node:path";
import { recursiveSearchGuard, searchGuardMessage } from "../../search-guard";
import { classifyPath, classifyShell, nodePathHost, type PathHost } from "../../workspace-paths";
import { anchorAt, expandHome, gitBashToWindows, type AgentDecision } from "../../claude-code/policy";
import { isAgentCredentialPath, isAgentOwnReadable, touchesAgentCredentials } from "./credentials";

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
  /** Whether an always-allow rule you made covers this kind of call there. */
  allowed: (kind: string, target: string) => boolean;
  exists?: (path: string) => boolean;
  host?: PathHost;
};

/** What to do with one call. `effect` calls also pass the app's effect gate before they run. */
export function decideAction(action: AppAction, ctx: ActionContext): AgentDecision {
  const host = ctx.host ?? nodePathHost;
  const platform = host.platform;
  const home = ctx.home ?? host.homedir();
  const configDirs = ctx.configDirs ?? [];
  const appName = action.appName;
  if (ctx.mode === "readonly" && !["read_file", "list_dir", "web"].includes(appName)) {
    return { kind: "deny", reason: "this is a read-only turn (a stop holds this work): look and answer, nothing else" };
  }
  if (action.background) return { kind: "deny", reason: "background tasks are not available here: run it in the foreground and wait for it" };
  if (appName === "shell") {
    const command = action.command ?? "";
    if (touchesAgentCredentials(command, home, platform, configDirs)) {
      return { kind: "deny", reason: "your local agents' own settings and credentials are off limits" };
    }
    const hit = recursiveSearchGuard(ctx.workspace, command, action.cwd, host);
    if (hit) return { kind: "deny", reason: searchGuardMessage(hit) };
    const classified = classifyShell(ctx.workspace, command, action.cwd, host, platform === "win32" ? "bash" : undefined);
    if (classified.kind === "jailed") return { kind: "allow", effect: true, appName, target: command };
    if (ctx.allowed("unconstrained-shell", classified.cwdAbs)) return { kind: "allow", effect: true, appName, target: command };
    return { kind: "ask", effect: true, appName, approval: { kind_key: "unconstrained-shell", target: classified.cwdAbs, summary: `unconstrained-shell ${command}` } };
  }
  if (appName === "web" || appName === "other") return { kind: "allow", effect: false, appName };

  const writes = appName === "write_file";
  const named = action.paths.length > 0 ? action.paths : [action.cwd];
  let decision: AgentDecision | null = null;
  for (const raw of named) {
    const abs = anchorAt(action.cwd, expandHome(raw, home, platform), platform);
    const spellings = [abs, ...(platform === "win32" ? [gitBashToWindows(raw)].filter((path): path is string => path !== null) : [])];
    if (spellings.some((path) => isAgentCredentialPath(path, home, platform, configDirs))) {
      return { kind: "deny", reason: "your local agents' own settings and credentials are off limits" };
    }
    if (platform === "win32" && /^[\\/](?![\\/])/.test(raw)) {
      return { kind: "deny", reason: `${raw} is not a Windows path: name files with their drive (C:\\…). The workspace root is ${ctx.workspace} and this call's directory is ${action.cwd}.` };
    }
    const classified = classifyPath(ctx.workspace, abs, host);
    const top = platform !== "win32" && abs.startsWith("/") ? abs.split("/").find(Boolean) : undefined;
    if (classified.zone !== "inside" && top && !(ctx.exists ?? existsSync)(`/${top}`)) {
      return { kind: "deny", reason: `${abs} does not exist and is not in the workspace. The workspace root is ${ctx.workspace} and this call's directory is ${action.cwd}: put a workspace path after the root and use the absolute path.` };
    }
    let one: AgentDecision;
    if (classified.zone === "inside") one = { kind: "allow", effect: writes, appName, target: classified.rel };
    else if (!writes && isAgentOwnReadable(classified.abs, home, platform)) one = { kind: "allow", effect: false, appName, target: classified.abs };
    else if (ctx.allowed(writes ? "outside-write" : "outside-read", classified.abs)) one = { kind: "allow", effect: writes, appName, target: classified.abs };
    else one = { kind: "ask", effect: writes, appName, approval: { kind_key: writes ? "outside-write" : "outside-read", target: classified.abs, summary: `${writes ? "outside-write" : "outside-read"} ${classified.abs}` } };
    // The first path that needs your OK decides; one inside never outweighs one outside.
    if (one.kind === "ask") return one;
    decision ??= one;
  }
  return decision ?? { kind: "allow", effect: writes, appName };
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
