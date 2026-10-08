/**
 * What the user's Claude Code says about itself (ADR 0061): `claude --version` and
 * `claude auth status` (JSON; exit 1 when signed out), the latter once per account — the daemon's
 * own environment and every config directory listed in Settings. That is all Deskfolk asks — it
 * never opens Claude Code's credentials, keychain item or config. The answer is cached and
 * refreshed on demand: a Claude Agent turn reads it before it starts, the Settings card when it
 * opens or you re-check.
 */
import { existsSync } from "node:fs";
import type { ClaudeCodeAccount, ClaudeCodeStatus } from "@real-bot/protocol";
import { loginCommand, withConfigDir, type AccountHost } from "./account";
import { locateClaudeCode, type LocateDeps } from "./locate";
import { killProcessTree } from "../platform";
import { claudeProxy, maskProxy, withSystemProxy, type SystemProxy } from "./proxy";
import { claudeLaunch } from "./spawn";

/** The Claude Code version `@anthropic-ai/claude-agent-sdk` was built with (its `claudeCodeVersion`). */
export const AGENT_SDK_CLAUDE_CODE_VERSION = "2.1.289";

export type RunResult = { code: number | null; stdout: string };
export type Run = (argv: string[], env: Record<string, string | undefined>) => Promise<RunResult>;

export type DescribeDeps = LocateDeps & {
  run?: Run;
  now?: () => Date;
  systemProxy?: SystemProxy;
  /** The config directories listed in Settings, each asked on its own after the daemon's own environment. */
  configDirs?: string[];
  /** Whose default config directory is whose; this machine's when absent. */
  accountHost?: AccountHost;
  /** Whether a listed directory is there; the disk's own when absent. */
  dirExists?: (dir: string) => boolean;
};

export async function describeClaudeCode(deps: DescribeDeps): Promise<ClaudeCodeStatus> {
  const run = deps.run ?? runWithTimeout;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const baseUrlSet = Boolean(deps.env.ANTHROPIC_BASE_URL?.trim());
  const located = await locateClaudeCode(deps);
  const proxy = await claudeProxy(deps.env, deps.systemProxy, (deps.platform ?? process.platform) as NodeJS.Platform);
  const empty: ClaudeCodeStatus = {
    path: null, source: null, version: null, sdk_version: AGENT_SDK_CLAUDE_CODE_VERSION, outdated: false,
    logged_in: null, auth_method: null, subscription_type: null, email: null,
    base_url_set: baseUrlSet,
    // A system proxy is built from a host and a port, with nothing to hide; the turn uses it as shown.
    proxy: proxy ? (proxy.source === "env" ? maskProxy(proxy.url) : proxy.url) : null,
    proxy_source: proxy?.source ?? null,
    checked_at: checkedAt, error: located.error,
  };
  if (!located.found) return empty;
  const executable = located.found.path;
  const platform = (deps.platform ?? process.platform) as NodeJS.Platform;
  // Asked with the environment a turn runs it with.
  const envFor = (dir: string | null) => withSystemProxy(claudeChildEnv(deps.env, dir, deps.accountHost), empty, platform);
  const status: ClaudeCodeStatus = { ...empty, path: executable, source: located.found.source, error: null };
  const version = await run([executable, "--version"], envFor(null));
  status.version = parseVersion(version.stdout);
  if (!status.version) status.error = "claude --version gave no version";
  status.outdated = status.version !== null && compareVersions(status.version, AGENT_SDK_CLAUDE_CODE_VERSION) < 0;
  const ask = async (dir: string | null): Promise<ClaudeCodeAccount> => {
    const login_command = loginCommand(dir, deps.accountHost);
    // Nothing is signed in where there is no directory, and `claude` would make one (a mistyped
    // path left behind); signing in makes it.
    if (dir !== null && !(deps.dirExists ?? existsSync)(dir)) {
      return { config_dir: dir, config_directory: dir, logged_in: false, auth_method: "none", subscription_type: null, email: null,
        error: "the directory does not exist yet", login_command };
    }
    const auth = await run([executable, "auth", "status"], envFor(dir));
    const parsed = parseAuthStatus(auth.stdout);
    if (!parsed) {
      return { config_dir: dir, config_directory: null, logged_in: null, auth_method: null, subscription_type: null, email: null, error: "claude auth status gave no answer", login_command };
    }
    return { config_dir: dir, config_directory: parsed.configDirectory, logged_in: parsed.loggedIn, auth_method: parsed.authMethod,
      subscription_type: parsed.subscriptionType, email: parsed.email, error: null, login_command };
  };
  const accounts = await Promise.all([null, ...(deps.configDirs ?? [])].map(ask));
  const own = accounts[0]!;
  status.accounts = accounts;
  status.logged_in = own.logged_in;
  status.auth_method = own.auth_method;
  status.subscription_type = own.subscription_type;
  status.email = own.email;
  if (own.error && !status.error) status.error = own.error;
  return status;
}

/** The account a Bot's `agent_config_dir` names in `status`; undefined when the status has none for it. */
export function accountOf(status: ClaudeCodeStatus, dir: string | null): ClaudeCodeAccount | undefined {
  return status.accounts?.find((account) => account.config_dir === dir);
}

/** `2.1.289 (Claude Code)` → `2.1.289`. */
export function parseVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The fields Deskfolk shows from `claude auth status`'s JSON; null when it printed none. */
export function parseAuthStatus(out: string): { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; email: string | null; configDirectory: string | null } | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const json = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return {
      loggedIn: json.loggedIn === true,
      authMethod: text(json.authMethod),
      subscriptionType: text(json.subscriptionType),
      email: text(json.email),
      configDirectory: text(json.configDirectory),
    };
  } catch {
    return null;
  }
}

/**
 * The environment Claude Code runs with: the daemon's own, credentials and endpoints included
 * (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` pass through untouched — Deskfolk never takes away a way
 * Claude Code signs in, it only shows which one is in use). Removed: the markers a Claude Code
 * session leaves on processes it starts (a daemon started from one would otherwise read as a nested
 * session) and Deskfolk's own `REAL_BOT_*` switches, which mean nothing to Claude Code. `configDir`
 * picks the account (`withConfigDir`): absent or null, `CLAUDE_CONFIG_DIR` stays as the daemon has it.
 */
export function claudeChildEnv(env: Record<string, string | undefined>, configDir?: string | null, host?: AccountHost): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NESTED_SESSION_MARKERS.has(key) || key.startsWith("REAL_BOT_")) continue;
    out[key] = value;
  }
  return withConfigDir(out, configDir, host);
}

/**
 * What a running Claude Code session puts on the processes it starts. A daemon started from one (a
 * developer's `pnpm dev` in its terminal) would hand them on, and a Bot's Claude Code would take
 * itself for part of that session. None of them is a way to sign in.
 */
const NESTED_SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
]);

async function runWithTimeout(argv: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  try {
    const launch = claudeLaunch(argv[0]!, argv.slice(1), env as Record<string, string>);
    const proc = Bun.spawn([launch.command, ...launch.args], {
      env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      // Asked every minute or so: no console window each time, and npm's claude.cmd via cmd.exe.
      windowsHide: true, windowsVerbatimArguments: launch.verbatim,
    });
    // On Windows a batch file's cmd.exe has claude under it; the tree goes, not cmd.exe alone.
    const timer = setTimeout(() => (process.platform === "win32" ? killProcessTree(proc.pid, "win32") : proc.kill()), 10_000);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: null, stdout: "" };
  }
}
