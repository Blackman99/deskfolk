/**
 * What a Bot can change about the models (ADR 0014, 2026-10-08): a model's window, pictures and
 * output cap through update_endpoint, its speed through measure_model, and the default endpoint,
 * the reading model and the model ladder through update_model_settings.
 */
import { afterEach, expect, test } from "bun:test";
import type { ModelSpeed } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { ENGINE_LEVELS } from "./store/schema-gate";
import { call, createScenario, say, tool, type Scenario } from "./test-kit/scenario";

const stores: Store[] = [];
const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  while (scenarios.length) await scenarios.pop()!.close();
});

const OLLAMA = "http://localhost:11434/v1";

async function fixture(level: number = ENGINE_LEVELS.learning) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const cloud = await store.createProvider({ name: "Cloud", base_url: "https://api.example.com/v1", api_key: "sk", models: ["big", "small"] });
  const local = await store.createProvider({ name: "Ollama", base_url: OLLAMA, models: [{ name: "qwen3:8b", price: 1, thinking_levels: ["none", "high"], strengths: ["chat"] }] });
  const keyless = await store.createProvider({ name: "NoKey", base_url: "https://other.example.com/v1", models: ["x"] });
  const { bot, direct_session } = store.createBot({ name: "Setup", duties: "test", boundaries: "fixture" });
  const ctx: ToolCtx = { store, botId: bot.id, sessionId: direct_session.id, turnId: "fixture-turn", parentId: null };
  return { store, ctx, cloud, local, keyless };
}

