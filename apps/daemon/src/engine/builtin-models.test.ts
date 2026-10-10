/**
 * The built-in calls' models (ADR 0077, from the organizing model of ADR 0075): each call runs on the
 * model chosen for it when there is one — an endpoint's, or a Claude model of yours run through your
 * Claude Code — else exactly as before; how hard it thinks; pictures only to a model that takes
 * them; what a Claude model's call is sent and billed as.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { BUILTIN_MODEL_ROLES, type BuiltinModelRole } from "@real-bot/protocol";
import type { ClaudeJudge } from "../claude-code/reading";
import type { CompletionsClient, JudgeRequest } from "../completions";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";
import { migrateBuiltinModels } from "../store/builtin-models-migration";
import { createScenario, say, type Scenario } from "../test-kit/scenario";
import { claudePromptOf, createBuiltinTargets, recordSideSpend, sideJudge, spentOf } from "./builtin-models";
import { createRouting } from "./routing";
import { createSpend } from "./spend";

const stores: Store[] = [];
const scenarios: Scenario[] = [];
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (scenarios.length) await scenarios.pop()!.close();
});

const ALL = ["none", "low", "medium", "high"];

async function setup() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  stores.push(store);
  const base = await store.createProvider({ name: "Default", base_url: "http://127.0.0.1:1/v1", api_key: "k-default", models: [{ name: "plain-default", thinking_levels: ALL }] });
  const strong = await store.createProvider({
    name: "Strong",
    base_url: "https://strong.example/v1",
    api_key: "k-strong",
    api_format: "anthropic",
    models: [
      { name: "sees", thinking_levels: [...ALL, "xhigh", "max"], input_image: true },
      { name: "blind", thinking_levels: ALL, input_image: false },
      { name: "unsure", thinking_levels: ALL },
      { name: "above-high", thinking_levels: ["xhigh", "max"], input_image: true },
      { name: "lean", thinking_levels: ["none", "medium"], input_image: true },
      { name: "off-only", thinking_levels: ["none"], input_image: true },
    ],
  });
  await store.patchSettings({ default_provider_id: base.id });
  const routing = createRouting({ store, completions: {} as never, recordResponseSpend: (() => null) as never, spendOwner: (() => ({})) as never });
  const targetOf = createBuiltinTargets({ store, credentials: routing.credentials });
  return { store, base, strong, routing, targetOf };
}

test("with nothing chosen every built-in call is left to its own default", async () => {
  const { store, targetOf } = await setup();
  for (const role of BUILTIN_MODEL_ROLES) expect(await targetOf(role)).toBeNull();
  expect(store.settingsCached().builtin_models).toEqual(Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, null])) as never);
});

test("a chosen endpoint model runs its call on its own endpoint, thinking as much as the call wants", async () => {
  const { store, strong, targetOf } = await setup();
  const sees = { provider_id: strong.id, model: "sees" };
  await store.patchSettings({ builtin_models: Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, sees])) });
  const on = { baseUrl: "https://strong.example/v1", apiKey: "k-strong", apiFormat: "anthropic" as const, workspaceId: null, providerId: strong.id, providerName: "Strong", model: "sees" };
  const levels: Record<BuiltinModelRole, string> = {
    reader: "none", composer: "none", judgement: "none",
    scribe: "low", compaction: "low",
    organizer: "high", judge: "high", reflection: "high", retrospective: "high",
  };
  for (const role of BUILTIN_MODEL_ROLES) expect(await targetOf(role)).toEqual({ ...on, thinkingLevel: levels[role] });
  // The older windows' fields read the same choice.
  expect(store.settingsCached().reader_model).toEqual(sees);
  expect(store.settingsCached().organizer_model).toEqual(sees);
});

test("a Claude model of yours runs through Claude Code on the account chosen, told an effort only where the call wants one", async () => {
  const { store, targetOf } = await setup();
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('claude_code_config_dirs', ?)", [JSON.stringify(["/opt/claude-b"])]);
  const opus = { runner: "claude_code" as const, model: "opus", config_dir: "/opt/claude-b" };
  await store.patchSettings({ builtin_models: { organizer: opus, scribe: opus, reader: { ...opus, model: "haiku" }, judge: opus } });
  expect(await targetOf("organizer")).toEqual({ kind: "claude_code", model: "opus", configDir: "/opt/claude-b", effort: "high" });
  expect(await targetOf("judge", { pictures: true })).toEqual({ kind: "claude_code", model: "opus", configDir: "/opt/claude-b", effort: "high" });
  expect(await targetOf("scribe")).toEqual({ kind: "claude_code", model: "opus", configDir: "/opt/claude-b", effort: "low" });
  // A reading is left to Claude Code's own effort, as it always was.
  expect(await targetOf("reader")).toEqual({ kind: "claude_code", model: "haiku", configDir: "/opt/claude-b" });
  // An older window cannot show a Claude organizer, so it reads none there.
  expect(store.settingsCached().organizer_model).toBeNull();
  expect(store.settingsCached().builtin_models?.organizer).toEqual(opus);
});

test("a judge about to send pictures runs on a chosen endpoint model only when it is marked as taking them", async () => {
  const { store, strong, targetOf } = await setup();
  for (const model of ["blind", "unsure"]) {
    await store.patchSettings({ builtin_models: { judge: { provider_id: strong.id, model } } });
    // Words keep the choice; frames go to the default.
    expect((await targetOf("judge"))?.model).toBe(model);
    expect(await targetOf("judge", { pictures: true })).toBeNull();
  }
  await store.patchSettings({ builtin_models: { judge: { provider_id: strong.id, model: "sees" } } });
  expect((await targetOf("judge", { pictures: true }))?.model).toBe("sees");
});

test("once the endpoint stops listing the model, loses its key or is gone, the call is back on its default", async () => {
  const { store, strong, targetOf } = await setup();
  await store.patchSettings({ builtin_models: { composer: { provider_id: strong.id, model: "sees" } } });
  expect((await targetOf("composer"))?.model).toBe("sees");
  await store.patchProvider(strong.id, { models: [{ name: "blind", thinking_levels: ALL }] });
  expect(await targetOf("composer")).toBeNull();
  expect(store.settingsCached().builtin_models?.composer).toBeNull();
  await store.patchProvider(strong.id, { models: [{ name: "sees", thinking_levels: ALL, input_image: true }] });
  expect((await targetOf("composer"))?.model).toBe("sees");
  await store.patchProvider(strong.id, { api_key: "" });
  expect(await targetOf("composer")).toBeNull();
  await store.deleteProvider(strong.id);
  expect(await targetOf("composer")).toBeNull();
});

test("a patch is checked whole: an unknown call, an unlisted model or an unknown account changes nothing", async () => {
  const { store, strong } = await setup();
  await store.patchSettings({ builtin_models: { scribe: { provider_id: strong.id, model: "sees" } } });
  await expect(store.patchSettings({ builtin_models: { organizer: { provider_id: strong.id, model: "sees" }, route_pick: null } as never })).rejects.toThrow("unknown built-in call: route_pick");
  await expect(store.patchSettings({ builtin_models: { organizer: { provider_id: strong.id, model: "nope" } } })).rejects.toThrow("builtin_models.organizer must be a model that endpoint lists");
  await expect(store.patchSettings({ builtin_models: { organizer: { runner: "claude_code", model: "opus", config_dir: "/nowhere" } } })).rejects.toThrow();
  await expect(store.patchSettings({ builtin_models: { organizer: { runner: "claude_code", model: "not a model", config_dir: null } } })).rejects.toThrow("Claude model name");
  await expect(store.patchSettings({ builtin_models: [] as never })).rejects.toThrow("builtin_models must be an object");
  expect(store.settingsCached().builtin_models?.organizer).toBeNull();
  expect(store.settingsCached().builtin_models?.scribe).toEqual({ provider_id: strong.id, model: "sees" });
  // Null runs a call as before again, and leaves the others alone.
  await store.patchSettings({ builtin_models: { scribe: null } });
  expect(store.settingsCached().builtin_models?.scribe).toBeNull();
});

test("an older window's reader_model and organizer_model set the reader and the organizer alone", async () => {
  const { store, strong } = await setup();
  await store.patchSettings({ organizer_model: { provider_id: strong.id, model: "sees" }, reader_model: { provider_id: strong.id, model: "lean" } });
  const chosen = store.settingsCached().builtin_models!;
  expect(chosen.organizer).toEqual({ provider_id: strong.id, model: "sees" });
  expect(chosen.reader).toEqual({ provider_id: strong.id, model: "lean" });
  expect(chosen.scribe).toBeNull();
  expect(chosen.judge).toBeNull();
  // The keys the reader and the organizer always had.
  const keys = store.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings WHERE key LIKE 'organizer_%' OR key LIKE 'reader_%' ORDER BY key").all();
  expect(keys).toContainEqual({ key: "organizer_model", value: "sees" });
  expect(keys).toContainEqual({ key: "reader_model", value: "lean" });
});

test("once, the organizing model chosen before goes on running the scribe and the picture checks", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO settings VALUES ('organizer_provider_id', 'p1'), ('organizer_model', 'opus')");
  migrateBuiltinModels(db);
  const read = () => Object.fromEntries(db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  expect(read()).toMatchObject({ scribe_provider_id: "p1", scribe_model: "opus", judge_provider_id: "p1", judge_model: "opus", builtin_models_split: "1" });
  // Only once: what you change later is not copied over again.
  db.run("UPDATE settings SET value = '' WHERE key IN ('scribe_model', 'scribe_provider_id')");
  db.run("UPDATE settings SET value = 'sonnet' WHERE key = 'organizer_model'");
  migrateBuiltinModels(db);
  expect(read()).toMatchObject({ scribe_model: "", judge_model: "opus" });
  // Nothing chosen before: nothing to copy.
  const fresh = new Database(":memory:");
  fresh.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrateBuiltinModels(fresh);
  expect(fresh.query("SELECT key FROM settings").all()).toEqual([{ key: "builtin_models_split" }]);
});

test("a Claude model is sent the system prompt alone and the rest as text, or as image blocks once there are pictures", () => {
  expect(claudePromptOf([{ role: "system", content: "SYS" }, { role: "user", content: '{"a":1}' }])).toEqual({ system: "SYS", prompt: '{"a":1}' });
  expect(claudePromptOf([
    { role: "system", content: "对照样片" },
    { role: "user", content: [{ type: "text", text: "样片:" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "这次的交付" }] },
  ])).toEqual({
    system: "对照样片",
    prompt: [
      { type: "text", text: "样片:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "这次的交付" },
    ],
  });
});

const CLAUDE_USAGE = { inputTokens: 1200, outputTokens: 300, cachedTokens: 1000, costUsd: 0.02 };

test("a Claude model's call answers as an endpoint's would, bounded by the caller's limit and its own room, and says why it failed", async () => {
  const unused = { judge: () => Promise.reject(new Error("no endpoint here")) } as unknown as CompletionsClient;
  const asked: Array<Parameters<ClaudeJudge>[0]> = [];
  const target = { kind: "claude_code" as const, model: "opus", configDir: null, effort: "high" as const };
  const request = { messages: [{ role: "system" as const, content: "SYS" }, { role: "user" as const, content: "PAYLOAD" }], signal: new AbortController().signal, timeoutMs: 60_000, maxTokens: 999 };
  const ok = await sideJudge({ completions: unused, claudeJudge: async (input) => {
    asked.push(input);
    return { content: '{"ok":true}', usage: CLAUDE_USAGE, fail: null };
  } }, target, request);
  expect(asked.map(({ target: t, system, prompt }) => ({ t, system, prompt }))).toEqual([{ t: target, system: "SYS", prompt: "PAYLOAD" }]);
  expect(ok).toEqual({ content: '{"ok":true}', toolCalls: [], hadToolCalls: false, usage: null, failKind: null, claudeUsage: CLAUDE_USAGE });

  const signedOut = await sideJudge({ completions: unused, claudeJudge: async () => ({ content: null, usage: null, fail: "claude_unavailable" }) }, target, request);
  expect(signedOut.failKind).toBe("agent_missing");
  const errored = await sideJudge({ completions: unused, claudeJudge: async () => ({ content: null, usage: CLAUDE_USAGE, fail: "claude_failed" }) }, target, request);
  expect([errored.failKind, errored.claudeUsage]).toEqual(["agent_exited", CLAUDE_USAGE]);
  expect((await sideJudge({ completions: unused }, target, request)).failKind).toBe("agent_missing");

  // The caller giving up gives the call up too.
  const caller = new AbortController();
  const pending = sideJudge({ completions: unused, claudeJudge: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ content: null, usage: null, fail: "claude_failed" }), { once: true });
  }) }, target, { ...request, signal: caller.signal });
  caller.abort();
  expect((await pending).failKind).toBe("agent_exited");
});

test("an endpoint model's call goes to its endpoint with its thinking level; the default model's names none", async () => {
  const sent: JudgeRequest[] = [];
  const completions = { judge: async (request: JudgeRequest) => {
    sent.push(request);
    return { content: "x", toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
  } } as unknown as CompletionsClient;
  const on = { baseUrl: "https://strong.example/v1", apiKey: "k", apiFormat: "anthropic" as const, workspaceId: null, providerId: "p", providerName: "P", model: "sees" };
  const request = { messages: [{ role: "user" as const, content: "hi" }], signal: new AbortController().signal, maxTokens: 10 };
  await sideJudge({ completions }, { ...on, thinkingLevel: "high" }, request);
  await sideJudge({ completions }, { ...on, thinkingLevel: null }, request);
  expect(sent[0]).toMatchObject({ baseUrl: "https://strong.example/v1", apiKey: "k", apiFormat: "anthropic", model: "sees", thinkingLevel: "high", maxTokens: 10 });
  expect("thinkingLevel" in sent[1]!).toBe(false);
});

test("a Claude model's call is billed at Claude Code's estimate, to the turn or judgement it belongs to", async () => {
  const { store } = await setup();
  const spend = createSpend({ store, publishSpend: () => {} });
  const owner = { sessionId: "s1", sessionName: null, botId: "b1", botName: "Writer" };
  const target = { kind: "claude_code" as const, model: "sonnet", configDir: null };
  const answer = { content: "x", toolCalls: [], hadToolCalls: false, usage: null, failKind: null, claudeUsage: CLAUDE_USAGE };
  recordSideSpend(spend, { kind: "turn", purpose: "compact", owner, turnId: "t1", target, ...spentOf(answer) });
  recordSideSpend(spend, { kind: "judgement", owner, judgementId: "j1", target, ...spentOf(answer) });
  // Nothing reported, nothing billed.
  expect(recordSideSpend(spend, { kind: "organize", owner, target, ...spentOf({ ...answer, claudeUsage: null }) })).toBeNull();
  const rows = store.db.query<Record<string, unknown>, []>("SELECT kind, purpose, turn_id, judgement_id, provider_name, model, input_tokens, output_tokens, estimated_cost_usd_ticks FROM spend ORDER BY kind DESC").all();
  expect(rows).toEqual([
    { kind: "turn", purpose: "compact", turn_id: "t1", judgement_id: null, provider_name: "Claude Agent", model: "sonnet", input_tokens: 1200, output_tokens: 300, estimated_cost_usd_ticks: 200_000_000 },
    { kind: "judgement", purpose: null, turn_id: null, judgement_id: "j1", provider_name: "Claude Agent", model: "sonnet", input_tokens: 1200, output_tokens: 300, estimated_cost_usd_ticks: 200_000_000 },
  ]);
});

/** A second endpoint in a scenario, chosen for the calls named. */
async function chooseStrong(h: Scenario, roles: BuiltinModelRole[]): Promise<void> {
  const strong = await h.store.createProvider({ name: "Strong", base_url: "http://127.0.0.1:2/v1", api_key: "strong", models: [{ name: "strong-model", thinking_levels: ALL }] });
  await h.store.patchSettings({ builtin_models: Object.fromEntries(roles.map((role) => [role, { provider_id: strong.id, model: "strong-model" }])) });
}

