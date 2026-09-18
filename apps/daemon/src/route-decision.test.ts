import { describe, expect, test } from "bun:test";
import { classifyMessage, decideCompletion, pickThinkingLevel, type CatalogEntry } from "./route-decision";

/**
 * These rules only run when the routing agent cannot: no endpoint for the routing call, a timeout,
 * or an answer naming a model that does not exist. What a Bot has learned lives in its reviews and
 * never reaches this file — there is nothing here to penalise or reward.
 */
describe("fallback routing rules", () => {
  const catalog: CatalogEntry[] = [
    { name: "cheap-chat", price: 1, thinking_levels: ["none", "low"], strengths: ["chat"], providerId: "p1" },
    { name: "code-pro", price: 10, thinking_levels: ["medium", "high"], strengths: ["code"], providerId: "p1" },
    { name: "wide", price: 5, thinking_levels: ["low", "high", "max"], strengths: [], providerId: "p1" },
  ];

  test("a message is sorted by what it asks for", () => {
    expect(classifyMessage("refactor this typescript function")).toBe("coding");
    expect(classifyMessage("帮我证明这个定理")).toBe("reasoning");
    expect(classifyMessage("写一篇关于春天的诗")).toBe("writing");
    expect(classifyMessage("你好")).toBe("simple");
    expect(classifyMessage("把上周的进展整理成一份给客户看的材料")).toBe("general");
  });

  test("a complaint about the model is no longer special-cased as a kind", () => {
    // The regex that used to carve these out is gone; the review decides what a follow-up meant.
    expect(classifyMessage("这里不对")).toBe("simple");
    expect(classifyMessage("换个模型，太慢了")).toBe("simple");
  });

  test("the level targets how heavy the work is, whatever the endpoint named its levels", () => {
    expect(pickThinkingLevel("simple", ["none", "low", "high"])).toBe("none");
    expect(pickThinkingLevel("reasoning", ["none", "low", "high"])).toBe("high");
    // An endpoint that advertises a heavier level gets used for the heaviest kind.
    expect(pickThinkingLevel("reasoning", ["low", "high", "max"])).toBe("max");
    expect(pickThinkingLevel("simple", ["medium", "max"])).toBe("medium");
    expect(pickThinkingLevel("coding", ["none", "low", "medium", "high"])).toBe("medium");
  });

  test("a matching strength wins over a cheaper model", () => {
    const pick = decideCompletion({
      text: "refactor this typescript function",
      catalog,
      botModel: null,
      defaultProviderId: "p1",
    });
    expect(pick).toMatchObject({ model: "code-pro", signature: "coding" });
  });

  test("a throwaway line takes the cheapest model at its lightest level", () => {
    const pick = decideCompletion({
      text: "你好",
      catalog,
      botModel: null,
      defaultProviderId: "p1",
    });
    expect(pick).toMatchObject({ model: "cheap-chat", thinkingLevel: "none" });
  });

  test("a pinned model constrains the name; a pinned level constrains the level", () => {
    const pinned = decideCompletion({
      text: "你好",
      catalog,
      botModel: "code-pro",
      defaultProviderId: "p1",
    });
    expect(pinned).toMatchObject({ model: "code-pro" });
    const level = decideCompletion({
      text: "refactor this typescript function",
      catalog,
      botModel: "wide",
      botThinkingLevel: "max",
      defaultProviderId: "p1",
    });
    expect(level).toMatchObject({ model: "wide", thinkingLevel: "max" });
  });

  test("an empty catalog picks nothing rather than inventing a model", () => {
    expect(
      decideCompletion({ text: "hi", catalog: [], botModel: null, defaultProviderId: "p1" }),
    ).toBeNull();
  });
});
