/**
 * The organizing model (ADR 0075), as the engine resolves it for each call that keeps the board in
 * order: the model you chose when there is one, else the default one exactly as before; how hard it
 * thinks; and the pictures a judge sends only to a model that takes them.
 */
import { afterEach, expect, test } from "bun:test";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";
import { createScenario, say, type Scenario } from "../test-kit/scenario";
import { createRouting } from "./routing";
import { createOrganizerTarget } from "./organizer-target";

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
  const targetFor = createOrganizerTarget({ store, credentials: routing.credentials, routingTarget: routing.routingTarget });
  return { store, base, strong, routing, targetFor };
}

test("with no organizing model every call runs on the default endpoint's default model, thinking as the endpoint likes", async () => {
  const { base, targetFor } = await setup();
  for (const purpose of ["organizer", "scribe", "vision"] as const) {
    expect(await targetFor(purpose)).toEqual({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k-default",
      apiFormat: "openai",
      workspaceId: null,
      providerId: base.id,
      providerName: "Default",
      model: "plain-default",
      thinkingLevel: null,
    });
  }
});

test("the chosen model organizes on its own endpoint: high for the organizer and the judges, a little for the scribe", async () => {
  const { store, strong, targetFor } = await setup();
  await store.patchSettings({ organizer_model: { provider_id: strong.id, model: "sees" } });
  const on = { baseUrl: "https://strong.example/v1", apiKey: "k-strong", apiFormat: "anthropic" as const, workspaceId: null, providerId: strong.id, providerName: "Strong", model: "sees" };
  expect(await targetFor("organizer")).toEqual({ ...on, thinkingLevel: "high" });
  expect(await targetFor("vision")).toEqual({ ...on, thinkingLevel: "high" });
  expect(await targetFor("scribe")).toEqual({ ...on, thinkingLevel: "low" });
});

test("a judge about to send pictures runs on the chosen model only when it is marked as taking them", async () => {
  const { store, base, strong, targetFor } = await setup();
  for (const model of ["blind", "unsure"]) {
    await store.patchSettings({ organizer_model: { provider_id: strong.id, model } });
    // The organizer and the scribe read words and keep the choice; the judge of frames stays on the default.
    expect((await targetFor("organizer"))?.model).toBe(model);
    expect((await targetFor("scribe"))?.model).toBe(model);
    expect(await targetFor("vision")).toMatchObject({ providerId: base.id, model: "plain-default", thinkingLevel: null });
  }
});

test("it thinks as hard as the model lists, no further than high while high is there", async () => {
  const { store, strong } = await setup();
  const levels = (model: string) => [store.strongThinkingLevelFor(model, strong.id), store.scribeThinkingLevelFor(model, strong.id)];
  // xhigh and max are listed, and are left alone: the answer shares its cap with the thinking.
  expect(levels("sees")).toEqual(["high", "low"]);
  // Listing only levels above high: the nearest one; the scribe's lightest above none.
  expect(levels("above-high")).toEqual(["xhigh", "xhigh"]);
  // No high, no low: the highest below high, and the lightest above none.
  expect(levels("lean")).toEqual(["medium", "medium"]);
  expect(levels("off-only")).toEqual(["none", "none"]);
  // A model no endpoint lists names no level, so none is sent.
  expect(levels("nobody")).toEqual([null, null]);
});

test("once the endpoint stops listing the model, or is gone, the default model organizes again", async () => {
  const { store, base, strong, targetFor } = await setup();
  await store.patchSettings({ organizer_model: { provider_id: strong.id, model: "sees" } });
  expect((await targetFor("organizer"))?.model).toBe("sees");
  await store.patchProvider(strong.id, { models: [{ name: "blind", thinking_levels: ALL }] });
  expect(await targetFor("organizer")).toMatchObject({ providerId: base.id, model: "plain-default", thinkingLevel: null });
  // Listed again: it is the choice again.
  await store.patchProvider(strong.id, { models: [{ name: "sees", thinking_levels: ALL, input_image: true }] });
  expect((await targetFor("organizer"))?.model).toBe("sees");
  await store.deleteProvider(strong.id);
  expect(await targetFor("organizer")).toMatchObject({ providerId: base.id, model: "plain-default", thinkingLevel: null });
});

test("a chosen endpoint that has lost its key is not used, and with no endpoint at all there is no target", async () => {
  const { store, base, strong, targetFor } = await setup();
  await store.patchSettings({ organizer_model: { provider_id: strong.id, model: "sees" } });
  await store.patchProvider(strong.id, { api_key: "" });
  expect(await targetFor("organizer")).toMatchObject({ providerId: base.id, model: "plain-default" });
  await store.deleteProvider(strong.id);
  await store.deleteProvider(base.id);
  expect(await targetFor("organizer")).toBeNull();
});

test("in the engine, the organizer and the scribe run on the chosen model and tell it how hard to think; unset, on the default one as before", async () => {
  for (const choose of [true, false]) {
    const h = await createScenario();
    scenarios.push(h);
    if (choose) {
      const strong = await h.store.createProvider({ name: "Strong", base_url: "http://127.0.0.1:2/v1", api_key: "strong", models: [{ name: "strong-model", thinking_levels: ALL }] });
      await h.store.patchSettings({ organizer_model: { provider_id: strong.id, model: "strong-model" } });
    }
    const seen: Array<{ kind: string; model: string; baseUrl: string; thinkingLevel: string | undefined }> = [];
    const note = (kind: string, request: { model: string; baseUrl: string; thinkingLevel?: string }) =>
      void seen.push({ kind, model: request.model, baseUrl: request.baseUrl, thinkingLevel: request.thinkingLevel });
    h.judge("organizer").handle(({ request }) => {
      note("organizer", request);
      return { decision: "new", plan: { goal: "做一部短片" }, tickets: [], message_ticket: null };
    });
    h.judge("scribe").handle(({ request }) => {
      note("scribe", request);
      return { adds: [] };
    });
    const [director] = h.createBots({ name: "视频导演" });
    const direct = h.direct(director!);
    h.script(director!, direct).reply(say("好的，我先写分镜"));
    h.postUser(direct, "做一部短片，片长约 2 分钟");
    await h.waitIdle();
    const mine = (kind: string) => seen.filter((row) => row.kind === kind);
    expect(mine("organizer").length).toBeGreaterThan(0);
    expect(mine("scribe").length).toBeGreaterThan(0);
    for (const row of mine("organizer")) {
      expect(row).toEqual(choose
        ? { kind: "organizer", model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "high" }
        : { kind: "organizer", model: "scenario", baseUrl: "http://127.0.0.1:1/v1", thinkingLevel: undefined });
    }
    for (const row of mine("scribe")) {
      expect(row).toEqual(choose
        ? { kind: "scribe", model: "strong-model", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "low" }
        : { kind: "scribe", model: "scenario", baseUrl: "http://127.0.0.1:1/v1", thinkingLevel: undefined });
    }
  }
});
