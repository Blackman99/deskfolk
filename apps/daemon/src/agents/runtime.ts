/**
 * What a turn on a local agent other than Claude Code runs (ADR 0079): the command found for the
 * runner (or your own, for a custom ACP agent) and the environment it gets — the daemon's own, less
 * the markers a Claude Code session leaves and the app's `REAL_BOT_*`, with the account's
 * directory, the command's own directory first on PATH (an npm install like Codex's is a
 * Node script that needs the `node` beside it, which a daemon started from Finder does not have on
 * its PATH), and the system proxy when the environment names none (ADR 0061 decision 10).
 */
import { realpathSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { AGENT_KINDS, type BotRunner, type CustomAgent } from "@real-bot/protocol";
import { proxyForHost, type ClaudeProxy } from "../claude-code/proxy";
import { claudeChildEnv } from "../claude-code/status";
import { envLookup } from "../platform";
import { locateAgent, type AgentLocation } from "./locate";
import { AGENT_LAUNCH, agentCommand } from "./registry";

export type ResolvedAgent =
  | { ok: true; executable: string; source: AgentLocation["source"] | "custom"; args: string[]; env: Record<string, string>; proxy: ClaudeProxy | null }
  | { ok: false; error: string };

const LOCATE_MAX_AGE_MS = 60_000;
const located = new Map<string, { at: number; result: Awaited<ReturnType<typeof locateAgent>> }>();

/** Forget what was found, after you set a path or ask to look again. */
export function forgetLocatedAgent(runner?: BotRunner): void {
  if (!runner) located.clear();
  else located.delete(runner);
}

export async function locateRunner(runner: Exclude<BotRunner, "claude_code" | "custom">, setting: string | null, env: Record<string, string | undefined> = process.env, maxAgeMs = LOCATE_MAX_AGE_MS) {
  const key = `${runner}\u0000${setting ?? ""}`;
  const cached = located.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.result;
  const result = await locateAgent({ command: agentCommand(runner)!, setting, env });
  located.set(key, { at: Date.now(), result });
  return result;
}

export async function resolveAgent(options: {
  runner: Exclude<BotRunner, "claude_code">;
  custom: CustomAgent | null;
  setting: string | null;
  configDir: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<ResolvedAgent> {
  const base = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let executable: string;
  let source: AgentLocation["source"] | "custom";
  let args: string[];
  if (options.runner === "custom") {
    if (!options.custom) return { ok: false, error: "this custom agent is no longer listed in Settings" };
    executable = options.custom.command;
    source = "custom";
    args = [...options.custom.args];
    const check = await locateAgent({ command: "custom", setting: executable, env: base });
    if (!check.found) return { ok: false, error: check.error ?? `${executable} is not an executable file` };
  } else {
    const found = await locateRunner(options.runner, options.setting, base);
    if (!found.found) return { ok: false, error: found.error ?? `${agentCommand(options.runner)} was not found` };
    executable = found.found.path;
    source = found.found.source;
    args = [...AGENT_LAUNCH[options.runner].args];
  }
  const env = claudeChildEnv(base, null);
  const variable = AGENT_KINDS[options.runner].configDirVar;
  if (variable && options.configDir) env[variable] = options.configDir;
  const dirs = [dirname(executable)];
  try {
    const real = dirname(realpathSync(executable));
    if (!dirs.includes(real)) dirs.push(real);
  } catch {
    // a path that does not resolve runs as it is
  }
  const pathKey = Object.keys(env).find((key) => (platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH")) ?? "PATH";
  const path = envLookup(env, "PATH", platform) ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  env[pathKey] = [...dirs.filter((dir) => !path.split(sep).includes(dir)), path].filter(Boolean).join(sep);
  const proxy = await proxyForHost(AGENT_LAUNCH[options.runner].apiHost, env).catch(() => null);
  if (proxy?.source === "system") {
    env.HTTPS_PROXY = proxy.url;
    if (!envLookup(env, "NO_PROXY", platform) && !envLookup(env, "no_proxy", platform)) env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return { ok: true, executable, source, args, env, proxy };
}
