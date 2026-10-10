/**
 * Your local agents' usage (ADR 0079, `GET /v1/agent-usage`), for the agents some Bot, ladder rung
 * or built-in call runs on. Codex reports its plan's windows itself (`account/rateLimits/read` on
 * its app-server — no model call, nothing spent); the others report none, and show what this
 * app's own records hold of them today instead: never a percentage an agent did not give. Claude's
 * own stays `GET /v1/claude-usage` (ADR 0061).
 */
import { spawn } from "node:child_process";
import { AGENT_KINDS, type AgentUsage, type AgentUsageResponse, type AgentUsageWindow, type BotRunner, type CustomAgent } from "@real-bot/protocol";
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

export function createAgentUsageProbe(deps: {
  store: Store;
  /** A test's stand-in for asking Codex. */
  askCodex?: (env: Record<string, string>, executable: string) => Promise<Pick<AgentUsage, "plan" | "windows" | "credits">>;
}): AgentUsageProbe {
  const { store } = deps;
  const cache = new Map<string, { usage: AgentUsage; at: number }>();

  /** Every agent account something runs on: Bots, ladder rungs, built-in calls. */
  function inUse(): InUse[] {
    const out: InUse[] = [];
    const add = (runner: unknown, customId: unknown, configDir: unknown) => {
      if (typeof runner !== "string" || runner === "claude_code" || !(runner in AGENT_KINDS)) return;
      // Settings keep an unset id or dir as '' and a Bot as null: the same account either way.
      const entry = { runner: runner as OtherRunner, customId: runner === "custom" && typeof customId === "string" && customId ? customId : null, configDir: typeof configDir === "string" && configDir ? configDir : null };
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

  function today(label: string, runner: BotRunner): AgentUsage["today"] {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.toISOString();
    const spent = store.db.query<{ tokens: number | null; ticks: number | null }, [string, string]>(
      "SELECT SUM(total_tokens) AS tokens, SUM(estimated_cost_usd_ticks) AS ticks FROM spend WHERE provider_name = ? AND created_at >= ?").get(label, since);
    const turns = store.db.query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM turn_route_decisions WHERE reason_code = ? AND created_at >= ?").get(`agent_${runner}`, since);
    return { turns: turns?.n ?? 0, tokens: spent?.tokens ?? 0, estimated_usd: (spent?.ticks ?? 0) / 1e10 };
  }

  async function usageOf(entry: InUse, maxAgeMs: number): Promise<AgentUsage> {
    const key = `${entry.runner}\u0000${entry.customId ?? ""}\u0000${entry.configDir ?? ""}`;
    const cached = cache.get(key);
    const custom: CustomAgent | null = entry.runner === "custom" ? store.customAgent(entry.customId) : null;
    const label = entry.runner === "custom" && custom ? custom.name : AGENT_KINDS[entry.runner].label;
    if (cached && Date.now() - cached.at < maxAgeMs) return { ...cached.usage, today: today(label, entry.runner) };
    const usage: AgentUsage = {
      runner: entry.runner, custom_id: entry.customId, label, config_dir: entry.configDir, available: false, reason: "no_plan",
      plan: null, windows: [], credits: null, today: today(label, entry.runner), checked_at: new Date().toISOString(), error: null,
    };
    if (AGENT_KINDS[entry.runner].planUsage && entry.runner === "codex") {
      const resolved = await resolveAgent({ runner: entry.runner, custom, setting: store.agentPath(entry.runner), configDir: entry.configDir });
      if (!resolved.ok) Object.assign(usage, { reason: "missing", error: resolved.error });
      else {
        try {
          const asked = await (deps.askCodex ?? askCodexLimits)(resolved.env, resolved.executable);
          Object.assign(usage, asked, { available: asked.windows.length > 0, reason: asked.windows.length > 0 ? null : "no_plan" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          Object.assign(usage, cached?.usage ?? {}, { reason: /signed out|not logged|auth/i.test(message) ? "signed_out" : "failed", error: message, checked_at: cached?.usage.checked_at ?? usage.checked_at });
        }
      }
    }
    cache.set(key, { usage, at: Date.now() });
    return usage;
  }

  return {
    async current(maxAgeMs = AGENT_USAGE_MAX_AGE_MS) {
      const items: AgentUsage[] = [];
      for (const entry of inUse()) items.push(await usageOf(entry, maxAgeMs));
      return { items };
    },
  };
}

/** Codex's own account of its plan: its windows and credits, asked of a private app-server. */
async function askCodexLimits(env: Record<string, string>, executable: string): Promise<Pick<AgentUsage, "plan" | "windows" | "credits">> {
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
