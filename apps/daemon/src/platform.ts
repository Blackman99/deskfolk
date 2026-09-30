/**
 * Small, injectable seams for the handful of places the daemon's behaviour genuinely forks by
 * operating system: which shell runs a model-issued command, how to take down a process (and its
 * children) for good, how to tell a compiled binary from a source checkout, and which extra
 * environment variables a spawned Windows child needs. Everything here takes `env`/`platform`/
 * `exists` as parameters with real-world defaults, so the win32 branches are unit-testable on a
 * Mac — there is no Windows machine in this loop. POSIX behaviour is untouched: every existing
 * call site keeps doing exactly what it did before this file existed.
 */
import { existsSync } from "node:fs";

/** A compiled Bun binary embeds its module tree here; on Windows the drive letter varies. */
export function isCompiledBinary(path: string): boolean {
  return path.startsWith("/$bunfs/") || path.startsWith("B:\\~BUN\\") || path.startsWith("B:/~BUN/");
}

/**
 * Windows env var names are case-insensitive (`Path` and `PATH` are the same variable); a fake
 * test env or a real `process.env` on Windows may spell one either way. Every other platform keeps
 * exact-name lookups, unchanged from what `env[name]` already did at every call site.
 */
export function envLookup(
  env: Record<string, string | undefined>,
  name: string,
  platform: string = process.platform,
): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (platform !== "win32") return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/** Copies the named variables out of `env` (case-insensitively on win32), dropping absent ones. */
export function pickEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
  platform: string = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = envLookup(env, name, platform);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Beyond the narrow POSIX whitelist (`HOME`, `PATH`, …), a spawned Windows child — `node`, `npm`,
 * PowerShell itself — needs the system's own identity to resolve `.cmd` shims, find its profile,
 * and behave like a normal process at all. Shared by `mcp-host.ts` and `terminal-env.ts`.
 */
export const WINDOWS_ENV_PASSTHROUGH = [
  "SystemRoot",
  "SYSTEMDRIVE",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/**
 * A hard, unconditional stop for a process. POSIX call sites signal on their own (the pty and the
 * MCP host their one child, a Bot's `shell` its whole process group — see `live-procs.ts`) and
 * only reach for this on win32, where there is no signal delivery at all: a `cmd → npx → node`
 * chain would otherwise outlive the parent that `taskkill /T` walks down to find.
 */
export function killProcessTree(
  pid: number,
  platform: string = process.platform,
  spawn: typeof Bun.spawn = Bun.spawn,
): void {
  if (platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
    return;
  }
  try {
    spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort: nothing else to do if taskkill itself cannot be spawned
  }
}

export type ToolShellKind = "sh" | "bash" | "powershell";

export type ToolShell = {
  kind: ToolShellKind;
  argv(command: string): string[];
  /** Human-readable, for anything that names the shell back to a person (prompts, logs). */
  label: string;
};

const GIT_BASH_PROGRAM_FILES_VARS = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] as const;

function winDirname(path: string): string {
  const index = path.lastIndexOf("\\");
  return index === -1 ? path : path.slice(0, index);
}

function findOnWindowsPath(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  exeName: string,
  platform: string,
): string | null {
  const path = envLookup(env, "PATH", platform);
  if (!path) return null;
  for (const dir of path.split(";")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\\+$/, "")}\\${exeName}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * `%ProgramFiles%\Git\bin\bash.exe` and its siblings, then `git.exe` on PATH walked back up to its
 * install root — never a bare `bash.exe` found on PATH, which is how `C:\Windows\System32\bash.exe`
 * (WSL's) would otherwise get picked.
 */
function findGitBash(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  platform: string,
): string | null {
  for (const variable of GIT_BASH_PROGRAM_FILES_VARS) {
    const base = envLookup(env, variable, platform);
    if (!base) continue;
    const candidate = `${base.replace(/\\+$/, "")}\\Git\\bin\\bash.exe`;
    if (exists(candidate)) return candidate;
  }
  const localAppData = envLookup(env, "LOCALAPPDATA", platform);
  if (localAppData) {
    const candidate = `${localAppData.replace(/\\+$/, "")}\\Programs\\Git\\bin\\bash.exe`;
    if (exists(candidate)) return candidate;
  }
  const git = findOnWindowsPath(env, exists, "git.exe", platform);
  if (git) {
    // git.exe sits at <root>\cmd\git.exe, <root>\bin\git.exe, or <root>\mingw64\bin\git.exe; the
    // `bin` holding bash.exe is always directly under <root>, two segments up from git.exe itself.
    const root = winDirname(winDirname(git));
    const candidate = `${root}\\bin\\bash.exe`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` — always present on Windows. */
export function windowsPowerShellFallback(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): string {
  const systemRoot = envLookup(env, "SystemRoot", platform) ?? "C:\\Windows";
  return `${systemRoot.replace(/\\+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * `pwsh.exe` (PowerShell 7+) if it is on PATH, else the Windows PowerShell that ships with every
 * Windows install. Shared by the interactive terminal's default shell and the win32 Recycle Bin
 * mover, which both want "the best PowerShell available", not the Git-Bash-first logic `toolShell`
 * uses for a model-issued command.
 */
export function resolvePowerShell(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  which: (name: string) => string | null = (name) => Bun.which(name, { PATH: env.PATH }) ?? null,
): string {
  const pwsh = which("pwsh.exe") ?? which("pwsh");
  return pwsh ?? windowsPowerShellFallback(env, platform);
}

function shellKindFromExe(path: string): ToolShellKind {
  return path.toLowerCase().includes("bash") ? "bash" : "powershell";
}

function bashArgv(bash: string): (command: string) => string[] {
  return (command) => [bash, "-c", command];
}

function powershellArgv(exe: string): (command: string) => string[] {
  return (command) => [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
}

/**
 * What runs a model-issued `shell` command. Unchanged on POSIX (`/bin/sh -c <command>`, `"sh"`).
 * On win32: `REAL_BOT_TOOL_SHELL` wins outright; else Git Bash if one of the usual install spots
 * has it; else PowerShell (`pwsh.exe` on PATH, else the Windows PowerShell that always ships).
 */
export function toolShell(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): ToolShell {
  if (platform !== "win32") {
    return { kind: "sh", argv: (command) => ["/bin/sh", "-c", command], label: "/bin/sh" };
  }
  const override = envLookup(env, "REAL_BOT_TOOL_SHELL", platform);
  if (override) {
    const kind = shellKindFromExe(override);
    return {
      kind,
      argv: kind === "bash" ? bashArgv(override) : powershellArgv(override),
      label: override,
    };
  }
  const bash = findGitBash(env, exists, platform);
  if (bash) {
    return { kind: "bash", argv: bashArgv(bash), label: "Git Bash" };
  }
  const pwsh = findOnWindowsPath(env, exists, "pwsh.exe", platform);
  if (pwsh) {
    return { kind: "powershell", argv: powershellArgv(pwsh), label: "PowerShell" };
  }
  const fallback = windowsPowerShellFallback(env, platform);
  return { kind: "powershell", argv: powershellArgv(fallback), label: "Windows PowerShell" };
}