type Seen = { model: string; baseUrl: string; thinkingLevel: string | undefined };
const seenOf = (request: { model: string; baseUrl: string; thinkingLevel?: string }): Seen =>
  ({ model: request.model, baseUrl: request.baseUrl, thinkingLevel: request.thinkingLevel });
const DEFAULT_RAN: Seen = { model: "scenario", baseUrl: "http://127.0.0.1:1/v1", thinkingLevel: undefined };

test("in the engine, the organizer and the scribe run on their chosen models and are told how hard to think; unset, on the default as before", async () => {
  for (const choose of [true, false]) {
    const h = await createScenario();
    scenarios.push(h);
    if (choose) await chooseStrong(h, ["organizer", "scribe"]);
    const seen: Record<string, Seen[]> = { organizer: [], scribe: [] };
    h.judge("organizer").handle(({ request }) => {
      seen.organizer!.push(seenOf(request));
      return { decision: "new", plan: { goal: "做一部短片" }, tickets: [], message_ticket: null };
    });
    h.judge("scribe").handle(({ request }) => {
      seen.scribe!.push(seenOf(request));
      return { adds: [] };
    });
    const [director] = h.createBots({ name: "视频导演" });
    const direct = h.direct(director!);
    h.script(director!, direct).reply(say("好的，我先写分镜"));
    h.postUser(direct, "做一部短片，片长约 2 分钟");
    await h.waitIdle();
    expect(seen.organizer!.length).toBeGreaterThan(0);
    expect(seen.scribe!.length).toBeGreaterThan(0);
    const strong = (thinkingLevel: string) => ({ model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel });
    for (const row of seen.organizer!) expect(row).toEqual(choose ? strong("high") : DEFAULT_RAN);
    for (const row of seen.scribe!) expect(row).toEqual(choose ? strong("low") : DEFAULT_RAN);
  }
});

