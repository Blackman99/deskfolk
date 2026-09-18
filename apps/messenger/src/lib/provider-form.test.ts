import { expect, test } from "bun:test";
import {
  addAttrStrength,
  addDraftModel,
  applyProbedModels,
  draftFromProvider,
  emptyModelAttr,
  emptyProviderDraft,
  hasCustomAttrs,
  mapProviderError,
  modelSelectValue,
  parseModelSelectValue,
  pickerModels,
  planCreateProvider,
  planPatchProvider,
  probeSignature,
  providerHost,
  setDraftModels,
  toggleAttrStrength,
  toggleAttrThinkingLevel,
  toggleDraftModel,
  withSyncedDefaultModel,
  type ProviderDraft,
} from "./provider-form.ts";

const ALL_LEVELS = ["none", "low", "medium", "high"] as const;

function draft(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4o"],
    availableModels: [],
    defaultModel: "gpt-4o",
    modelAttrs: {},
    ...overrides,
  };
}

test("create provider requires name, http URL, key, models, and a listed default", () => {
  expect(planCreateProvider({ ...emptyProviderDraft(), name: " " }, true)).toEqual({
    ok: false,
    errors: {
      name: "empty",
      endpoint: "empty",
      endpointKey: "empty",
      models: "empty",
      defaultModel: "empty",
    },
  });
});

test("create provider trims fields, dedupes names, sends the key and the probed list", () => {
  expect(
    planCreateProvider(
      draft({
        name: " OpenAI ",
        baseUrl: " https://api.openai.com/v1 ",
        apiKey: "sk-secret",
        models: [" gpt-4o ", "", "gpt-4o-mini", "gpt-4o"],
        availableModels: ["gpt-4o", "gpt-4o-mini", "o3"],
        defaultModel: " gpt-4o ",
      }),
      true,
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-secret",
      models: [
        { name: "gpt-4o", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] },
        { name: "gpt-4o-mini", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] },
      ],
      available_models: ["gpt-4o", "gpt-4o-mini", "o3"],
      default_model: "gpt-4o",
    },
  });
});

test("create provider leaves available_models out when nothing was probed", () => {
  const plan = planCreateProvider(draft({ apiKey: "sk" }), true);
  expect(plan.ok).toBe(true);
  if (plan.ok) expect("available_models" in plan.body).toBe(false);
});

test("patch omits unchanged fields and a blank key", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    available_models: ["gpt-4o", "o3"],
    default_model: "gpt-4o",
  };
  expect(planPatchProvider(current, draftFromProvider(current))).toEqual({ ok: true, patch: {} });
  expect(
    planPatchProvider(
      current,
      draft({
        name: "CPA",
        apiKey: "sk-new",
        models: ["gpt-4o", "gpt-4o-mini"],
        availableModels: ["gpt-4o", "o3"],
        defaultModel: "gpt-4o-mini",
      }),
    ),
  ).toEqual({
    ok: true,
    patch: {
      name: "CPA",
      api_key: "sk-new",
      models: [
        { name: "gpt-4o", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] },
        { name: "gpt-4o-mini", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] },
      ],
      default_model: "gpt-4o-mini",
    },
  });
});

test("patch sends the probed list only when it changed", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    available_models: [],
    default_model: "gpt-4o",
  };
  expect(planPatchProvider(current, draft({ availableModels: ["gpt-4o", "o3"] }))).toEqual({
    ok: true,
    patch: { available_models: ["gpt-4o", "o3"] },
  });
});

test("model select values encode the provider", () => {
  expect(modelSelectValue("p1", "gpt-4o")).toBe("p1::gpt-4o");
  expect(parseModelSelectValue("p1::gpt-4o")).toEqual({ provider_id: "p1", model: "gpt-4o" });
  expect(parseModelSelectValue("gpt-4o")).toEqual({ provider_id: null, model: "gpt-4o" });
});

