/**
 * Starting and stopping the user's `claude` (ADR 0061). On POSIX it runs in a process group of its
 * own, so a stop takes whatever it started as well. Windows has no groups: a stop walks the tree with
 * `taskkill /T`, which finds the children only while `claude` itself is still there to walk from —
 * so every stop, whoever asks for it, goes through here instead of killing `claude` alone. And npm's
 * `claude.cmd` is a batch file, which only cmd.exe runs, its arguments escaped as for an MCP
 * server's `npx`.
 */
import { windowsSpawnPlan } from "../mcp-host";
import { killProcessTree } from "../platform";

export type ClaudeLaunch = { command: string; args: string[]; verbatim: boolean };

/** What to start for `command args`: itself, or on Windows a batch file through cmd.exe. */
export function claudeLaunch(
  command: string,
  args: string[],
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): ClaudeLaunch {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args, verbatim: false };
  // Already a full path: only the route through cmd.exe is wanted, not another PATH lookup.
  return windowsSpawnPlan(command, args, env, (name) => name);
}

type Killable = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
};

/**
 * Makes `child.kill` stop the whole tree, whoever calls it: a Stop here, or the SDK closing its
 * session (on Windows it waits five seconds, then kills). Once the child has exited, a kill is its
 * own again. Windows has no signals, so there every stop is `taskkill /T /F` — as hard as killing
 * `claude` alone already was, and nothing it started is left behind.
 */
export function killsTree<T extends Killable>(child: T, stop: (pid: number, signal: NodeJS.Signals) => void = stopClaudeTree): T {
  const killOne = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return killOne(signal);
    stop(child.pid, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as T["kill"];
  return child;
}

/** Stops `claude` and everything under it: its process group on POSIX, its tree on Windows. */
export function stopClaudeTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
  killTree: typeof killProcessTree = killProcessTree,
): void {
  if (platform === "win32") {
    killTree(pid, "win32");
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}
