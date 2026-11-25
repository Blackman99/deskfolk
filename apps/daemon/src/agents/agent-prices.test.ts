import { describe, expect, test } from "bun:test";
import { agentModelPricing, estimateAgentCost, normalizeAgentModel } from "./agent-prices";

describe("agent prices", () => {
  test("agy thinking levels share one entry", () => {
    const flash = agentModelPricing("gemini-3.8-flash");
    expect(flash).not.toBeNull();
    for (const id of ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]) {
      expect(agentModelPricing(id)).toEqual(flash);
    }
    const neon = agentModelPricing("gemini-4-neon");
    expect(neon).toEqual({ input: 3, cached_input: 0.15, output: 15 });
    for (const id of ["gemini-4-neon-xhigh", "gemini-4-neon-high", "gemini-4-neon-medium", "gemini-4-neon-low"]) {
      expect(agentModelPricing(id)).toEqual(neon);
    }
    for (const id of ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-high", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low"]) {
      expect(agentModelPricing(id)).toEqual({ input: 1.5, cached_input: 0.075, output: 7.5 });
    }
    for (const id of ["gemini-4-carbon-high", "gemini-4-carbon-medium", "gemini-4-carbon-low", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"]) {
      expect(agentModelPricing(id)).toEqual({ input: 2, cached_input: 0.1, output: 10 });
    }
    for (const id of ["claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low"]) {
      expect(agentModelPricing(id)).toEqual({ input: 4, cached_input: 0.2, output: 20 });
    }
    for (const id of ["claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low"]) {
      expect(agentModelPricing(id)).toEqual({ input: 2, cached_input: 0.1, output: 10 });
    }
    expect(normalizeAgentModel("claude-opus-4-6-thinking")).toBe("claude-opus-4-6");
    expect(agentModelPricing("claude-opus-4-6-thinking")).toEqual(agentModelPricing("claude-opus-4-6"));
    expect(agentModelPricing("claude-opus-4-7")).toEqual({ input: 5, cached_input: 0.5, output: 25 });
  });

  test("case is ignored and everything else is kept", () => {
    expect(normalizeAgentModel("GPT-5.6-Terra")).toBe("gpt-5.6-terra");
    expect(agentModelPricing("GPT-5.6-TERRA")).toEqual(agentModelPricing("gpt-5.6-terra"));
  });

  test("agy orchestrators use their primary planner model rate as an upper-bound estimate", () => {
    expect(agentModelPricing("gemini-pro-orchestrator-neon")).toEqual(agentModelPricing("gemini-4-neon"));
    expect(agentModelPricing("gemini-pro-orchestrator-neon-high")).toEqual(agentModelPricing("gemini-4-neon"));
    expect(agentModelPricing("gemini-pro-orchestrator-argon")).toEqual(agentModelPricing("gemini-4-argon"));
    expect(agentModelPricing("gemini-pro-orchestrator-carbon")).toEqual(agentModelPricing("gemini-4-carbon"));
    expect(agentModelPricing("gemini-pro-orchestrator-hydrogen")).toEqual(agentModelPricing("gemini-4-hydrogen"));
    expect(agentModelPricing("gemini-pro-orchestrator")).toEqual(agentModelPricing("gemini-4-carbon"));
  });

  test("unknown or missing models have no price", () => {
    expect(agentModelPricing("gpt-oss-120b-medium")).toBeNull();
    expect(agentModelPricing("nope")).toBeNull();
    expect(agentModelPricing(null)).toBeNull();
    expect(agentModelPricing("")).toBeNull();
    expect(estimateAgentCost("nope", { inputTokens: 1, outputTokens: 1, cachedTokens: 0 })).toBeNull();
  });

  test("Grok's models are priced, its build names by the model they run", () => {
    expect(agentModelPricing("grok-4.7")).toEqual({ input: 2, cached_input: 0.5, output: 6 });
    expect(agentModelPricing("grok-4.7-build")).toEqual(agentModelPricing("grok-4.7"));
    expect(agentModelPricing("grok-4.6-build")).toEqual(agentModelPricing("grok-4.6"));
    expect(agentModelPricing("grok-4.7-build-fast")).toEqual({ input: 4, cached_input: 1, output: 12 });
    expect(agentModelPricing("grok-4.5")?.cached_input).toBe(0.3);
  });

  test("estimate by hand", () => {
    // gpt-5.6-terra: 600k fresh * $2 + 400k cached * $0.20 + 100k out * $12 per 1M
    // = 1.20 + 0.08 + 1.20 = $2.48; one USD is 1e10 ticks.
    expect(estimateAgentCost("gpt-5.6-terra", {
      inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000,
    })).toBe(24_800_000_000);
    // gemini-4-neon-xhigh: 200k fresh * $3 + 800k cached * $0.15 + 100k out * $15 per 1M
    // = 0.60 + 0.12 + 1.50 = $2.22.
    expect(estimateAgentCost("gemini-4-neon-xhigh", {
      inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 800_000,
    })).toBe(22_200_000_000);
  });
});
