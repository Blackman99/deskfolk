import { afterEach, expect, test } from "bun:test";
import type { AgentStatus, AgentUsageResponse, ClaudeCodeStatus, ClaudeUsage, UsageResponse } from "@real-bot/protocol";
import { accountsInUse, accountsShown, agyAnswersQuota, askAgyTier, connectedAccounts, createAgentUsageProbe, readAgyCredits, readAgyQuota, readAgyTier, readGrokBilling, type AgentUsageProbe } from "./agents/usage";
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
    { runner: "opencode", custom_id: null, label: "OpenCode", config_dir: null, available: false, reason: "no_plan", plan: null, windows: [], credits: null, today: { turns: 2, tokens: 900, estimated_usd: 0 }, checked_at: null, error: null },
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
  expect(body.agents.map((agent) => agent.runner)).toEqual(["claude_code", "codex", "opencode"]);
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
  expect(body.agents[2]).toMatchObject({ label: "OpenCode", accounts: [], today: { turns: 2, tokens: 900 } });
  expect((await h.get("?refresh=1")).status).toBe(200);
  expect(ages).toEqual([undefined, undefined, 30_000, 30_000]);
  expect((await fetch(`${h.origin}/v1/usage`)).status).toBe(401);
});

test("wait=0 answers at once, each account still asked pending, and fills one account at a time", async () => {
  const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const codex = join(root, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  const store = new Store({ endpointKey: memoryKeyStore() });
  const answers = new Map<string, () => void>();
  let asked = 0;
  const agentUsage = createAgentUsageProbe({
    store,
    connected: async () => [{ runner: "codex", customId: null, configDir: null }, { runner: "codex", customId: null, configDir: "/opt/codex-b" }, { runner: "opencode", customId: null, configDir: null }],
    askCodex: (env) => {
      asked += 1;
      return new Promise((done) => answers.set(env.CODEX_HOME ?? "", () => done({ plan: env.CODEX_HOME ? "pro" : "plus", windows: [{ minutes: 300, percent: 10, resets_at: null }], credits: null })));
    },
  });
  const unused: ClaudeUsage = { available: false, reason: "unused", plan: null, windows: [], checked_at: null, error: null, accounts: [] };
  const api = createLocalApi({ store, token: "usage-test", schedule: false, claudeUsage: { current: async () => unused }, agentUsage });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  store.setAgentPath("codex", codex);
  const get = async (query: string) => (await (await fetch(`http://${server.hostname}:${server.port}/v1/usage${query}`, { headers: { Authorization: "Bearer usage-test" } })).json()) as UsageResponse;
  const codexOf = (body: UsageResponse) => body.agents.find((agent) => agent.runner === "codex")!.accounts.map((account) => [account.config_dir, account.pending, account.plan, account.checked_at === null]);

  // Nothing answered yet: every account there at once, pending and empty; OpenCode's day needs no ask.
  const first = await get("?wait=0");
  expect(first.agents.map((agent) => agent.runner)).toEqual(["codex", "opencode"]);
  expect(codexOf(first)).toEqual([[null, true, null, true], ["/opt/codex-b", true, null, true]]);
  await Bun.sleep(5);
  expect(asked).toBe(2);
  // Asked again while they run: still pending, nothing asked twice.
  expect(codexOf(await get("?wait=0"))).toEqual([[null, true, null, true], ["/opt/codex-b", true, null, true]]);
  expect(asked).toBe(2);
  // The second account answers first: its card fills, the first still waits.
  answers.get("/opt/codex-b")!();
  await Bun.sleep(5);
  expect(codexOf(await get("?wait=0"))).toEqual([[null, true, null, true], ["/opt/codex-b", false, "pro", false]]);
  answers.get("")!();
  await Bun.sleep(5);
  expect(codexOf(await get("?wait=0"))).toEqual([[null, false, "plus", false], ["/opt/codex-b", false, "pro", false]]);
  // The waiting answer stays as it was: no `pending` in it.
  const plain = await get("");
  expect(plain.agents[0]!.accounts.every((account) => !("pending" in account))).toBe(true);
  expect(asked).toBe(2);
});

test("wait=0 waits for a probe that cannot answer at once, and marks nothing pending", async () => {
  const h = start({ claudeUsage: { current: async () => claude }, agentUsage: { current: async () => others } });
  const body = await (await h.get("?wait=0")).json() as UsageResponse;
  expect(body.agents.map((agent) => agent.runner)).toEqual(["claude_code", "codex", "opencode"]);
  expect(body.agents.flatMap((agent) => agent.accounts.map((account) => account.pending))).toEqual([false, false, false]);
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
    const probe = createAgentUsageProbe({ store, connected: async () => [{ runner: "opencode", customId: null, configDir: null }] });
    expect((await probe.current()).items.map((item) => [item.runner, item.reason])).toEqual([["opencode", "no_plan"]]);
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
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage", query: { wait: "0" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage", query: { wait: "0", refresh: "1" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/usage", query: { wait: "1" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/usage" })).toThrow();
  const remote = await h.api.dispatchBusiness(new Request("http://remote.invalid/v1/usage"), { deviceId: "paired-device", requestId: ulid() });
  expect(remote.status).toBe(200);
  expect((await remote.json() as UsageResponse).agents.map((agent) => agent.runner)).toEqual(["claude_code", "codex", "opencode"]);
});

