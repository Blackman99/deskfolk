import { describe, expect, test } from "bun:test";
import { agentModelPricing, estimateAgentCost, normalizeAgentModel } from "./agent-prices";

describe("agent prices", () => {
  test("agy thinking levels share one entry", () => {
    const flash = agentModelPricing("gemini-3.8-flash");
    expect(flash).not.toBeNull();
    for (const id of ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]) {
      expect(agentModelPricing(id)).toEqual(flash);
    }
    expect(normalizeAgentModel("claude-opus-4-6-thinking")).toBe("claude-opus-4-6");
    expect(agentModelPricing("claude-opus-4-6-thinking")).toEqual(agentModelPricing("claude-opus-4-6"));
  });

  test("case is ignored and everything else is kept", () => {
    expect(normalizeAgentModel("GPT-5.6-Terra")).toBe("gpt-5.6-terra");
    expect(agentModelPricing("GPT-5.6-TERRA")).toEqual(agentModelPricing("gpt-5.6-terra"));
  });

  test("unknown or missing models have no price", () => {
    expect(agentModelPricing("gpt-oss-120b-medium")).toBeNull();
    expect(agentModelPricing("nope")).toBeNull();
    expect(agentModelPricing(null)).toBeNull();
    expect(agentModelPricing("")).toBeNull();
    expect(estimateAgentCost("nope", { inputTokens: 1, outputTokens: 1, cachedTokens: 0 })).toBeNull();
  });

  test("estimate by hand", () => {
    // gpt-5.6-terra: 600k fresh * $2 + 400k cached * $0.20 + 100k out * $12 per 1M
    // = 1.20 + 0.08 + 1.20 = $2.48; one USD is 1e10 ticks.
    expect(estimateAgentCost("gpt-5.6-terra", {
      inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000,
    })).toBe(24_800_000_000);
  });
});
