import { expect, test } from "bun:test";
import {
  addAttrStrength,
  addAttrThinkingLevel,
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
    advertisedThinking: {},
    defaultModel: "gpt-4o",
    modelAttrs: {},
    ...overrides,
  };
}

test("create provider requires a name, an http URL and a key; the model list comes later", () => {
  expect(planCreateProvider({ ...emptyProviderDraft(), name: " " }, true)).toEqual({
    ok: false,
    errors: {
      name: "empty",
      endpoint: "empty",
      endpointKey: "empty",
    },
  });
  const plan = planCreateProvider(
    draft({ apiKey: "sk", models: [], defaultModel: "", availableModels: [] }),
    true,
  );
  expect(plan).toEqual({
    ok: true,
    body: {
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk",
      models: [],
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

const gpt4o = { name: "gpt-4o", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] };

test("clearing the current default sends an explicit empty default_model", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini"],
    available_models: ["gpt-4o", "gpt-4o-mini"],
    default_model: "gpt-4o",
  };
  expect(
    planPatchProvider(
      current,
      draft({
        models: ["gpt-4o", "gpt-4o-mini"],
        availableModels: ["gpt-4o", "gpt-4o-mini"],
        defaultModel: "",
      }),
    ),
  ).toEqual({ ok: true, patch: { default_model: "" } });
});

test("deselecting every model is allowed and clears the default", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini"],
    available_models: ["gpt-4o", "gpt-4o-mini"],
    default_model: "gpt-4o",
  };
  expect(
    planPatchProvider(
      current,
      draft({ models: [], availableModels: ["gpt-4o", "gpt-4o-mini"], defaultModel: "" }),
    ),
  ).toEqual({ ok: true, patch: { models: [], default_model: "" } });
});

test("enabling the first model on an empty list keeps an empty default", () => {
  expect(
    planPatchProvider(
      {
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        models: [],
        available_models: [],
        default_model: null,
      },
      draft({ models: ["llama3"], availableModels: [], defaultModel: "" }),
    ),
  ).toEqual({
    ok: true,
    patch: {
      models: [{ name: "llama3", price: null, thinking_levels: [...ALL_LEVELS], strengths: [] }],
      default_model: "",
    },
  });
});

test("a connection or attribute edit keeps an empty default explicit", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    model_catalog: [gpt4o],
    available_models: ["gpt-4o"],
    default_model: null,
  };
  expect(
    planPatchProvider(
      current,
      draft({
        baseUrl: "https://cpa.example/v1",
        apiKey: "sk-new",
        models: ["gpt-4o"],
        availableModels: ["gpt-4o"],
        defaultModel: "",
      }),
    ),
  ).toEqual({
    ok: true,
    patch: { base_url: "https://cpa.example/v1", api_key: "sk-new", default_model: "" },
  });
  expect(
    planPatchProvider(
      current,
      draft({
        models: ["gpt-4o"],
        availableModels: ["gpt-4o"],
        defaultModel: "",
        modelAttrs: { "gpt-4o": { price: "2", thinkingLevels: ["low", "high"], strengths: ["code"] } },
      }),
    ),
  ).toEqual({
    ok: true,
    patch: {
      models: [{ name: "gpt-4o", price: 2, thinking_levels: ["low", "high"], strengths: ["code"] }],
      default_model: "",
    },
  });
});

test("an unchanged endpoint with an empty default sends no patch", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    available_models: ["gpt-4o"],
    default_model: null,
  };
  expect(
    planPatchProvider(
      current,
      draft({ models: ["gpt-4o"], availableModels: ["gpt-4o"], defaultModel: "" }),
    ),
  ).toEqual({ ok: true, patch: {} });
});

test("a non-empty default still has to be one of the enabled models", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    available_models: ["gpt-4o", "gpt-4o-mini"],
    default_model: "gpt-4o",
  };
  expect(
    planPatchProvider(
      current,
      draft({
        models: ["gpt-4o"],
        availableModels: ["gpt-4o", "gpt-4o-mini"],
        defaultModel: "gpt-4o-mini",
      }),
    ),
  ).toEqual({ ok: false, errors: { defaultModel: "invalid" } });
  expect(
    planPatchProvider(current, draft({ models: [], availableModels: ["gpt-4o"], defaultModel: "gpt-4o" })),
  ).toEqual({ ok: false, errors: { defaultModel: "invalid" } });
});

test("model select values encode the provider", () => {
  expect(modelSelectValue("p1", "gpt-4o")).toBe("p1::gpt-4o");
  expect(parseModelSelectValue("p1::gpt-4o")).toEqual({ provider_id: "p1", model: "gpt-4o" });
  expect(parseModelSelectValue("gpt-4o")).toEqual({ provider_id: null, model: "gpt-4o" });
});

