/**
 * Finding the user's own `claude` (ADR 0061). A daemon the window started from Finder has launchd's
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), where no Claude Code install lives, so the PATH alone is
 * not enough: after it come the places Claude Code's installers put it, then the user's own login
 * shell, asked once with a short timeout. A path you set in Settings wins over all of them. On
 * Windows the app gets your whole PATH, `claude` may be the native `claude.exe` or npm's
 * `claude.cmd` (PATHEXT finds either), and there is no login shell to ask.
 * Everything that touches the machine is injected, so the order is tested without one.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { envLookup } from "../platform";

export type ClaudeLocation = { path: string; source: NonNullable<ClaudeCodeStatus["source"]> };

export type LocateDeps = {
  /** The path you set, as stored; null when unset. */
  setting: string | null;
  env: Record<string, string | undefined>;
  home?: string;
  platform?: string;
  /** An executable file at this path. */
  isExecutable?: (path: string) => boolean;
  which?: (name: string, pathVar: string | undefined) => string | null;
  /** `command -v claude` in the user's login shell; null when it finds nothing or takes too long. */
  loginShell?: (shell: string) => Promise<string | null>;
};

export type LocateResult = { found: ClaudeLocation | null; error: string | null };

export async function locateClaudeCode(deps: LocateDeps): Promise<LocateResult> {
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const which = deps.which ?? ((name, pathVar) => Bun.which(name, pathVar === undefined ? undefined : { PATH: pathVar }) ?? null);
  if (deps.setting) {
    const path = expandHome(deps.setting, home, platform);
    if (isExecutable(path)) return { found: { path, source: "setting" }, error: null };
    return { found: null, error: `the path set in Settings is not an executable file: ${path}` };
  }
  const onPath = which("claude", envLookup(deps.env, "PATH", platform));
  if (onPath && isExecutable(onPath)) return { found: { path: onPath, source: "path" }, error: null };
  for (const path of knownPlaces(home, platform, deps.env)) {
    if (isExecutable(path)) return { found: { path, source: "known" }, error: null };
  }
  if (platform === "win32") return { found: null, error: "claude was not found on PATH or in the usual install places" };
  const shell = deps.env.SHELL && deps.env.SHELL.startsWith("/") ? deps.env.SHELL : "/bin/zsh";
  const fromShell = await (deps.loginShell ?? askLoginShell)(shell);
  if (fromShell && isExecutable(fromShell)) return { found: { path: fromShell, source: "login_shell" }, error: null };
  return { found: null, error: "claude was not found on PATH, in the usual install places, or in your login shell" };
}

/** Where Claude Code's installers put `claude`, most likely first. */
export function knownPlaces(home: string, platform: string, env: Record<string, string | undefined>): string[] {
  if (platform === "win32") {
    const appData = envLookup(env, "APPDATA", platform) ?? win32.join(home, "AppData", "Roaming");
    // The native installer's, then npm's global shim.
    return [win32.join(home, ".local", "bin", "claude.exe"), win32.join(appData, "npm", "claude.cmd")];
  }
  const join = posix.join;
  return [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".npm-global", "bin", "claude"),
    join(home, ".bun", "bin", "claude"),
    join(home, ".volta", "bin", "claude"),
  ];
}

export function expandHome(path: string, home: string, platform: string = process.platform): string {
  if (path === "~") return home;
  if (platform === "win32") return /^~[\\/]/.test(path) ? win32.join(home, path.slice(2)) : path;
  if (path.startsWith("~/")) return posix.join(home, path.slice(2));
  return path;
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/**
 * `$SHELL -lic 'command -v claude'`: a login and interactive shell reads both `.zprofile` and
 * `.zshrc`, where installers add `~/.local/bin` to PATH. Whatever else the rc files print is
 * ignored: the answer is the last line that is an absolute path. Three seconds at most.
 */
async function askLoginShell(shell: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([shell, "-lic", "command -v claude"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 3_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("/"));
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}
