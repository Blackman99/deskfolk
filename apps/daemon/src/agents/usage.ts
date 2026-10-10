/**
 * Your local agents' usage (ADR 0079, `GET /v1/agent-usage`), for the agents some Bot, ladder rung
 * or built-in call runs on, or that are connected. Codex, Grok and Antigravity report their plan's
 * windows themselves, none of them through a model call or spending anything: Codex's app-server
 * (`account/rateLimits/read`), Grok's ACP extension `_x.ai/billing` (no session opened), and
 * `agy -p "/quota"`, a read-only slash command `agy` answers itself from 1.1.11 (before that it went
 * to the model as a prompt, so an older `agy` is not asked). The others report none, and show what
 * this app's own records hold of them today instead: never a percentage an agent did not give. Claude's
 * own stays `GET /v1/claude-usage` (ADR 0061); `GET /v1/usage` puts the two together (ADR 0080).
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AGENT_KINDS, type AgentStatus, type AgentUsage, type AgentUsageResponse, type AgentUsageWindow, type BotRunner, type ClaudeCodeStatus, type CustomAgent } from "@real-bot/protocol";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer } from "../engine/agent/jsonrpc";
import type { Store } from "../store";
import daemonPackage from "../../package.json";
import { resolveAgent } from "./runtime";
import type { OtherRunner } from "./status";

export const AGENT_USAGE_MAX_AGE_MS = 5 * 60_000;
export const AGENT_USAGE_REFRESH_MIN_MS = 30_000;
const ASK_TIMEOUT_MS = 15_000;

export type AgentUsageProbe = { current(maxAgeMs?: number): Promise<AgentUsageResponse> };

type InUse = { runner: OtherRunner; customId: string | null; configDir: string | null };

/** An agent account something runs on, Claude's included. */
export type AccountInUse = { runner: BotRunner; customId: string | null; configDir: string | null };

/**
 * Every agent account something runs on (ADR 0080): Bots, ladder rungs and built-in calls, each
 * account once. Settings keep an unset id or dir as '' and a Bot as null: the same account either way.
 */
export function accountsInUse(store: Store): AccountInUse[] {
  const out: AccountInUse[] = [];
  const add = (runner: unknown, customId: unknown, configDir: unknown) => {
    if (typeof runner !== "string" || !(runner in AGENT_KINDS)) return;
    const entry = { runner: runner as BotRunner, customId: runner === "custom" && typeof customId === "string" && customId ? customId : null, configDir: typeof configDir === "string" && configDir ? configDir : null };
    if (!out.some((seen) => seen.runner === entry.runner && seen.customId === entry.customId && seen.configDir === entry.configDir)) out.push(entry);
  };
  for (const bot of store.listBots()) if (!bot.archived_at) add(bot.runner, bot.agent_custom_id, bot.agent_config_dir);
  for (const rung of store.modelLadder()) if ("runner" in rung) add(rung.runner, rung.custom_id, rung.config_dir);
  const builtin = store.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings WHERE key LIKE '%\\_runner' ESCAPE '\\'").all();
  for (const row of builtin) {
    const role = row.key.slice(0, -"_runner".length);
    const get = (suffix: string) => store.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(`${role}_${suffix}`)?.value ?? null;
    add(row.value, get("custom_id"), get("config_dir"));
  }
  return out;
}

/**
 * Every account of an agent that is connected (ADR 0080, 2026-10-10 addendum): found on this
 * computer and not signed out, whether or not anything runs on it yet. An agent that cannot say
 * whether it is signed in (`logged_in` null) counts as connected once found.
 */