test("syncs default model onto the enabled names and prunes stray attributes", () => {
  expect(
    withSyncedDefaultModel(draft({ models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gone" })).defaultModel,
  ).toBe("gpt-4o");
  expect(withSyncedDefaultModel(draft()).defaultModel).toBe("gpt-4o");
  expect(withSyncedDefaultModel(draft({ models: [], defaultModel: "gpt-4o" })).defaultModel).toBe("");
  const synced = withSyncedDefaultModel(
    draft({ models: ["gpt-4o"], modelAttrs: { gone: emptyModelAttr(), "gpt-4o": { ...emptyModelAttr(), price: "2" } } }),
  );
  expect(Object.keys(synced.modelAttrs)).toEqual(["gpt-4o"]);
  expect(synced.modelAttrs["gpt-4o"]?.price).toBe("2");
});

test("probed models are recorded and enabled names are left alone", () => {
  const next = applyProbedModels(draft({ models: ["gpt-4o", "old"] }), ["gpt-4o", " gpt-4o-mini ", "o1", "o3", "o1"]);
  expect(next.availableModels).toEqual(["gpt-4o", "gpt-4o-mini", "o1", "o3"]);
  expect(next.models).toEqual(["gpt-4o", "old"]);
  expect(next.defaultModel).toBe("gpt-4o");
  expect(pickerModels(next)).toEqual(["gpt-4o", "gpt-4o-mini", "o1", "o3", "old"]);
});

test("a short probed list is enabled wholesale when nothing was picked; a long one waits", () => {
  const short = applyProbedModels(draft({ models: [], defaultModel: "" }), ["llama3", "qwen2.5"]);
  expect(short.models).toEqual(["llama3", "qwen2.5"]);
  expect(short.defaultModel).toBe("llama3");
  const long = applyProbedModels(draft({ models: [], defaultModel: "" }), ["a", "b", "c", "d"]);
  expect(long.models).toEqual([]);
  expect(long.defaultModel).toBe("");
});

test("toggling, bulk-setting, and hand-adding names keep the default in range", () => {
  let next = toggleDraftModel(draft({ availableModels: ["gpt-4o", "o3"] }), "o3");
  expect(next.models).toEqual(["gpt-4o", "o3"]);
  next = toggleDraftModel(next, "gpt-4o");
  expect(next.models).toEqual(["o3"]);
  expect(next.defaultModel).toBe("o3");
  next = setDraftModels(next, []);
  expect(next.models).toEqual([]);
  expect(next.defaultModel).toBe("");
  next = addDraftModel(next, "  my-finetune ");
  expect(next.models).toEqual(["my-finetune"]);
  expect(next.defaultModel).toBe("my-finetune");
  expect(addDraftModel(next, "my-finetune")).toBe(next);
  expect(addDraftModel(next, "   ")).toBe(next);
  expect(pickerModels(next)).toEqual(["gpt-4o", "o3", "my-finetune"]);
});

test("probe signature needs an http URL and a key, typed or already stored", () => {
  expect(probeSignature(draft({ baseUrl: "api.openai.com" , apiKey: "sk" }), false)).toBeNull();
  expect(probeSignature(draft({ apiKey: "" }), false)).toBeNull();
  expect(probeSignature(draft({ apiKey: "" }), true)).toBe("https://api.openai.com/v1\n");
  expect(probeSignature(draft({ baseUrl: " https://api.openai.com/v1 ", apiKey: " sk " }), false)).toBe(
    "https://api.openai.com/v1\nsk",
  );
});

test("thinking levels toggle in canonical order and never empty out", () => {
  let attr = emptyModelAttr();
  attr = toggleAttrThinkingLevel(attr, "none");
  attr = toggleAttrThinkingLevel(attr, "medium");
  expect(attr.thinkingLevels).toEqual(["low", "high"]);
  attr = toggleAttrThinkingLevel(attr, "none");
  expect(attr.thinkingLevels).toEqual(["none", "low", "high"]);
  attr = toggleAttrThinkingLevel(toggleAttrThinkingLevel(attr, "low"), "high");
  expect(attr.thinkingLevels).toEqual(["none"]);
  expect(toggleAttrThinkingLevel(attr, "none")).toBe(attr);
});

test("strength tags toggle and add case-insensitively", () => {
  let attr = toggleAttrStrength(emptyModelAttr(), "code");
  expect(attr.strengths).toEqual(["code"]);
  attr = addAttrStrength(attr, " Vision ");
  expect(attr.strengths).toEqual(["code", "Vision"]);
  expect(addAttrStrength(attr, "vision")).toBe(attr);
  expect(addAttrStrength(attr, "")).toBe(attr);
  attr = toggleAttrStrength(attr, "CODE");
  expect(attr.strengths).toEqual(["Vision"]);
  expect(hasCustomAttrs(attr)).toBe(true);
  expect(hasCustomAttrs(emptyModelAttr())).toBe(false);
  expect(hasCustomAttrs({ ...emptyModelAttr(), price: "1" })).toBe(true);
  expect(hasCustomAttrs({ ...emptyModelAttr(), thinkingLevels: ["low"] })).toBe(true);
});

test("provider host is the URL host, or the raw string if unparsable", () => {
  expect(providerHost("https://api.openai.com/v1")).toBe("api.openai.com");
  expect(providerHost("not a url")).toBe("not a url");
  expect(providerHost("")).toBe("");
});

test("create provider sends price, thinking levels, and strengths", () => {
  expect(
    planCreateProvider(
      draft({
        apiKey: "sk-secret",
        modelAttrs: {
          "gpt-4o": { price: "3", thinkingLevels: ["high", "low"], strengths: ["code", "Code", "writing"] },
        },
      }),
      true,
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-secret",
      models: [{ name: "gpt-4o", price: 3, thinking_levels: ["low", "high"], strengths: ["code", "writing"] }],
      default_model: "gpt-4o",
    },
  });
});

test("draft from provider carries the catalog and the probed list", () => {
  const made = draftFromProvider({
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    model_catalog: [{ name: "gpt-4o", price: 1.5, thinking_levels: ["low"], strengths: ["code"] }],
    available_models: ["gpt-4o", "o3"],
    default_model: "gpt-4o",
  });
  expect(made.models).toEqual(["gpt-4o"]);
  expect(made.availableModels).toEqual(["gpt-4o", "o3"]);
  expect(made.modelAttrs["gpt-4o"]).toEqual({ price: "1.5", thinkingLevels: ["low"], strengths: ["code"] });
  expect(made.apiKey).toBe("");
});

test("maps daemon messages onto provider fields", () => {
  expect(mapProviderError("name is required")).toEqual({ name: "empty" });
  expect(mapProviderError("endpoint_base_url cannot be empty")).toEqual({ endpoint: "empty" });
  expect(mapProviderError("endpoint_base_url must be an http or https URL")).toEqual({
    endpoint: "invalid",
  });
  expect(mapProviderError("locale must be zh or en")).toEqual({ top: true });
});
