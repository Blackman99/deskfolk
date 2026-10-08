/**
 * ADR 0067 end to end in the store, the routing and the local API: a model server on this computer
 * or network is saved and used without a key, its models' windows are kept and read, the probe
 * asks the server about them, and the speed test records what it measured.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResult, CompletionsClient } from "./completions";
import { runCollabTool } from "./collab-tools";
import { createRouting } from "./engine/routing";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const OLLAMA = "http://localhost:11434/v1";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function store(): Store {
  const s = new Store({ endpointKey: memoryKeyStore() });
  cleanup.push(() => s.close());
  return s;
}

function routingOf(s: Store) {
  return createRouting({ store: s, completions: {} as never, recordResponseSpend: () => null, spendOwner: () => ({}) as never });
}

test("a local endpoint saved without a key is ready to run on; a cloud one without a key is not", async () => {
  const s = store();
  const workspace = mkdtempSync(join(tmpdir(), "rb-local-"));
  await s.patchSettings({ workspace_path: workspace });
  const cloud = s.createProviderSync({ name: "Cloud", base_url: "https://api.example.com/v1", models: ["gpt"] });
  expect((await s.settings()).wizard_complete).toBe(false);
  expect(await routingOf(s).credentials()).toBeNull();

  const local = s.createProviderSync({ name: "Ollama", base_url: OLLAMA, models: ["qwen3:8b"] });
  expect((await s.settings()).wizard_complete).toBe(true);
  const creds = await routingOf(s).credentials();
  expect(creds?.providers.map((row) => [row.id, row.apiKey])).toEqual([[local.id, ""]]);
  expect(creds?.providers.some((row) => row.id === cloud.id)).toBe(false);
});

test("a Bot adds a local endpoint without a key, and still needs one for a cloud endpoint", async () => {
  const s = store();
  const { bot, direct_session } = s.createBot({ name: "Setup", duties: "test", boundaries: "fixture" });
  const ctx = { store: s, botId: bot.id, sessionId: direct_session.id, turnId: "fixture-turn", parentId: null };
  const asked = await runCollabTool(ctx, "add_endpoint", { name: "Ollama", base_url: OLLAMA, models: ["qwen3:8b"] });
  expect(asked.waitApproval?.requiresApiKey).toBe(false);
  const added = await runCollabTool({ ...ctx, approved: true }, "add_endpoint", { name: "Ollama", base_url: OLLAMA, models: ["qwen3:8b"] });
  expect(added.ok).toBe(true);
  expect((await s.getProvider(added.data!.id as string)).key_set).toBe(false);

  const cloud = await runCollabTool(ctx, "add_endpoint", { name: "Cloud", base_url: "https://api.example.com/v1" });
  expect(cloud.waitApproval?.requiresApiKey).toBe(true);
  const refused = await runCollabTool({ ...ctx, approved: true }, "add_endpoint", { name: "Cloud", base_url: "https://api.example.com/v1" }).catch((error: Error) => error);
  expect(JSON.stringify(refused instanceof Error ? refused.message : refused)).toContain("api_key is required");
});

test("a model's window is kept through a form save, cleared by null, and recorded from its server", async () => {
  const s = store();
  const provider = s.createProviderSync({ name: "Ollama", base_url: OLLAMA, models: [{ name: "qwen3:8b", context_window: 40_960 }] });
  expect(s.contextWindowOf(OLLAMA, "qwen3:8b")).toBe(40_960);
  // The form sends each name with only the fields it shows.
  s.patchProviderSync(provider.id, { models: [{ name: "qwen3:8b", price: 1 }] });
  expect(s.contextWindowOf(OLLAMA, "qwen3:8b")).toBe(40_960);
  s.recordContextWindow(OLLAMA, "qwen3:8b", 32_768);
  expect((await s.getProvider(provider.id)).model_catalog[0]).toMatchObject({ name: "qwen3:8b", price: 1, context_window: 32_768 });
  s.patchProviderSync(provider.id, { models: [{ name: "qwen3:8b", context_window: null }] });
  expect(s.contextWindowOf(OLLAMA, "qwen3:8b")).toBeUndefined();
  expect(() => s.patchProviderSync(provider.id, { models: [{ name: "qwen3:8b", context_window: 1.5 }] })).toThrow("context_window");
  expect(s.recordModelFacts(provider.id, "not-listed", { stream_tps_p10: 9 })).toBe(false);
});

async function startApi(s: Store, completions?: CompletionsClient) {
  const api = createLocalApi({ store: s, token: "fixture", schedule: false, ...(completions ? { completions } : {}) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  cleanup.push(async () => {
    await api.engine.close();
    server.stop(true);
  });
  return (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
      method,
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test("probing a local Ollama reads each model's window, pictures and tools from the server", async () => {
  const ollama = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.headers.get("authorization")) return new Response("no key expected", { status: 400 });
      if (path === "/v1/models") return Response.json({ data: [{ id: "qwen3:8b" }, { id: "llava:7b" }] });
      if (path === "/api/tags") {
        return Response.json({ models: [
          { name: "qwen3:8b", details: { context_length: 40960 }, capabilities: ["completion", "tools", "thinking"] },
          { name: "llava:7b", details: { context_length: 4096 }, capabilities: ["completion", "vision"] },
        ] });
      }
      if (path === "/api/ps") return Response.json({ models: [{ name: "qwen3:8b", context_length: 32768 }] });
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => ollama.stop(true));
  const request = await startApi(store());
  const res = await request("POST", "/models/probe", { endpoint_base_url: `http://127.0.0.1:${ollama.port}/v1` });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    models: ["qwen3:8b", "llava:7b"],
    catalog: [
      { name: "qwen3:8b", thinking_levels: [], context_window: 32768, input_image: false, tools: true },
      { name: "llava:7b", thinking_levels: [], context_window: 4096, input_image: true, tools: false },
    ],
  });
});

test("the speed test times the model, checks it calls a tool and records a share of the speed", async () => {
  const s = store();
  const provider = s.createProviderSync({ name: "Ollama", base_url: OLLAMA, models: ["qwen3:8b"] });
  const sent: CompletionRequest[] = [];
  const completions: CompletionsClient = {
    async complete(req): Promise<CompletionResult> {
      sent.push(req);
      if (req.tools.length > 0) {
        return { ok: true, content: "", toolCalls: [{ id: "c", name: "get_time", arguments: "{}" }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
      }
      req.onEvent?.({ choices: [] });
      await Bun.sleep(500);
      return { ok: true, content: "one, two", toolCalls: [], finishReason: "stop", hadChoices: true, missingReason: null,
        usage: { input_tokens: 30, output_tokens: 201, total_tokens: 231, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null } };
    },
    async judge() {
      throw new Error("unused");
    },
  };
  const request = await startApi(s, completions);
  const res = await request("POST", `/providers/${provider.id}/speed-test`, { model: "qwen3:8b" });
  if (res.status !== 200) throw new Error(await res.text());
  const speed = (await res.json()) as { tokens_per_second: number; tool_call: boolean; recorded_tps: number; failed: string | null };
  expect(speed.tool_call).toBe(true);
  expect(speed.failed).toBeNull();
  // 200 tokens over about half a second.
  expect(speed.tokens_per_second).toBeGreaterThan(250);
  expect(speed.tokens_per_second).toBeLessThan(450);
  expect(speed.recorded_tps).toBeCloseTo(speed.tokens_per_second * 0.6, 0);
  expect((await s.getProvider(provider.id)).model_catalog[0]?.stream_tps_p10).toBe(speed.recorded_tps);
  expect(sent.map((req) => [req.baseUrl, req.apiKey, req.thinkingLevel])).toEqual([[OLLAMA, "", "none"], [OLLAMA, "", "none"]]);

  const unknown = await request("POST", `/providers/${provider.id}/speed-test`, { model: "missing" });
  expect(unknown.status).toBe(422);
});