export function connectedAccounts(agents: ReadonlyArray<AgentStatus>, claude: ClaudeCodeStatus | null): AccountInUse[] {
  const out: AccountInUse[] = [];
  const add = (runner: BotRunner, customId: string | null, configDir: string | null) => {
    if (!out.some((seen) => seen.runner === runner && seen.customId === customId && seen.configDir === configDir)) out.push({ runner, customId, configDir });
  };
  if (claude?.path) {
    if (claude.accounts && claude.accounts.length > 0) {
      for (const account of claude.accounts) if (account.logged_in !== false) add("claude_code", null, account.config_dir);
    } else if (claude.logged_in !== false) add("claude_code", null, null);
  }
  for (const status of agents) {
    if (!status.path || status.runner === "claude_code" || !(status.runner in AGENT_KINDS)) continue;
    const customId = status.runner === "custom" ? status.custom_id : null;
    if (status.logged_in !== false) add(status.runner, customId, null);
    for (const account of status.accounts ?? []) if (account.config_dir && account.logged_in !== false) add(status.runner, customId, account.config_dir);
  }
  return out;
}

/** Accounts in use and connected ones together, each once. */
export function accountsShown(inUse: AccountInUse[], connected: AccountInUse[]): AccountInUse[] {
  const out = [...inUse];
  for (const entry of connected) {
    if (!out.some((seen) => seen.runner === entry.runner && seen.customId === entry.customId && seen.configDir === entry.configDir)) out.push(entry);
  }
  return out;
}

/**
 * What this app's own records hold of an agent since local midnight: its spend rows under its name,
 * turns counted as distinct turns among them (Claude's turns write no `agent_*` route decision).
 */
export function agentToday(store: Store, label: string): AgentUsage["today"] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const row = store.db.query<{ tokens: number | null; ticks: number | null; turns: number | null }, [string, string]>(
    "SELECT SUM(total_tokens) AS tokens, SUM(estimated_cost_usd_ticks) AS ticks, COUNT(DISTINCT turn_id) AS turns FROM spend WHERE provider_name = ? AND created_at >= ?").get(label, midnight.toISOString());
  return { turns: row?.turns ?? 0, tokens: row?.tokens ?? 0, estimated_usd: (row?.ticks ?? 0) / 1e10 };
}