/** A refused call's error text, whether it came back as `ok: false` or was thrown. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    const result = (await call) as { ok?: boolean };
    if (result.ok !== false) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected a refusal")) throw error;
    return error instanceof Error ? error.message : String(error);
  }
}

const entry = (store: Store, providerId: string, name: string) =>
  store.catalogEntries().find((row) => row.providerId === providerId && row.name === name);

test("update_endpoint sets a model's window, pictures and output cap; a bare name keeps them and resets the rest", async () => {
  const { store, ctx, local } = await fixture();
  const full = { name: "qwen3:8b", price: 1, thinking_levels: ["none", "high"], strengths: ["chat"] };
  const set = await runCollabTool(ctx, "update_endpoint", { id: local.id, models: [{ ...full, context_window: 65_536, input_image: false, max_output: 8_192 }] });
  expect(set.ok).toBe(true);
  expect(entry(store, local.id, "qwen3:8b")).toMatchObject({ ...full, context_window: 65_536, input_image: false, max_output: 8_192 });

  // The footgun the description spells out: a bare name resets prices, thinking levels and strengths.
  await runCollabTool(ctx, "update_endpoint", { id: local.id, models: ["qwen3:8b"] });
  expect(entry(store, local.id, "qwen3:8b")).toMatchObject({
    price: null, thinking_levels: ["none", "low", "medium", "high"], strengths: [], context_window: 65_536, input_image: false, max_output: 8_192,
  });

  await runCollabTool(ctx, "update_endpoint", { id: local.id, models: [{ name: "qwen3:8b", context_window: null, input_image: null }] });
  const cleared = entry(store, local.id, "qwen3:8b")!;
  expect(cleared.context_window).toBeUndefined();
  expect(cleared.input_image).toBeUndefined();
  expect(cleared.max_output).toBe(8_192);
  expect(await refusal(runCollabTool(ctx, "update_endpoint", { id: local.id, models: [{ name: "qwen3:8b", context_window: 1.5 }] }))).toContain("context_window");
});

test("list_endpoints carries the reading model and the ladder; update_model_settings changes them and the default endpoint", async () => {
  const { store, ctx, cloud, local, keyless } = await fixture();
  const listed = await runCollabTool(ctx, "list_endpoints", {});
  expect(listed.data).toMatchObject({ reader_model: null, model_ladder: [] });

  const toLocal = await runCollabTool(ctx, "update_model_settings", { default_endpoint_id: local.id });
  expect(toLocal.ok).toBe(true);
  expect(toLocal.data?.default_endpoint_id).toBe(local.id);
  expect(toLocal.emitted).toContainEqual({ kind: "settings" });
  expect((await store.settings()).default_provider_id).toBe(local.id);

  const reader = await runCollabTool(ctx, "update_model_settings", {
    reader_model: { endpoint_id: cloud.id, model: "small" },
    model_ladder: [{ endpoint_id: local.id, model: "qwen3:8b" }, { endpoint_id: cloud.id, model: "big" }],
  });
  expect(reader.data).toMatchObject({
    reader_model: { endpoint_id: cloud.id, model: "small" },
    model_ladder: [{ endpoint_id: local.id, model: "qwen3:8b" }, { endpoint_id: cloud.id, model: "big" }],
  });
  expect((await store.settings()).reader_model).toEqual({ provider_id: cloud.id, model: "small" });
  expect(store.modelLadder()).toEqual([{ provider_id: local.id, model: "qwen3:8b" }, { provider_id: cloud.id, model: "big" }]);
  expect((await runCollabTool(ctx, "list_endpoints", {})).data).toMatchObject({ reader_model: { endpoint_id: cloud.id, model: "small" } });

  await runCollabTool(ctx, "update_model_settings", { reader_model: null, model_ladder: [] });
  expect((await store.settings()).reader_model).toBeNull();
  expect(store.modelLadder()).toEqual([]);

  // Refused: an endpoint with no key, a model the endpoint does not list, nothing to change.
  expect(await refusal(runCollabTool(ctx, "update_model_settings", { default_endpoint_id: keyless.id }))).toContain("no key yet");
  expect(await refusal(runCollabTool(ctx, "update_model_settings", { reader_model: { endpoint_id: cloud.id, model: "missing" } }))).toContain("reader_model");
  expect(await refusal(runCollabTool(ctx, "update_model_settings", {}))).toContain("give default_endpoint_id");

  // One change or none: a bad ladder takes the default switch down with it.
  expect(await refusal(runCollabTool(ctx, "update_model_settings", {
    default_endpoint_id: cloud.id,
    model_ladder: [{ endpoint_id: cloud.id, model: "missing" }],
  }))).toContain("no endpoint lists missing");
  expect((await store.settings()).default_provider_id).toBe(local.id);
});

test("below engine level 7 the ladder cannot be set", async () => {
  const { ctx, local } = await fixture(ENGINE_LEVELS.jobs);
  expect(await refusal(runCollabTool(ctx, "update_model_settings", { model_ladder: [{ endpoint_id: local.id, model: "qwen3:8b" }] }))).toContain("engine level 7");
});

test("measure_model runs the engine's speed test and says when there is none", async () => {
  const { ctx, local } = await fixture();
  const asked: Array<[string, string]> = [];
  const speed: ModelSpeed = { tokens_per_second: 30, first_byte_ms: 900, tool_call: true, recorded_tps: 18, failed: null };
  const measured = await runCollabTool({ ...ctx, measure: async (providerId, model) => { asked.push([providerId, model]); return speed; } }, "measure_model", { endpoint_id: local.id, model: "qwen3:8b" });
  expect(measured.ok).toBe(true);
  expect(measured.data).toEqual(speed);
  expect(asked).toEqual([[local.id, "qwen3:8b"]]);
  expect(measured.emitted.map((item) => item.kind)).toEqual(["provider"]);

  const none = await runCollabTool(ctx, "measure_model", { endpoint_id: local.id, model: "qwen3:8b" });
  expect(none.ok).toBe(false);
});

test("a Bot's measure_model in a turn goes through the engine's completions", async () => {
  const h = await createScenario();
  scenarios.push(h);
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  const providerId = h.store.defaultProviderId()!;
  let result = "";
  let asked = false;
  h.script(alpha!, dm).handle(({ request }) => {
    const first = String(request.messages.find((m) => m.role === "user")?.content ?? "");
    // The speed test's own two requests reach the same fake endpoint.
    if (first.startsWith("Count from one")) return say("one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve");
    if (first.startsWith("What time is it?")) return call(tool("get_time"));
    if (!asked) {
      asked = true;
      return call(tool("measure_model", { endpoint_id: providerId, model: "scenario" }));
    }
    result = JSON.stringify(request.messages.at(-1));
    return say("测完了");
  });
  h.postUser(dm, "测一下模型");
  await h.waitIdle();
  expect(h.toolCalls(alpha!, "measure_model")[0]?.dispatchedAt).not.toBeNull();
  // The fake endpoint answered both test requests: it wrote, and it called the tool.
  expect(result).toContain('\\"tool_call\\":true');
  expect(result).toContain("first_byte_ms");
});

test("a Claude model that reads lines is shown to a Bot, and only the user can set it", async () => {
  const { store, ctx, cloud } = await fixture();
  store.setClaudeCodeConfigDirs(["/opt/claude-b"]);
  await store.patchSettings({ reader_model: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" } });
  expect((await runCollabTool(ctx, "list_endpoints", {})).data).toMatchObject({ reader_model: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" } });

  // A Bot spends no Claude plan of the user's: neither on an account nor the default one.
  expect(await refusal(runCollabTool(ctx, "update_model_settings", { reader_model: { runner: "claude_code", model: "haiku", config_dir: null } }))).toContain("only the user");
  expect(await refusal(runCollabTool(ctx, "update_model_settings", { reader_model: { runner: "claude_code", model: "sonnet" } }))).toContain("only the user");
  expect((await store.settings()).reader_model).toEqual({ runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" });

  // It can still take the user's choice away, for an endpoint's model or for null.
  const set = await runCollabTool(ctx, "update_model_settings", { reader_model: { endpoint_id: cloud.id, model: "small" } });
  expect(set.data).toMatchObject({ reader_model: { endpoint_id: cloud.id, model: "small" } });
  await store.patchSettings({ reader_model: { runner: "claude_code", model: "haiku", config_dir: null } });
  await runCollabTool(ctx, "update_model_settings", { reader_model: null });
  expect((await store.settings()).reader_model).toBeNull();
});
