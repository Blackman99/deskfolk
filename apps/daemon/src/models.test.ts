import { describe, expect, test } from "bun:test";
import {
  catalogNames,
  normalizeAvailableModels,
  normalizeBotModel,
  normalizeDefaultModel,
  normalizeModelCatalog,
  normalizeModelList,
  parseStoredAvailableModels,
  parseStoredCatalog,
  parseStoredModels,
  resolveCompletionModel,
  resolveCompletionTarget,
  unionProviderModels,
} from "./models";
import {
  decideCompletion,
  pickThinkingLevel,
  type CatalogEntry,
} from "./route-decision";
import { HttpError } from "./errors";

describe("endpoint model names", () => {
  test("the probed list is trimmed and deduped, and rejects non-strings", () => {
    expect(normalizeAvailableModels([" gpt-4o ", "gpt-4o", "", "o3"])).toEqual(["gpt-4o", "o3"]);
    expect(() => normalizeAvailableModels("gpt-4o")).toThrow(HttpError);
    expect(() => normalizeAvailableModels([1])).toThrow(HttpError);
    expect(parseStoredAvailableModels('["gpt-4o"," o3 ","gpt-4o",3]')).toEqual(["gpt-4o", "o3"]);
    expect(parseStoredAvailableModels(undefined)).toEqual([]);
    expect(parseStoredAvailableModels("not json")).toEqual([]);
  });

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

  test("catalog objects accept endpoint-specific thinking levels", () => {
    expect(
      normalizeModelCatalog([
        { name: "grok-4.6", thinking_levels: ["xhigh", "low", "high"] },
        { name: "gemini-flash", thinking_levels: ["max", "low"] },
      ]),
    ).toEqual([
      {
        name: "grok-4.6",
        price: null,
        thinking_levels: ["low", "high", "xhigh"],
        strengths: [],
      },
      {
        name: "gemini-flash",
        price: null,
        thinking_levels: ["low", "max"],
        strengths: [],
      },
    ]);
    expect(() => normalizeModelCatalog([{ name: "bad", thinking_levels: ["high!"] }])).toThrow(HttpError);
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
    });
    const writing = decideCompletion({
      text: "write a poem about the autumn rain",
      catalog: writingCatalog,
      botModel: null,
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

  test("picks advertised levels such as xhigh and max by task kind", () => {
    expect(pickThinkingLevel("simple", ["low", "high", "xhigh"])).toBe("low");
    expect(pickThinkingLevel("writing", ["low", "high", "xhigh"])).toBe("low");
    expect(pickThinkingLevel("coding", ["low", "high", "xhigh"])).toBe("high");
    expect(pickThinkingLevel("reasoning", ["low", "high", "xhigh"])).toBe("xhigh");
    expect(pickThinkingLevel("reasoning", ["low", "max"])).toBe("max");
    expect(pickThinkingLevel("simple", ["none", "low", "medium", "high"])).toBe("none");
    expect(pickThinkingLevel("coding", ["none", "low", "medium", "high"])).toBe("medium");
    expect(pickThinkingLevel("reasoning", ["none", "low", "medium", "high"])).toBe("high");
  });

  test("a reasoning task on a Grok-style catalog prefers xhigh", () => {
    const picked = decideCompletion({
      text: "prove why this architecture is sound",
      catalog: [
        {
          providerId: "p1",
          name: "grok-4.6",
          price: 5,
          thinking_levels: ["low", "medium", "high", "xhigh"],
          strengths: ["reasoning"],
        },
      ],
      botModel: null,
    });
    expect(picked).toMatchObject({ model: "grok-4.6", thinkingLevel: "xhigh" });
  });

  test("empty pin may pick any listed model; a still-listed pin constrains the name", () => {
    const open = decideCompletion({
      text: "please implement a TypeScript function that parses the AST",
      catalog: codingCatalog,
      botModel: null,
    });
    const pinned = decideCompletion({
      text: "please implement a TypeScript function that parses the AST",
      catalog: codingCatalog,
      botModel: "cheap-chat",
    });
    expect(open?.model).toBe("code-pro");
    expect(pinned?.model).toBe("cheap-chat");
    expect(pinned?.thinkingLevel).toBe("low");
  });

});


describe("route scoping across endpoints", () => {
  const levels = ["none", "low", "medium", "high"] as const;
  // The roster that sent an unpinned Bot to a second endpoint nobody had assigned it to.
  const roster: CatalogEntry[] = [
    { name: "grok-4.6", price: null, thinking_levels: [...levels], strengths: [], providerId: "default" },
    {
      name: "gemini-3.8-flash-high",
      price: null,
      thinking_levels: [...levels],
      strengths: ["design"],
      providerId: "default",
    },
    { name: "deepseek-flash", price: null, thinking_levels: [...levels], strengths: [], providerId: "deepseek" },
    { name: "deepseek-v4-pro", price: null, thinking_levels: [...levels], strengths: [], providerId: "deepseek" },
  ];
  const text = "把这周的进度汇总一下发给大家看看";
  test("an unpinned Bot stays on the default endpoint even when another endpoint scores higher", () => {
    // With no default endpoint known (legacy state) the whole catalog stays open.
    const legacy = decideCompletion({ text, catalog: roster, botModel: null });
    expect(legacy?.signature).toBe("general");

    const scoped = decideCompletion({
      text,
      catalog: roster,
      botModel: null,
      defaultProviderId: "default",
    });
    expect(scoped?.providerId).toBe("default");
    expect(["grok-4.6", "gemini-3.8-flash-high"]).toContain(scoped!.model);
  });

  test("a Bot pinned to another endpoint picks from that endpoint only", () => {
    const decision = decideCompletion({
      text,
      catalog: roster,
      botModel: null,
      botProviderId: "deepseek",
      defaultProviderId: "default",
    });
    expect(decision?.providerId).toBe("deepseek");
  });

  test("a pinned model listed only on another endpoint is still honored", () => {
    const decision = decideCompletion({
      text,
      catalog: roster,
      botModel: "deepseek-v4-pro",
      defaultProviderId: "default",
    });
    expect(decision).toMatchObject({ model: "deepseek-v4-pro", providerId: "deepseek" });
  });

  test("a pinned model listed on both endpoints prefers the default endpoint's copy", () => {
    const shared: CatalogEntry[] = [
      { name: "shared", price: null, thinking_levels: [...levels], strengths: [], providerId: "a" },
      { name: "shared", price: null, thinking_levels: [...levels], strengths: [], providerId: "b" },
    ];
    const decision = decideCompletion({
      text,
      catalog: shared,
      botModel: "shared",
      defaultProviderId: "b",
    });
    expect(decision).toMatchObject({ model: "shared", providerId: "b" });
  });

  test("a default endpoint with an empty list yields no decision instead of borrowing another endpoint", () => {
    const decision = decideCompletion({
      text,
      catalog: roster.filter((row) => row.providerId === "deepseek"),
      botModel: null,
      defaultProviderId: "default",
    });
    expect(decision).toBeNull();
  });
});