test("a Grok account's usage is asked of grok with that account's GROK_HOME", async () => {
  const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "grok-usage-"));
  const grok = join(root, "grok");
  writeFileSync(grok, "#!/bin/sh\nexit 0\n");
  chmodSync(grok, 0o755);
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    store.setAgentPath("grok", grok);
    store.setAgentConfigDirs("grok", ["/opt/grok-b"]);
    store.createBot({ name: "Grok Bot", duties: "x", boundaries: "y", runner: "grok", agent_config_dir: "/opt/grok-b" });
    const homes: Array<string | undefined> = [];
    const probe = createAgentUsageProbe({
      store,
      askGrok: async (env) => { homes.push(env.GROK_HOME); return { plan: "SuperGrok", windows: [], credits: null }; },
    });
    const usage = await probe.current() as AgentUsageResponse;
    expect(usage.items.map((item) => [item.runner, item.config_dir])).toEqual([["grok", "/opt/grok-b"]]);
    expect(homes).toEqual(["/opt/grok-b"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
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

test("Grok's billing reads as one window over its billing period, its tier as the plan", () => {
  expect(readGrokBilling({
    config: {
      creditUsagePercent: 41, prepaidBalance: { val: 0 },
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-05T05:02:04.120111+00:00", end: "2026-10-12T05:02:04.120111+00:00" },
    },
    subscription_tier: "SuperGrok Heavy",
  })).toEqual({ plan: "SuperGrok Heavy", windows: [{ minutes: 10_080, percent: 41, resets_at: "2026-10-12T05:02:04.120Z" }], credits: null });
  // A period type it does not name: the length from its two ends.
  expect(readGrokBilling({ config: { creditUsagePercent: 5, currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" }, prepaidBalance: { val: 25 } } }))
    .toMatchObject({ plan: null, windows: [{ minutes: 1440, percent: 5 }], credits: "25" });
  expect(() => readGrokBilling({ something: "else" })).toThrow();
});

test("Antigravity's /quota lines read as one window per model group and length; only an agy from 1.1.11 is asked", () => {
  const out = [
    "Gemini Models\tWeekly Limit Remaining\t98%\t2026-10-14T02:50:38Z",
    "Gemini Models\tFive Hour Limit Remaining\t97%\t2026-10-10T15:38:12Z",
    "Claude and GPT models\tWeekly Limit Remaining\t87%\t2026-10-17T09:07:38Z",
    "something else",
  ].join("\n");
  expect(readAgyQuota(out)).toEqual([
    { minutes: 10_080, model: "Gemini Models", percent: 2, resets_at: "2026-10-14T02:50:38.000Z" },
    { minutes: 300, model: "Gemini Models", percent: 3, resets_at: "2026-10-10T15:38:12.000Z" },
    { minutes: 10_080, model: "Claude and GPT models", percent: 13, resets_at: "2026-10-17T09:07:38.000Z" },
  ]);
  expect([readAgyCredits("Remaining credits\t0\nUpgrade\thttps://x"), readAgyCredits("Remaining credits\t120")]).toEqual([null, "120"]);
  // Before 1.1.11 `-p "/quota"` went to the model as a prompt: such an agy is never asked.
  expect(["1.3.3", "1.1.11", "1.1.10", "0.9.0", "2.0.0", "nonsense"].map(agyAnswersQuota)).toEqual([true, true, false, false, true, false]);
});

test("Antigravity's windows and subscription tier keep through the one route", async () => {
  expect(readAgyTier({ _meta: { antigravity: { tier: { name: "  Google AI Ultra  ", id: "g1-ultra-lite-tier" } } } })).toBe("Google AI Ultra");
  expect([readAgyTier(null), readAgyTier({}), readAgyTier({ _meta: { antigravity: { tier: { name: "   ", id: "x" } } } })]).toEqual([null, null, null]);
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    const probe = createAgentUsageProbe({
      store,
      connected: async () => [{ runner: "antigravity", customId: null, configDir: null }],
      askAntigravity: async () => ({ plan: "Google AI Ultra", windows: [{ minutes: 300, model: "Gemini Models", percent: 3, resets_at: null }], credits: null }),
    });
    const [item] = (await probe.current()).items;
    if (item!.reason !== "missing") expect(item).toMatchObject({ available: true, plan: "Google AI Ultra", windows: [{ minutes: 300, model: "Gemini Models", percent: 3 }] });
  } finally {
    store.close();
  }
});

test("askAgyTier reads the subscription tier via session/resume without opening a new session", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fakeAgy = join(import.meta.dir, "fixtures/agents/fake-agy.ts");
  const runFake = async (script: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "agy-tier-"));
    const logPath = join(dir, "log.jsonl");
    try {
      const env = { ...process.env, FAKE_AGY_SCRIPT: JSON.stringify(script), FAKE_AGY_LOG: logPath } as Record<string, string>;
      const tier = await askAgyTier(env, process.execPath, [fakeAgy]);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }).filter((entry) => entry.method);
      return { tier, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Resumes the oldest session (skipping an unreadable one) and closes it; never calls session/new.
  const ok = await runFake({
    tier: { name: "Google AI Ultra", id: "g1-ultra-lite-tier" },
    gone: ["old-broken"],
    sessions: [
      { sessionId: "newest", cwd: "/tmp", title: "new", updatedAt: "2026-11-24T00:00:00Z", history: [] },
      { sessionId: "old-broken", cwd: "/tmp", title: "broken", updatedAt: "2026-10-01T00:00:00Z", history: [] },
      { sessionId: "old-ok", cwd: "/tmp", title: "ok", updatedAt: "2026-10-10T00:00:00Z", history: [] },
    ],
    prompts: [],
  });
  expect(ok.tier).toBe("Google AI Ultra");
  expect(ok.calls.map((c) => c.method)).toEqual(["initialize", "session/list", "session/resume", "session/resume", "session/close"]);
  expect(ok.calls[2]!.params?.sessionId).toBe("old-broken");
  expect(ok.calls[3]!.params?.sessionId).toBe("old-ok");
  expect(ok.calls[4]!.params?.sessionId).toBe("old-ok");

  // Without tier capability, stops right after initialize.
  const noCap = await runFake({ caps: { tier: false }, sessions: [{ sessionId: "s1", cwd: "/tmp", title: "t", updatedAt: "2026-10-10T00:00:00Z", history: [] }], prompts: [] });
  expect(noCap.tier).toBeNull();
  expect(noCap.calls.map((c) => c.method)).toEqual(["initialize"]);

  // With no existing sessions, returns null and never creates a new session.
  const empty = await runFake({ tier: { name: "Google AI Pro" }, sessions: [], prompts: [] });
  expect(empty.tier).toBeNull();
  expect(empty.calls.map((c) => c.method)).toEqual(["initialize", "session/list"]);
});

