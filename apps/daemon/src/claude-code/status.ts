/**
 * What the user's Claude Code says about itself (ADR 0061): `claude --version` and
 * `claude auth status` (JSON; exit 1 when signed out). That is all Deskfolk asks — it never opens
 * Claude Code's credentials, keychain item or config. The answer is cached and refreshed on demand:
 * a Claude Agent turn reads it before it starts, the Settings card when it opens or you re-check.
 */
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { locateClaudeCode, type LocateDeps } from "./locate";
import { killProcessTree } from "../platform";
import { claudeProxy, maskProxy, withSystemProxy, type SystemProxy } from "./proxy";
import { claudeLaunch } from "./spawn";

/** The Claude Code version `@anthropic-ai/claude-agent-sdk` was built with (its `claudeCodeVersion`). */
export const AGENT_SDK_CLAUDE_CODE_VERSION = "2.1.289";

export type RunResult = { code: number | null; stdout: string };
export type Run = (argv: string[], env: Record<string, string | undefined>) => Promise<RunResult>;

export type DescribeDeps = LocateDeps & { run?: Run; now?: () => Date; systemProxy?: SystemProxy };

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
  // Asked with the environment a turn runs it with.
  const env = withSystemProxy(claudeChildEnv(deps.env), empty, (deps.platform ?? process.platform) as NodeJS.Platform);
  const status: ClaudeCodeStatus = { ...empty, path: located.found.path, source: located.found.source, error: null };
  const version = await run([located.found.path, "--version"], env);
  status.version = parseVersion(version.stdout);
  if (!status.version) status.error = "claude --version gave no version";
  status.outdated = status.version !== null && compareVersions(status.version, AGENT_SDK_CLAUDE_CODE_VERSION) < 0;
  const auth = await run([located.found.path, "auth", "status"], env);
  const parsed = parseAuthStatus(auth.stdout);
  if (parsed) {
    status.logged_in = parsed.loggedIn;
    status.auth_method = parsed.authMethod;
    status.subscription_type = parsed.subscriptionType;
    status.email = parsed.email;
  } else if (!status.error) {
    status.error = "claude auth status gave no answer";
  }
  return status;
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
export function parseAuthStatus(out: string): { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null; email: string | null } | null {
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
 * session) and Deskfolk's own `REAL_BOT_*` switches, which mean nothing to Claude Code.
 */
export function claudeChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NESTED_SESSION_MARKERS.has(key) || key.startsWith("REAL_BOT_")) continue;
    out[key] = value;
  }
  return out;
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
