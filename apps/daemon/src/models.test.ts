import { describe, expect, test } from "bun:test";
import {
  catalogNames,
  normalizeBotModel,
  normalizeDefaultModel,
  normalizeModelCatalog,
  normalizeModelList,
  parseStoredCatalog,
  parseStoredModels,
  resolveCompletionModel,
  resolveCompletionTarget,
  unionProviderModels,
} from "./models";
import {
  applyFeedbackToLearned,
  decideCompletion,
  emptyLearnedState,
  type CatalogEntry,
} from "./route-decision";
import { HttpError } from "./errors";

describe("endpoint model names", () => {
  test("normalizes a list, trims, and drops duplicates", () => {
    expect(normalizeModelList([" grok-4.5 ", "deepseek-v4-pro", "grok-4.5"])).toEqual([
      "grok-4.5",
      "deepseek-v4-pro",
    ]);
  });

  test("rejects a non-array or empty name", () => {
    expect(() => normalizeModelList("grok-4.5")).toThrow(HttpError);
    expect(() => normalizeModelList(["  "])).toThrow(HttpError);
  });

  test("catalog objects carry price, thinking levels, and strengths", () => {
    expect(
      normalizeModelCatalog([
        " grok-4.5 ",
        {
          name: "deepseek-v4-pro",
          price: 1.2,
          thinking_levels: ["low", "high"],
          strengths: [" code ", "code", "reasoning"],
        },
      ]),
    ).toEqual([
      {
        name: "grok-4.5",
        price: null,
        thinking_levels: ["none", "low", "medium", "high"],
        strengths: [],
      },
      {
        name: "deepseek-v4-pro",
        price: 1.2,
        thinking_levels: ["low", "high"],
        strengths: ["code", "reasoning"],
      },
    ]);
    expect(catalogNames(normalizeModelCatalog(["a"]))).toEqual(["a"]);
  });

  test("stored catalog JSON upgrades a legacy string array", () => {
    expect(parseStoredModels(`["grok-4.5","deepseek-v4-pro"]`)).toEqual(["grok-4.5", "deepseek-v4-pro"]);
    expect(parseStoredCatalog(`["grok-4.5"]`)).toEqual([
      {
        name: "grok-4.5",
        price: null,
        thinking_levels: ["none", "low", "medium", "high"],
        strengths: [],
      },
    ]);
    expect(
      parseStoredCatalog(
        JSON.stringify([
          { name: "grok-4.5", price: 3, thinking_levels: ["high"], strengths: ["writing"] },
        ]),
      ),
    ).toEqual([
      { name: "grok-4.5", price: 3, thinking_levels: ["high"], strengths: ["writing"] },
    ]);
  });

  test("default must be in the list; blank clears", () => {
    expect(normalizeDefaultModel("grok-4.5", ["grok-4.5"])).toBe("grok-4.5");
    expect(normalizeDefaultModel("  ", ["grok-4.5"])).toBeNull();
    expect(() => normalizeDefaultModel("nope", ["grok-4.5"])).toThrow(HttpError);
  });

  test("bot model null or blank means the default; unknown is invalid", () => {
    expect(normalizeBotModel(null, ["grok-4.5"])).toBeNull();
    expect(normalizeBotModel("  ", ["grok-4.5"])).toBeNull();
    expect(normalizeBotModel("grok-4.5", ["grok-4.5"])).toBe("grok-4.5");
    expect(() => normalizeBotModel("nope", ["grok-4.5"])).toThrow(HttpError);
  });

  test("resolve prefers a still-allowed bot model, else the default", () => {
    expect(
      resolveCompletionModel({
        botModel: "deepseek-v4-pro",
        defaultModel: "grok-4.5",
        models: ["grok-4.5", "deepseek-v4-pro"],
      }),
    ).toBe("deepseek-v4-pro");
    expect(
      resolveCompletionModel({
        botModel: "gone",
        defaultModel: "grok-4.5",
        models: ["grok-4.5"],
      }),
    ).toBe("grok-4.5");
    expect(
      resolveCompletionModel({
        botModel: null,
        defaultModel: null,
        models: ["grok-4.5"],
      }),
    ).toBeNull();
  });

  test("stored JSON that is not a string array is an empty list", () => {
    expect(parseStoredModels(undefined)).toEqual([]);
    expect(parseStoredModels("")).toEqual([]);
    expect(parseStoredModels("[1,2]")).toEqual([]);
    expect(parseStoredModels(`["a",""]`)).toEqual(["a"]);
  });
});