test("syncs default model onto the enabled names and prunes stray attributes", () => {
  expect(
    withSyncedDefaultModel(draft({ models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gone" })).defaultModel,
  ).toBe("");
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
  expect(short.defaultModel).toBe("");
  const long = applyProbedModels(draft({ models: [], defaultModel: "" }), ["a", "b", "c", "d"]);
  expect(long.models).toEqual([]);
  expect(long.defaultModel).toBe("");
});

test("toggling, bulk-setting, and hand-adding names keep the default in range", () => {
  let next = toggleDraftModel(draft({ availableModels: ["gpt-4o", "o3"] }), "o3");
  expect(next.models).toEqual(["gpt-4o", "o3"]);
  next = toggleDraftModel(next, "gpt-4o");
  expect(next.models).toEqual(["o3"]);
  expect(next.defaultModel).toBe("");
  next = setDraftModels(next, []);
  expect(next.models).toEqual([]);
  expect(next.defaultModel).toBe("");
  next = addDraftModel(next, "  my-finetune ");
  expect(next.models).toEqual(["my-finetune"]);
  expect(next.defaultModel).toBe("");
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
  attr = addAttrThinkingLevel(attr, "xhigh");
  expect(attr.thinkingLevels).toEqual(["none", "xhigh"]);
  expect(addAttrThinkingLevel(attr, "XHIGH")).toBe(attr);
});

test("a probed catalog fills advertised thinking levels unless the draft already customized them", () => {
  const next = applyProbedModels(draft({ models: ["grok-4.6"] }), {
    models: ["grok-4.6", "gemini-flash"],
    catalog: [
      { name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] },
      { name: "gemini-flash", thinking_levels: ["low", "max"] },
    ],
  });
  expect(next.availableModels).toEqual(["grok-4.6", "gemini-flash"]);
  expect(next.advertisedThinking["grok-4.6"]).toEqual(["low", "high", "xhigh"]);
  expect(next.modelAttrs["grok-4.6"]?.thinkingLevels).toEqual(["low", "high", "xhigh"]);
  const customized = applyProbedModels(
    draft({
      models: ["grok-4.6"],
      modelAttrs: { "grok-4.6": { price: "", thinkingLevels: ["high"], strengths: [] } },
    }),
    { catalog: [{ name: "grok-4.6", thinking_levels: ["low", "xhigh"] }] },
  );
  expect(customized.modelAttrs["grok-4.6"]?.thinkingLevels).toEqual(["high"]);
  expect(customized.advertisedThinking["grok-4.6"]).toEqual(["low", "xhigh"]);
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
  expect(made.advertisedThinking).toEqual({});
  expect(made.apiKey).toBe("");
});

test("reopening a saved catalog does not treat it as advertised, so a later probe leaves a hand-edited list alone", () => {
  const reopened = draftFromProvider({
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["grok-4.6"],
    model_catalog: [{ name: "grok-4.6", price: null, thinking_levels: ["high"], strengths: [] }],
    available_models: ["grok-4.6"],
    default_model: "grok-4.6",
  });
  const next = applyProbedModels(reopened, {
    catalog: [{ name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] }],
  });
  expect(next.modelAttrs["grok-4.6"]?.thinkingLevels).toEqual(["high"]);
  expect(next.advertisedThinking["grok-4.6"]).toEqual(["low", "high", "xhigh"]);
});

test("maps daemon messages onto provider fields", () => {
  expect(mapProviderError("name is required")).toEqual({ name: "empty" });
  expect(mapProviderError("endpoint_base_url cannot be empty")).toEqual({ endpoint: "empty" });
  expect(mapProviderError("endpoint_base_url must be an http or https URL")).toEqual({
    endpoint: "invalid",
  });
  expect(mapProviderError("locale must be zh or en")).toEqual({ top: true });
});

test("billing rates persist separately from routing price, and clear as a whole", () => {
  const current = { name: "Billing", base_url: "https://fixture.invalid", models: ["model"], default_model: "model",
    model_catalog: [{ name: "model", price: 7, thinking_levels: ["low"], strengths: [], pricing: { input: 2, output: 8, cached_input: 0.5 } }] };
  const original = draftFromProvider(current);
  expect(planPatchProvider(current, original)).toEqual({ ok: true, patch: {} });
  expect(original.modelAttrs.model).toMatchObject({ price: "7", billingInput: "2", billingOutput: "8", billingCachedInput: "0.5" });
  const changed = { ...original, modelAttrs: { model: { ...original.modelAttrs.model!, billingInput: "3" } } };
  const plan = planPatchProvider(current, changed);
  expect(plan.ok && plan.patch.models?.[0]).toMatchObject({ price: 7, pricing: { input: 3, output: 8, cached_input: 0.5 } });
  const cleared = { ...original, modelAttrs: { model: { ...original.modelAttrs.model!, billingInput: "", billingOutput: "", billingCachedInput: "" } } };
  const clearPlan = planPatchProvider(current, cleared);
  expect(clearPlan.ok && clearPlan.patch.models?.[0]).not.toHaveProperty("pricing");
  const probed = applyProbedModels(changed, ["model", "other"]);
  expect(probed.modelAttrs.model?.billingInput).toBe("3");
});

test("partial billing drafts cannot silently clear saved rates during auto-save", () => {
  const current = { name: "Billing", base_url: "https://fixture.invalid", models: ["model"], default_model: "model" };
  for (const patch of [{ billingInput: "2" }, { billingOutput: "2" }, { billingInput: "-1", billingOutput: "2" }, { billingInput: "NaN", billingOutput: "2" }]) {
    const draft = draftFromProvider(current);
    draft.modelAttrs.model = { ...emptyModelAttr(), ...patch };
    expect(planPatchProvider(current, draft)).toEqual({ ok: false, errors: { pricing: "invalid" } });
  }
});