test("in the engine, the composer's suggestions run on the model chosen for them, else on the default endpoint's light model", async () => {
  for (const choose of [true, false]) {
    const h = await createScenario();
    scenarios.push(h);
    if (choose) await chooseStrong(h, ["composer"]);
    const seen: Seen[] = [];
    h.judge("composer").handle(({ request }) => {
      seen.push(seenOf(request));
      return '["好的"]';
    });
    const [writer, reviewer] = h.createBots("Writer", "Reviewer");
    const group = h.group("Brief", [writer!, reviewer!]);
    await h.engine.suggestComposer(group);
    expect(seen).toEqual([choose ? { model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "none" } : DEFAULT_RAN]);
    expect(h.store.db.query("SELECT kind, model FROM spend WHERE kind = 'composer_suggest'").all())
      .toEqual([{ kind: "composer_suggest", model: choose ? "strong-model" : "scenario" }]);
  }
});

test("in the engine, a compaction summary runs on the model chosen for it and is billed to the turn", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { call, failed, tool } = await import("../test-kit/scenario");
  const h = await createScenario();
  scenarios.push(h);
  await chooseStrong(h, ["compaction"]);
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  for (let i = 1; i <= 12; i++) writeFileSync(join(h.root, `note-${i}.md`), `NOTE-${i}-${"x".repeat(6_800)}`);
  const seen: Seen[] = [];
  h.script(alpha!, dm).reply(...Array.from({ length: 12 }, (_, i) => call(tool("read_file", { path: `note-${i + 1}.md` }))), failed("context_full"), say("都看完了。"));
  h.judge("compact").reply(({ request }) => {
    seen.push(seenOf(request));
    return "- 读完了十二份笔记。";
  });
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();
  expect(seen).toEqual([{ model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "low" }]);
  const turn = h.turns(alpha!)[0]!;
  expect(h.store.db.query("SELECT kind, purpose, turn_id, model FROM spend WHERE purpose = 'compact'").all())
    .toEqual([{ kind: "turn", purpose: "compact", turn_id: turn.id, model: "strong-model" }]);
});