describe("multi-provider model resolution", () => {
  const openai = { id: "p1", models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gpt-4o" };
  const deepseek = { id: "p2", models: ["deepseek-chat"], defaultModel: "deepseek-chat" };

  test("union keeps first-seen names", () => {
    expect(unionProviderModels([openai, { id: "p3", models: ["gpt-4o", "claude"], defaultModel: "claude" }])).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "claude",
    ]);
  });

  test("explicit provider wins; unknown provider or missing model is null", () => {
    expect(
      resolveCompletionTarget([openai, deepseek], {
        botModel: "gpt-4o-mini",
        botProviderId: "p1",
        defaultProviderId: "p2",
      }),
    ).toEqual({ providerId: "p1", model: "gpt-4o-mini" });
    expect(
      resolveCompletionTarget([openai, deepseek], {
        botModel: "deepseek-chat",
        botProviderId: "p1",
        defaultProviderId: "p1",
      }),
    ).toBeNull();
  });

  test("a unique model name picks its provider; default provider breaks ties", () => {
    expect(
      resolveCompletionTarget([openai, deepseek], {
        botModel: "deepseek-chat",
        botProviderId: null,
        defaultProviderId: "p1",
      }),
    ).toEqual({ providerId: "p2", model: "deepseek-chat" });
    const shared = [
      { id: "a", models: ["shared"], defaultModel: "shared" },
      { id: "b", models: ["shared"], defaultModel: "shared" },
    ];
    expect(
      resolveCompletionTarget(shared, {
        botModel: "shared",
        botProviderId: null,
        defaultProviderId: "b",
      }),
    ).toEqual({ providerId: "b", model: "shared" });
  });

  test("empty bot model uses the default provider's default model", () => {
    expect(
      resolveCompletionTarget([openai, deepseek], {
        botModel: null,
        botProviderId: null,
        defaultProviderId: "p2",
      }),
    ).toEqual({ providerId: "p2", model: "deepseek-chat" });
  });
});

describe("per-message completion decision", () => {
  const codingCatalog: CatalogEntry[] = [
    {
      providerId: "p1",
      name: "cheap-chat",
      price: 1,
      thinking_levels: ["none", "low"],
      strengths: ["chat"],
    },
    {
      providerId: "p1",
      name: "code-pro",
      price: 12,
      thinking_levels: ["medium", "high"],
      strengths: ["code", "coding"],
    },
  ];
  const writingCatalog: CatalogEntry[] = [
    {
      providerId: "p1",
      name: "cheap-chat",
      price: 1,
      thinking_levels: ["none"],
      strengths: ["chat"],
    },
    {
      providerId: "p1",
      name: "writer-pro",
      price: 8,
      thinking_levels: ["low", "medium"],
      strengths: ["writing", "文案"],
    },
  ];

  test("returns a catalog model and a thinking level; catalogs/messages can differ", () => {
    const coding = decideCompletion({
      text: "please implement a TypeScript function that parses the AST",
      catalog: codingCatalog,
      botModel: null,
      learned: emptyLearnedState(),
    });
    const writing = decideCompletion({
      text: "write a poem about the autumn rain",
      catalog: writingCatalog,
      botModel: null,
      learned: emptyLearnedState(),
    });
    expect(coding).not.toBeNull();
    expect(writing).not.toBeNull();
    expect(codingCatalog.some((row) => row.name === coding!.model)).toBe(true);
    expect(writingCatalog.some((row) => row.name === writing!.model)).toBe(true);
    expect(["none", "low", "medium", "high"]).toContain(coding!.thinkingLevel);
    expect(["none", "low", "medium", "high"]).toContain(writing!.thinkingLevel);
    expect(coding!.model).not.toBe(writing!.model);
    expect(coding).toMatchObject({ model: "code-pro", thinkingLevel: "medium" });
    expect(writing).toMatchObject({ model: "writer-pro", thinkingLevel: "low" });
  });

  test("empty pin may pick any listed model; a still-listed pin constrains the name", () => {
    const open = decideCompletion({
      text: "please implement a TypeScript function that parses the AST",
      catalog: codingCatalog,
      botModel: null,
      learned: emptyLearnedState(),
    });
    const pinned = decideCompletion({
      text: "please implement a TypeScript function that parses the AST",
      catalog: codingCatalog,
      botModel: "cheap-chat",
      learned: emptyLearnedState(),
    });
    expect(open?.model).toBe("code-pro");
    expect(pinned?.model).toBe("cheap-chat");
    expect(pinned?.thinkingLevel).toBe("low");
  });

  test("feedback on a decision moves a later comparable choice away from the blamed pair", () => {
    const text = "please implement a TypeScript function that parses the AST";
    const first = decideCompletion({
      text,
      catalog: codingCatalog,
      botModel: null,
      learned: emptyLearnedState(),
    });
    expect(first).toMatchObject({ model: "code-pro", thinkingLevel: "medium" });
    const learned = applyFeedbackToLearned(emptyLearnedState(), {
      signature: first!.signature,
      model: first!.model,
      thinkingLevel: first!.thinkingLevel,
    });
    const next = decideCompletion({
      text,
      catalog: codingCatalog,
      botModel: null,
      learned,
    });
    expect(next).not.toBeNull();
    expect(`${next!.model}:${next!.thinkingLevel}`).not.toBe(`${first!.model}:${first!.thinkingLevel}`);
  });
});

