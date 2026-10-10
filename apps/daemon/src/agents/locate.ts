/**
 * Finding a local agent's command (ADR 0079), the way ADR 0061 finds `claude`: the path you set in
 * Settings, then the daemon's PATH, then the places the agent's installers put it, then your login
 * shell, asked once with a short timeout. A daemon the window started from Finder has launchd's
 * PATH, where none of them live; npm installs (Codex, DSH) usually sit under nvm's current Node, so
 * those directories are looked at too, newest first. On Windows the app has your whole PATH, npm's
 * shims are `.cmd` files, and there is no login shell to ask. Everything that touches the machine
 * is injected, so the order is tested without one.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { envLookup } from "../platform";
import { expandHome } from "../claude-code/locate";

export type AgentSource = "setting" | "path" | "known" | "login_shell";
export type AgentLocation = { path: string; source: AgentSource };

export type AgentLocateDeps = {
  /** The command's name (`codex`, `grok`, …). */
  command: string;
  /** The path you set, as stored; null when unset. */
  setting: string | null;
  env: Record<string, string | undefined>;
  home?: string;
  platform?: string;
  isExecutable?: (path: string) => boolean;
  which?: (name: string, pathVar: string | undefined) => string | null;
  /** The directories under `~/.nvm/versions/node`, newest first. */
  nvmBins?: (home: string) => string[];
  loginShell?: (shell: string, command: string) => Promise<string | null>;
};

export type AgentLocateResult = { found: AgentLocation | null; error: string | null };

export async function locateAgent(deps: AgentLocateDeps): Promise<AgentLocateResult> {
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const which = deps.which ?? ((name, pathVar) => Bun.which(name, pathVar === undefined ? undefined : { PATH: pathVar }) ?? null);
  if (deps.setting) {
    const path = expandHome(deps.setting, home, platform);
    if (isExecutable(path)) return { found: { path, source: "setting" }, error: null };
    return { found: null, error: `the path set in Settings is not an executable file: ${path}` };
  }
  const onPath = which(deps.command, envLookup(deps.env, "PATH", platform));
  if (onPath && isExecutable(onPath)) return { found: { path: onPath, source: "path" }, error: null };
  for (const path of agentKnownPlaces(deps.command, home, platform, deps.env, deps.nvmBins ?? defaultNvmBins)) {
    if (isExecutable(path)) return { found: { path, source: "known" }, error: null };
  }
  if (platform === "win32") return { found: null, error: `${deps.command} was not found on PATH or in the usual install places` };
  const shell = deps.env.SHELL && deps.env.SHELL.startsWith("/") ? deps.env.SHELL : "/bin/zsh";
  const fromShell = await (deps.loginShell ?? askLoginShell)(shell, deps.command);
  if (fromShell && isExecutable(fromShell)) return { found: { path: fromShell, source: "login_shell" }, error: null };
  return { found: null, error: `${deps.command} was not found on PATH, in the usual install places, or in your login shell` };
}

/** Where installers put a command, most likely first: its own `~/.<name>/bin`, the usual bins, npm's. */
export function agentKnownPlaces(command: string, home: string, platform: string, env: Record<string, string | undefined>, nvmBins: (home: string) => string[] = defaultNvmBins): string[] {
  if (platform === "win32") {
    const appData = envLookup(env, "APPDATA", platform) ?? win32.join(home, "AppData", "Roaming");
    return [
      win32.join(home, ".local", "bin", `${command}.exe`),
      win32.join(home, `.${command}`, "bin", `${command}.exe`),
      win32.join(appData, "npm", `${command}.cmd`),
    ];
  }
  const join = posix.join;
  return [
    join(home, ".local", "bin", command),
    join(home, `.${command}`, "bin", command),
    "/opt/homebrew/bin/" + command,
    "/usr/local/bin/" + command,
    join(home, ".npm-global", "bin", command),
    join(home, ".bun", "bin", command),
    join(home, ".volta", "bin", command),
    ...nvmBins(home).map((bin) => join(bin, command)),
  ];
}

/** nvm's Node installs, newest version first: where `npm i -g` put Codex or DSH for most people. */
function defaultNvmBins(home: string): string[] {
  const root = posix.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))
      .map((name) => posix.join(root, name, "bin"));
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
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

/** `$SHELL -lic 'command -v <name>'`, three seconds at most; the last absolute path it prints. */
async function askLoginShell(shell: string, command: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) return null;
  try {
    const proc = Bun.spawn([shell, "-lic", `command -v ${command}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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
