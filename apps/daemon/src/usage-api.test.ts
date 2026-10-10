import { afterEach, expect, test } from "bun:test";
import type { AgentStatus, AgentUsageResponse, ClaudeCodeStatus, ClaudeUsage, UsageResponse } from "@real-bot/protocol";
import { accountsInUse, accountsShown, connectedAccounts, createAgentUsageProbe, type AgentUsageProbe } from "./agents/usage";
import type { ClaudeUsageProbe } from "./claude-code/usage";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const claude: ClaudeUsage = {
  available: true, reason: null, plan: "max", checked_at: "2026-10-10T09:00:00.000Z", error: null,
  windows: [
    { kind: "five_hour", model: null, percent: 38, resets_at: "2026-10-10T12:00:00.000Z" },
    { kind: "seven_day", model: null, percent: 19, resets_at: null },
    { kind: "model", model: "Opus", percent: 45, resets_at: null },
  ],
  accounts: [{
    available: true, reason: null, plan: "max", checked_at: "2026-10-10T09:00:00.000Z", error: null, config_dir: null, email: "a@example.com",
    windows: [
      { kind: "five_hour", model: null, percent: 38, resets_at: "2026-10-10T12:00:00.000Z" },
      { kind: "seven_day", model: null, percent: 19, resets_at: null },
      { kind: "model", model: "Opus", percent: 45, resets_at: null },
    ],
  }],
};

const today = { turns: 0, tokens: 0, estimated_usd: 0 };
const others: AgentUsageResponse = {
  items: [
    { runner: "grok", custom_id: null, label: "Grok", config_dir: null, available: false, reason: "no_plan", plan: null, windows: [], credits: null, today: { turns: 2, tokens: 900, estimated_usd: 0 }, checked_at: null, error: null },
    { runner: "codex", custom_id: null, label: "Codex", config_dir: null, available: true, reason: null, plan: "plus", windows: [{ minutes: 300, percent: 60, resets_at: null }], credits: "12", today, checked_at: null, error: null },
    { runner: "codex", custom_id: null, label: "Codex", config_dir: "/opt/codex-b", available: false, reason: "signed_out", plan: null, windows: [], credits: null, today, checked_at: null, error: "signed out" },
  ],
};

function start(options: { claudeUsage?: ClaudeUsageProbe; agentUsage?: AgentUsageProbe } = {}) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "usage-test", schedule: false, ...options });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const get = (query = "") => fetch(`${origin}/v1/usage${query}`, { headers: { Authorization: "Bearer usage-test" } });
  return { store, api, get, origin };
}

test("one answer for every agent: Claude first, accounts grouped under their agent, no accounts for an agent with no plan", async () => {
  const ages: Array<number | undefined> = [];
  const h = start({
    claudeUsage: { current: async (maxAgeMs) => { ages.push(maxAgeMs); return claude; } },
    agentUsage: { current: async (maxAgeMs) => { ages.push(maxAgeMs); return others; } },
  });
  h.store.createBot({ name: "Coder", duties: "code", boundaries: "stay", runner: "claude_code" });
  const response = await h.get();
  expect(response.status).toBe(200);
  const body = await response.json() as UsageResponse;
  expect(body.agents.map((agent) => agent.runner)).toEqual(["claude_code", "codex", "grok"]);
  expect(body.agents[0]).toMatchObject({
    label: "Claude Agent",
    accounts: [{
      email: "a@example.com", plan: "max", credits: null,
      windows: [
        { minutes: 300, model: null, percent: 38, resets_at: "2026-10-10T12:00:00.000Z" },
        { minutes: 10_080, model: null, percent: 19 },
        { minutes: 10_080, model: "Opus", percent: 45 },
      ],
    }],
  });
  expect(body.agents[1]!.accounts.map((account) => [account.config_dir, account.reason, account.credits])).toEqual([[null, null, "12"], ["/opt/codex-b", "signed_out", null]]);
  expect(body.agents[2]).toMatchObject({ label: "Grok", accounts: [], today: { turns: 2, tokens: 900 } });
  expect((await h.get("?refresh=1")).status).toBe(200);
  expect(ages).toEqual([undefined, undefined, 30_000, 30_000]);
  expect((await fetch(`${h.origin}/v1/usage`)).status).toBe(401);
});

