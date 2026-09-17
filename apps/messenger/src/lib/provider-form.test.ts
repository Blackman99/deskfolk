import { expect, test } from "bun:test";
import {
  applyProbedModels,
  draftFromProvider,
  mapProviderError,
  modelSelectValue,
  parseModelSelectValue,
  planCreateProvider,
  planPatchProvider,
  providerHost,
  withSyncedDefaultModel,
} from "./provider-form.ts";

test("create provider requires name, http URL, key, models, and a listed default", () => {
  expect(
    planCreateProvider(
      { name: " ", baseUrl: "", apiKey: "", modelsText: "", defaultModel: "", modelAttrs: {} },
      true,
    ),
  ).toEqual({
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

test("create provider trims fields and sends the key", () => {
  expect(
    planCreateProvider(
      {
        name: " OpenAI ",
        baseUrl: " https://api.openai.com/v1 ",
        apiKey: "sk-secret",
        modelsText: " gpt-4o \n\ngpt-4o-mini\ngpt-4o",
        defaultModel: " gpt-4o ",
        modelAttrs: {},
      },
      true,
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-secret",
      models: [
        {
          name: "gpt-4o",
          price: null,
          thinking_levels: ["none", "low", "medium", "high"],
          strengths: [],
        },
        {
          name: "gpt-4o-mini",
          price: null,
          thinking_levels: ["none", "low", "medium", "high"],
          strengths: [],
        },
      ],
      default_model: "gpt-4o",
    },
  });
});

test("patch omits unchanged fields and a blank key", () => {
  const current = {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-4o"],
    default_model: "gpt-4o",
  };
  expect(planPatchProvider(current, draftFromProvider(current))).toEqual({ ok: true, patch: {} });
  expect(
    planPatchProvider(current, {
      name: "CPA",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-new",
      modelsText: "gpt-4o\ngpt-4o-mini",
      defaultModel: "gpt-4o-mini",
      modelAttrs: {},
    }),
  ).toEqual({
    ok: true,
    patch: {
      name: "CPA",
      api_key: "sk-new",
      models: [
        {
          name: "gpt-4o",
          price: null,
          thinking_levels: ["none", "low", "medium", "high"],
          strengths: [],
        },
        {
          name: "gpt-4o-mini",
          price: null,
          thinking_levels: ["none", "low", "medium", "high"],
          strengths: [],
        },
      ],
      default_model: "gpt-4o-mini",
    },
  });
});

test("model select values encode the provider", () => {
  expect(modelSelectValue("p1", "gpt-4o")).toBe("p1::gpt-4o");
  expect(parseModelSelectValue("p1::gpt-4o")).toEqual({ provider_id: "p1", model: "gpt-4o" });
  expect(parseModelSelectValue("gpt-4o")).toEqual({ provider_id: null, model: "gpt-4o" });
});

test("syncs default model onto the listed names", () => {
  expect(
    withSyncedDefaultModel({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      modelsText: "gpt-4o\ngpt-4o-mini",
      defaultModel: "gone",
      modelAttrs: {},
    }).defaultModel,
  ).toBe("gpt-4o");
  expect(
    withSyncedDefaultModel({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      modelsText: "gpt-4o",
      defaultModel: "gpt-4o",
      modelAttrs: {},
    }).defaultModel,
  ).toBe("gpt-4o");
});

test("probed models keep the overlap or take the first three", () => {
  expect(
    applyProbedModels(
      {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        modelsText: "gpt-4o\nold",
        defaultModel: "gpt-4o",
        modelAttrs: {},
      },
      ["gpt-4o", "gpt-4o-mini", "o1", "o3"],
    ),
  ).toEqual({
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    modelsText: "gpt-4o",
    defaultModel: "gpt-4o",
    modelAttrs: {
      "gpt-4o": { price: "", thinkingLevels: "none, low, medium, high", strengths: "" },
    },
  });
});

test("provider host is the URL host, or the raw string if unparsable", () => {
  expect(providerHost("https://api.openai.com/v1")).toBe("api.openai.com");
  expect(providerHost("not a url")).toBe("not a url");
  expect(providerHost("")).toBe("");
});

test("create provider sends price, thinking levels, and strengths", () => {
  expect(
    planCreateProvider(
      {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-secret",
        modelsText: "gpt-4o",
        defaultModel: "gpt-4o",
        modelAttrs: {
          "gpt-4o": { price: "3", thinkingLevels: "low, high", strengths: "code, writing" },
        },
      },
      true,
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-secret",
      models: [
        {
          name: "gpt-4o",
          price: 3,
          thinking_levels: ["low", "high"],
          strengths: ["code", "writing"],
        },
      ],
      default_model: "gpt-4o",
    },
  });
});

test("maps daemon messages onto provider fields", () => {
  expect(mapProviderError("name is required")).toEqual({ name: "empty" });
  expect(mapProviderError("endpoint_base_url cannot be empty")).toEqual({ endpoint: "empty" });
  expect(mapProviderError("endpoint_base_url must be an http or https URL")).toEqual({
    endpoint: "invalid",
  });
  expect(mapProviderError("locale must be zh or en")).toEqual({ top: true });
});