test("in the engine, a Bot's reflection runs on the model chosen for reflections, else on the Bot's own", async () => {
  const { isoNow } = await import("../ids");
  for (const choose of [true, false]) {
    const h = await createScenario({ learning: true });
    scenarios.push(h);
    if (choose) await chooseStrong(h, ["reflection"]);
    const [director, reviewer] = h.createBots("视频导演", "审片员");
    const room = h.group("Studio", [director!, reviewer!]);
    const plan = h.store.openTask({ sessionId: room, title: "EP01" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "第七镜", worker: director!.id });
    h.store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer!.id, taskId: plan.id, ticketId: ticket.id,
      payload: { reviewer_bot_id: reviewer!.id, reviewer_model: "scenario", message_id: null, card_id: "card-1" } });
    const seen: Seen[] = [];
    h.judge("reflect").reply(({ request }) => {
      seen.push(seenOf(request));
      return JSON.stringify({ kind: "none", reason: "nothing to learn" });
    });
    h.tick(new Date(isoNow()));
    await h.waitIdle();
    expect(seen).toEqual([choose ? { model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "high" } : DEFAULT_RAN]);
    expect(h.store.db.query("SELECT purpose, model, bot_id FROM spend WHERE purpose = 'reflect'").all())
      .toEqual([{ purpose: "reflect", model: choose ? "strong-model" : "scenario", bot_id: reviewer!.id }]);
  }
});

test("in the engine, a Bot's judgement of a line runs on the model chosen for judgements, else on the Bot's own", async () => {
  for (const choose of [true, false]) {
    const h = await createScenario();
    scenarios.push(h);
    if (choose) await chooseStrong(h, ["judgement"]);
    const [alpha, beta] = h.createBots("Alpha", "Beta");
    const group = h.group("Studio", [alpha!, beta!]);
    const seen: Seen[] = [];
    h.judge("judgement").handle(({ request }) => {
      seen.push(seenOf(request));
      return "pass";
    });
    h.postUser(group, "今天天气怎么样");
    await h.waitIdle();
    expect(seen.length).toBeGreaterThan(0);
    for (const row of seen) expect(row).toEqual(choose ? { model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "none" } : DEFAULT_RAN);
    const billed = h.store.db.query<{ model: string; judgement_id: string | null }, []>("SELECT model, judgement_id FROM spend WHERE kind = 'judgement'").all();
    expect(billed.length).toBe(seen.length);
    for (const row of billed) expect(row).toMatchObject({ model: choose ? "strong-model" : "scenario", judgement_id: expect.any(String) });
  }
});
