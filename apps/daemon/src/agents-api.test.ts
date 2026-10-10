/**
 * Your local agents other than Claude Code in Settings (ADR 0079): their status, path, accounts and
 * your own ACP agents, from this Mac and a paired phone alike; their usage. The agents themselves
 * are stood in for: each look is the probe's.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isNonReceiptPath, type AgentStatus, type AgentsStatusResponse, type AgentUsageResponse } from "@real-bot/protocol";
import type { AgentProbe, OtherRunner } from "./agents/status";
import { createAgentUsageProbe } from "./agents/usage";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

function statusOf(runner: OtherRunner, customId: string | null = null): AgentStatus {
  return {
    runner, custom_id: customId, label: runner, path: `/usr/local/bin/${runner}`, source: "known", version: "1.0", logged_in: true, auth: null,
    login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: new Date(0).toISOString(), error: null,
  };
}

function start(options: { agents?: AgentProbe } = {}) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const looks: string[] = [];
  const agents: AgentProbe = options.agents ?? {
    async list() { return { items: (["codex", "grok"] as OtherRunner[]).map((runner) => statusOf(runner)), custom_agents: store.customAgents() }; },
    async current(runner, customId) { looks.push(`current ${runner}`); return statusOf(runner, customId ?? null); },
    async detect(runner, customId) { looks.push(`detect ${runner} ${customId ?? ""}`.trim()); return statusOf(runner, customId ?? null); },
    noteModels() {},
  };
  const api = createLocalApi({ store, token: "agents-test", schedule: false, agents });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(`${origin}${path}`, {
    method, headers: { Authorization: "Bearer agents-test", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, api, call, looks, origin };
}

test("Settings lists every local agent besides Claude Code, and a re-check looks again", async () => {
  const h = start();
  const listed = await (await h.call("GET", "/v1/runtime/agents")).json() as AgentsStatusResponse;
  expect(listed.items.map((item) => item.runner)).toEqual(["codex", "grok"]);
  const detected = await (await h.call("POST", "/v1/runtime/agents/detect", { runner: "codex" })).json() as AgentStatus;
  expect(detected.runner).toBe("codex");
  expect(h.looks).toContain("detect codex");
  expect((await h.call("POST", "/v1/runtime/agents/detect", { runner: "claude_code" })).status).toBe(422);
  expect((await fetch(`${h.origin}/v1/runtime/agents`)).status).toBe(401);
});

test("a path you set is kept per agent and checked as absolute", async () => {
  const h = start();
  expect((await h.call("PUT", "/v1/runtime/agents/path", { runner: "codex", path: "/opt/codex/bin/codex" })).status).toBe(200);
  expect(h.store.agentPath("codex")).toBe("/opt/codex/bin/codex");
  expect(h.store.agentPath("grok")).toBeNull();
  expect((await h.call("PUT", "/v1/runtime/agents/path", { runner: "codex", path: "codex" })).status).toBe(422);
  expect((await h.call("PUT", "/v1/runtime/agents/path", { runner: "codex", path: null })).status).toBe(200);
  expect(h.store.agentPath("codex")).toBeNull();
});

test("accounts are listed for an agent that has config directories, and one a Bot runs on stays", async () => {
  const h = start();
  const dir = join(homedir(), ".codex-work");
  expect((await h.call("PUT", "/v1/runtime/agents/accounts", { runner: "codex", config_dirs: [dir] })).status).toBe(200);
  expect(h.store.agentConfigDirs("codex")).toEqual([dir]);
  // Grok has none the app knows of.
  expect((await h.call("PUT", "/v1/runtime/agents/accounts", { runner: "grok", config_dirs: [dir] })).status).toBe(422);
  h.store.createBot({ name: "Coder", duties: "code", boundaries: "none", runner: "codex", agent_config_dir: dir });
  const refused = await h.call("PUT", "/v1/runtime/agents/accounts", { runner: "codex", config_dirs: [] });
  expect(refused.status).toBe(409);
  expect(JSON.stringify(await refused.json())).toContain("Coder");
  // Nor may a Bot read what is in it.
  expect(h.store.allAgentConfigDirs()).toContain(dir);
});

test("your own ACP agents are kept whole, and one a Bot runs on cannot be taken away", async () => {
  const h = start();
  const saved = await (await h.call("PUT", "/v1/runtime/custom-agents", { agents: [{ name: "Kimi", command: "/usr/local/bin/kimi", args: ["--acp"] }] })).json() as AgentsStatusResponse;
  expect(saved.custom_agents).toHaveLength(1);
  const kimi = saved.custom_agents[0]!;
  expect(kimi).toMatchObject({ name: "Kimi", command: "/usr/local/bin/kimi", args: ["--acp"] });
  expect((await h.call("PUT", "/v1/runtime/custom-agents", { agents: [{ name: "Bad", command: "kimi" }] })).status).toBe(422);
  const bot = h.store.createBot({ name: "Helper", duties: "help", boundaries: "none", runner: "custom", agent_custom_id: kimi.id });
  expect(bot.bot).toMatchObject({ runner: "custom", agent_custom_id: kimi.id });
  expect(() => h.store.createBot({ name: "Other", duties: "x", boundaries: "y", runner: "custom", agent_custom_id: "nope" })).toThrow("custom agents");
  expect((await h.call("PUT", "/v1/runtime/custom-agents", { agents: [] })).status).toBe(409);
  // Renamed in place, it keeps its id and its Bot.
  const renamed = await (await h.call("PUT", "/v1/runtime/custom-agents", { agents: [{ ...kimi, name: "Kimi K3" }] })).json() as AgentsStatusResponse;
  expect(renamed.custom_agents[0]).toMatchObject({ id: kimi.id, name: "Kimi K3" });
});

test("a phone reaches the same routes, and none of them takes a receipt", async () => {
  const h = start();
  const id = ulid();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/runtime/agents" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/runtime/agents/detect", body: { runner: "grok" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/runtime/agents/detect", body: { runner: "nope" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PUT", path: "/v1/runtime/agents/path", body: { runner: "codex", path: null } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PUT", path: "/v1/runtime/custom-agents", body: { agents: [] } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/agent-usage", query: { refresh: "1" } })).not.toThrow();
  // The app's tools for an agent are never on the relay.
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/agent-mcp/abc" })).toThrow();
  const remote = await h.api.dispatchBusiness(new Request("http://remote.invalid/v1/runtime/agents"), { deviceId: "paired-device", requestId: ulid() });
  expect(remote.status).toBe(200);
  for (const path of ["/v1/runtime/agents/detect", "/v1/runtime/agents/path", "/v1/runtime/agents/accounts", "/v1/runtime/custom-agents"]) {
    expect(isNonReceiptPath(path)).toBe(true);
  }
});

test("usage shows Codex's and Grok's own windows, and only today's records for an agent with no plan to report", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-usage-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    store.createBot({ name: "Codex Bot", duties: "x", boundaries: "y", runner: "codex" });
    store.createBot({ name: "Grok Bot", duties: "x", boundaries: "y", runner: "grok" });
    store.createBot({ name: "Open Bot", duties: "x", boundaries: "y", runner: "opencode" });
    store.createBot({ name: "Plain", duties: "x", boundaries: "y" });
    // Built-in calls on the same Codex account count once, though settings keep an unset id as ''.
    const onCodex = { runner: "codex", model: "gpt-5.6", config_dir: null } as const;
    store.patchSettingsSync({ builtin_models: { reader: onCodex, organizer: onCodex } });
    const probe = createAgentUsageProbe({
      store,
      askCodex: async () => ({ plan: "plus", windows: [{ minutes: 300, percent: 12, resets_at: "2026-10-10T15:00:00.000Z" }], credits: null }),
      askGrok: async () => ({ plan: "SuperGrok Heavy", windows: [{ minutes: 10_080, percent: 41, resets_at: null }], credits: null }),
    });
    const usage = await probe.current() as AgentUsageResponse;
    expect(usage.items.map((item) => item.runner).sort()).toEqual(["codex", "grok", "opencode"]);
    const codex = usage.items.find((item) => item.runner === "codex")!;
    // Found or not, the stand-in answers only once the command is found; a missing codex says so.
    if (codex.reason === "missing") expect(codex.available).toBe(false);
    else expect(codex).toMatchObject({ available: true, plan: "plus", windows: [{ minutes: 300, percent: 12 }] });
    const grok = usage.items.find((item) => item.runner === "grok")!;
    if (grok.reason !== "missing") expect(grok).toMatchObject({ available: true, plan: "SuperGrok Heavy", windows: [{ minutes: 10_080, percent: 41 }] });
    const opencode = usage.items.find((item) => item.runner === "opencode")!;
    expect(opencode).toMatchObject({ available: false, reason: "no_plan", windows: [], today: { turns: 0, tokens: 0 } });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