export function createAgentUsageProbe(deps: {
  store: Store;
  /** Accounts of agents found and signed in (ADR 0080 addendum): shown even with nothing running on them. */
  connected?: () => Promise<AccountInUse[]>;
  /** A test's stand-in for asking Codex. */
  askCodex?: (env: Record<string, string>, executable: string) => Promise<Asked>;
  /** A test's stand-in for asking Grok (its ACP launch arguments come with it). */
  askGrok?: (env: Record<string, string>, executable: string, args: string[]) => Promise<Asked>;
  /** A test's stand-in for asking Antigravity. */
  askAntigravity?: (env: Record<string, string>, executable: string) => Promise<Asked>;
}): AgentUsageProbe {
  const { store } = deps;
  const cache = new Map<string, { usage: AgentUsage; at: number }>();

  /** Every agent account other than Claude's that something runs on or that is connected. */
  async function inUse(): Promise<InUse[]> {
    const connected = deps.connected ? await deps.connected().catch(() => []) : [];
    return accountsShown(accountsInUse(store), connected).filter((entry): entry is InUse => entry.runner !== "claude_code");
  }

  const today = (label: string) => agentToday(store, label);

  async function usageOf(entry: InUse, maxAgeMs: number): Promise<AgentUsage> {
    const key = `${entry.runner}\u0000${entry.customId ?? ""}\u0000${entry.configDir ?? ""}`;
    const cached = cache.get(key);
    const custom: CustomAgent | null = entry.runner === "custom" ? store.customAgent(entry.customId) : null;
    const label = entry.runner === "custom" && custom ? custom.name : AGENT_KINDS[entry.runner].label;
    if (cached && Date.now() - cached.at < maxAgeMs) return { ...cached.usage, today: today(label) };
    const usage: AgentUsage = {
      runner: entry.runner, custom_id: entry.customId, label, config_dir: entry.configDir, available: false, reason: "no_plan",
      plan: null, windows: [], credits: null, today: today(label), checked_at: new Date().toISOString(), error: null,
    };
    const runner = entry.runner;
    if (runner === "codex" || runner === "grok" || runner === "antigravity") {
      const resolved = await resolveAgent({ runner: entry.runner, custom, setting: store.agentPath(entry.runner), configDir: entry.configDir });
      if (!resolved.ok) Object.assign(usage, { reason: "missing", error: resolved.error });
      else {
        try {
          const asked = runner === "codex"
            ? await (deps.askCodex ?? askCodexLimits)(resolved.env, resolved.executable)
            : runner === "grok"
              ? await (deps.askGrok ?? askGrokBilling)(resolved.env, resolved.executable, resolved.args)
              : await (deps.askAntigravity ?? askAgyQuota)(resolved.env, resolved.executable);
          Object.assign(usage, asked, { available: asked.windows.length > 0, reason: asked.windows.length > 0 ? null : "no_plan" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          Object.assign(usage, cached?.usage ?? {}, { reason: /signed out|not (logged|signed) in|log ?in|auth/i.test(message) ? "signed_out" : "failed", error: message, checked_at: cached?.usage.checked_at ?? usage.checked_at });
        }
      }
    }
    cache.set(key, { usage, at: Date.now() });
    return usage;
  }

  return {
    async current(maxAgeMs = AGENT_USAGE_MAX_AGE_MS) {
      // Each account its own ask, all at once: a slow Codex holds up none of the others.
      return { items: await Promise.all((await inUse()).map((entry) => usageOf(entry, maxAgeMs))) };
    },
  };
}

/** Codex's own account of its plan: its windows and credits, asked of a private app-server. */
async function askCodexLimits(env: Record<string, string>, executable: string): Promise<Asked> {
  const launch = claudeLaunch(executable, ["app-server"], env);
  const child = spawn(launch.command, launch.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
  try {
    await rpc.request("initialize", { clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" }, capabilities: { experimentalApi: false, requestAttestation: false } }, ASK_TIMEOUT_MS);
    rpc.notify("initialized");
    const account = await rpc.request<{ account?: unknown }>("account/read", { refreshToken: false }, ASK_TIMEOUT_MS);
    if (!account?.account) throw new Error("signed out");
    const read = await rpc.request<{ rateLimits?: { planType?: string; primary?: Window | null; secondary?: Window | null; credits?: { balance?: string; hasCredits?: boolean; unlimited?: boolean } | null } }>("account/rateLimits/read", undefined, ASK_TIMEOUT_MS);
    const limits = read?.rateLimits ?? {};
    const windows = [limits.primary, limits.secondary].flatMap((window): AgentUsageWindow[] => (window && typeof window.usedPercent === "number"
      ? [{ minutes: window.windowDurationMins ?? null, percent: Math.max(0, Math.min(100, window.usedPercent)), resets_at: window.resetsAt ? new Date(window.resetsAt * (window.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null }]
      : []));
    const credits = limits.credits?.unlimited ? "unlimited" : limits.credits?.hasCredits && limits.credits.balance ? limits.credits.balance : null;
    return { plan: limits.planType ?? null, windows, credits };
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}

type Window = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null };

type Asked = Pick<AgentUsage, "plan" | "windows" | "credits">;

/** A billing period's length in minutes, from its type, else from its two ends. */
function periodMinutes(period: { type?: string; start?: string; end?: string } | undefined): number | null {
  const named: Record<string, number> = { USAGE_PERIOD_TYPE_DAILY: 1440, USAGE_PERIOD_TYPE_WEEKLY: 10_080, USAGE_PERIOD_TYPE_MONTHLY: 43_200 };
  if (period?.type && named[period.type]) return named[period.type]!;
  const span = Date.parse(period?.end ?? "") - Date.parse(period?.start ?? "");
  return Number.isFinite(span) && span > 0 ? Math.round(span / 60_000) : null;
}

/**
 * Grok's own account of its plan: `_x.ai/billing`, an ACP extension `grok agent stdio` answers right
 * after `initialize`, with no session opened (what its TUI's `/usage` shows). Not in Grok's public
 * documentation; an answer in another shape makes the account say it could not be read.
 */
export function readGrokBilling(answer: unknown): Asked {
  const billing = (answer ?? {}) as { config?: { creditUsagePercent?: number; currentPeriod?: { type?: string; start?: string; end?: string }; prepaidBalance?: { val?: number } }; subscription_tier?: string };
  const config = billing.config;
  if (!config || typeof config.creditUsagePercent !== "number") throw new Error("grok gave no billing");
  const end = config.currentPeriod?.end && !Number.isNaN(Date.parse(config.currentPeriod.end)) ? new Date(config.currentPeriod.end).toISOString() : null;
  const balance = config.prepaidBalance?.val;
  return {
    plan: typeof billing.subscription_tier === "string" && billing.subscription_tier.trim() ? billing.subscription_tier.trim() : null,
    windows: [{ minutes: periodMinutes(config.currentPeriod), percent: Math.max(0, Math.min(100, config.creditUsagePercent)), resets_at: end }],
    credits: typeof balance === "number" && balance > 0 ? String(balance) : null,
  };
}

async function askGrokBilling(env: Record<string, string>, executable: string, args: string[]): Promise<Asked> {
  const launch = claudeLaunch(executable, args, env);
  const child = spawn(launch.command, launch.args, { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: true });
  const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
  try {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "deskfolk", version: "usage" } }, ASK_TIMEOUT_MS);
    return readGrokBilling(await rpc.request("_x.ai/billing", {}, ASK_TIMEOUT_MS));
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}

/** The first `agy` that answers `-p "/quota"` itself instead of sending it to the model. */
const AGY_QUOTA_SINCE = [1, 1, 11];

/** Whether an `agy --version` is at least 1.1.11. */
export function agyAnswersQuota(version: string): boolean {
  const parts = version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i += 1) if (parts[i] !== AGY_QUOTA_SINCE[i]) return parts[i]! > AGY_QUOTA_SINCE[i]!;
  return true;
}

/**
 * `agy -p "/quota"`'s lines, one window each: the models it is for, its name, what is left, when it
 * starts over (`Gemini Models\tFive Hour Limit Remaining\t97%\t2026-10-10T15:38:12Z`).
 */
export function readAgyQuota(out: string): AgentUsageWindow[] {
  const windows: AgentUsageWindow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [model, name, left, resets] = line.split("\t");
    const remaining = Number.parseFloat(left ?? "");
    if (!model || !name || !/%\s*$/.test(left ?? "") || !Number.isFinite(remaining)) continue;
    const minutes = /five.?hour/i.test(name) ? 300 : /week/i.test(name) ? 10_080 : /day|daily/i.test(name) ? 1440 : /month/i.test(name) ? 43_200 : null;
    const at = resets && !Number.isNaN(Date.parse(resets.trim())) ? new Date(resets.trim()).toISOString() : null;
    windows.push({ minutes, model: model.trim(), percent: Math.max(0, Math.min(100, 100 - remaining)), resets_at: at });
  }
  return windows;
}

/** `agy -p "/credits"`'s remaining credits, when there are any. */
export function readAgyCredits(out: string): string | null {
  const row = out.split(/\r?\n/).map((line) => line.split("\t")).find((cells) => /remaining credits/i.test(cells[0] ?? ""));
  const value = row?.[1]?.trim();
  return value && Number(value) > 0 ? value : null;
}

async function askAgyQuota(env: Record<string, string>, executable: string): Promise<Asked> {
  const version = await runQuiet(executable, ["--version"], env);
  if (!agyAnswersQuota(version.out)) throw new Error(`agy ${version.out.trim() || "of an unknown version"} would send /quota to the model; update it to 1.1.11 or later`);
  const [quota, credits] = await Promise.all([
    runQuiet(executable, ["-p", "/quota"], env),
    runQuiet(executable, ["-p", "/credits"], env).then((answer) => readAgyCredits(answer.out)).catch(() => null),
  ]);
  const windows = readAgyQuota(quota.out);
  if (windows.length === 0) throw new Error((quota.err || quota.out).trim().slice(0, 300) || "agy gave no quota");
  return { plan: null, windows, credits };
}

/** Runs one of the agent's own commands in a scratch directory and gives back what it printed. */
function runQuiet(executable: string, args: string[], env: Record<string, string>): Promise<{ out: string; err: string }> {
  const launch = claudeLaunch(executable, args, env);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { env, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), ASK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ out, err });
    });
  });
}

