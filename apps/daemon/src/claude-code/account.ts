/**
 * Which of your Claude accounts a `claude` runs with (ADR 0061, accounts addendum). Claude Code
 * keeps each sign-in under a config directory: `~/.claude` while `CLAUDE_CONFIG_DIR` is unset, the
 * variable's directory otherwise. On macOS it also names its keychain item after the variable, so
 * setting it to `~/.claude` itself finds no sign-in (checked with Claude Code 2.1.294): the default
 * directory is reached by unsetting the variable, never by naming it. Deskfolk keeps the
 * directories you list and sets or unsets the variable; it never opens what is in them.
 */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { isWithinPath } from "../workspace-paths";

/** How many accounts Settings lists at most, besides the daemon's own environment. */
export const CLAUDE_CONFIG_DIRS_MAX = 8;
/** Long enough for any real path, short enough that a pasted blob is refused. */
const PATH_MAX = 1024;

export type AccountHost = { home: string; platform: NodeJS.Platform };

function thisHost(): AccountHost {
  return { home: homedir(), platform: process.platform };
}

/**
 * A config directory as it is kept and compared: absolute, `~` expanded, `.`/`..` and any trailing
 * separator gone. Null for anything that is not an absolute path (or one under `~/`); on Windows
 * that means a drive (`C:\…`) or a share (`\\server\share\…`).
 */
export function normalizeConfigDir(raw: string, host: AccountHost = thisHost()): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PATH_MAX) return null;
  const win = host.platform === "win32";
  const path = win ? win32 : posix;
  let expanded = trimmed;
  if (trimmed === "~") expanded = host.home;
  else if (win ? /^~[\\/]/.test(trimmed) : trimmed.startsWith("~/")) expanded = path.join(host.home, trimmed.slice(2));
  if (win ? !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(expanded) : !expanded.startsWith("/")) return null;
  return path.resolve(expanded);
}

/** Whether two kept directories are the same one: regardless of case on Windows. */
export function sameConfigDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The directory Claude Code reads while `CLAUDE_CONFIG_DIR` is unset. */
export function defaultConfigDir(host: AccountHost = thisHost()): string {
  return (host.platform === "win32" ? win32 : posix).join(host.home, ".claude");
}

/**
 * A directory that cannot be an account's: the file system's root, your home folder, or anything
 * above it. The Bots' file tools keep out of every listed directory, so one of these would shut
 * them out of the workspace too.
 */
export function tooWideForConfigDir(dir: string, host: AccountHost = thisHost()): boolean {
  const path = host.platform === "win32" ? win32 : posix;
  return path.parse(dir).root === dir || isWithinPath(dir, host.home, host.platform);
}

/**
 * `env` set up for one account: no directory (undefined or null) leaves `CLAUDE_CONFIG_DIR` as the
 * daemon has it; the default directory unsets it; any other directory sets it.
 */
export function withConfigDir(env: Record<string, string>, dir: string | null | undefined, host: AccountHost = thisHost()): Record<string, string> {
  if (dir === undefined || dir === null) return env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Windows reads environment names regardless of case.
    if (key === "CLAUDE_CONFIG_DIR" || (host.platform === "win32" && key.toUpperCase() === "CLAUDE_CONFIG_DIR")) continue;
    out[key] = value;
  }
  if (!sameConfigDir(dir, defaultConfigDir(host), host.platform)) out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

/** `dir` as you would type it: under your home folder it starts with `~`. */
export function tildeDir(dir: string, host: AccountHost = thisHost()): string {
  const path = host.platform === "win32" ? win32 : posix;
  if (!isWithinPath(host.home, dir, host.platform) || sameConfigDir(dir, host.home, host.platform)) return dir;
  return `~${path.sep}${path.relative(host.home, dir)}`;
}

/**
 * What signs an account in, typed in a terminal: plain `claude auth login` for the daemon's own
 * environment (null), the variable set for a listed directory, and unset for `~/.claude` itself —
 * a terminal that picked another account would otherwise sign that one in.
 */
export function loginCommand(dir: string | null, host: AccountHost = thisHost()): string {
  if (dir === null) return "claude auth login";
  const own = sameConfigDir(dir, defaultConfigDir(host), host.platform);
  if (host.platform === "win32") {
    return own
      ? "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; claude auth login"
      : `$env:CLAUDE_CONFIG_DIR = '${dir.replace(/'/g, "''")}'; claude auth login`;
  }
  if (own) return "env -u CLAUDE_CONFIG_DIR claude auth login";
  const quoted = /^[A-Za-z0-9_./~+-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, "'\\''")}'`;
  return `CLAUDE_CONFIG_DIR=${quoted} claude auth login`;
}