test("Claude is left out when nothing runs on it and no account of it is connected", async () => {
  const h = start({
    claudeUsage: { current: async () => ({ available: false, reason: "unused", plan: null, windows: [], checked_at: null, error: null, accounts: [] }) },
    agentUsage: { current: async () => ({ items: [] }) },
  });
  expect(await (await h.get()).json()).toEqual({ agents: [] });
});

test("connected accounts: found and not signed out, each once, whether or not anything runs on them", () => {
  const status = (over: Partial<AgentStatus>): AgentStatus => ({ runner: "codex", custom_id: null, label: "Codex", path: "/bin/x", logged_in: true, accounts: [], ...over } as AgentStatus);
  const claudeStatus = {
    path: "/c", logged_in: true,
    accounts: [{ config_dir: null, logged_in: true }, { config_dir: "/opt/claude-b", logged_in: true }, { config_dir: "/opt/claude-c", logged_in: false }],
  } as unknown as ClaudeCodeStatus;
  const connected = connectedAccounts([
    status({ accounts: [{ config_dir: null, logged_in: true }, { config_dir: "/opt/codex-b", logged_in: true }, { config_dir: "/opt/codex-c", logged_in: false }] as AgentStatus["accounts"] }),
    status({ runner: "grok", label: "Grok", logged_in: null }),
    status({ runner: "opencode", label: "OpenCode", path: null }),
    status({ runner: "antigravity", label: "Antigravity", logged_in: false }),
    status({ runner: "custom", custom_id: "ca-1", label: "mine" }),
  ], claudeStatus);
  expect(connected.map((entry) => [entry.runner, entry.customId, entry.configDir])).toEqual([
    ["claude_code", null, null], ["claude_code", null, "/opt/claude-b"],
    ["codex", null, null], ["codex", null, "/opt/codex-b"],
    ["grok", null, null], ["custom", "ca-1", null],
  ]);
  // In use and connected together, each once.
  expect(accountsShown([{ runner: "codex", customId: null, configDir: null }], connected)).toHaveLength(connected.length);
});

test("the agents' usage lists a connected agent with nothing running on it", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    const probe = createAgentUsageProbe({ store, connected: async () => [{ runner: "grok", customId: null, configDir: null }] });
    expect((await probe.current()).items.map((item) => [item.runner, item.reason])).toEqual([["grok", "no_plan"]]);
  } finally {
    store.close();
  }
});

test("a phone reads it too: the bare GET and a refresh are whitelisted, nothing else is", async () => {
  const h = start({ claudeUsage: { current: async () => claude }, agentUsage: { current: async () => others } });
  const id = ulid();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage", query: { refresh: "1" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage", query: { refresh: "yes" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/usage" })).toThrow();
  const remote = await h.api.dispatchBusiness(new Request("http://remote.invalid/v1/usage"), { deviceId: "paired-device", requestId: ulid() });
  expect(remote.status).toBe(200);
  expect((await remote.json() as UsageResponse).agents.map((agent) => agent.runner)).toEqual(["claude_code", "codex", "grok"]);
});

test("a Claude account only a built-in call runs on is in use too", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    expect(accountsInUse(store)).toEqual([]);
    store.setClaudeCodeConfigDirs(["/opt/claude-b"]);
    store.patchSettingsSync({ builtin_models: { reader: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" } } });
    expect(accountsInUse(store)).toEqual([{ runner: "claude_code", customId: null, configDir: "/opt/claude-b" }]);
  } finally {
    store.close();
  }
});

test("today counts an agent's turns as the distinct turns among its spend rows, Claude's included", async () => {
  const h = start({ claudeUsage: { current: async () => claude }, agentUsage: { current: async () => ({ items: [] }) } });
  const { bot, direct_session: session } = h.store.createBot({ name: "Coder", duties: "code", boundaries: "stay", runner: "claude_code" });
  const spend = (turnId: string | null, tokens: number, at = new Date().toISOString()) => h.store.db.run(
    "INSERT INTO spend (id, session_id, bot_id, turn_id, judgement_id, kind, provider_name, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Claude Agent', ?, ?)",
    [ulid(), session.id, bot.id, turnId, turnId ? null : ulid(), turnId ? "turn" : "judgement", tokens, at]);
  spend("t1", 100);
  spend("t1", 50);
  spend("t2", 10);
  spend(null, 5);
  spend("t0", 1_000, "2000-01-01T00:00:00.000Z");
  const body = await (await h.get()).json() as UsageResponse;
  expect(body.agents[0]).toMatchObject({ runner: "claude_code", today: { turns: 2, tokens: 165 } });
});
