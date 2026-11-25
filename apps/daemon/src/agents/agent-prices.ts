/**
 * Codex and agy (Antigravity) report the tokens a project session used but no price, so without
 * this table their spend never reaches the daily cap. The price here is estimated from each
 * model's public API rate, even when the session runs on a subscription, the way Claude Code's
 * own estimate is. It is an estimate of what the tokens would cost, not a bill.
 *
 * Left out: gpt-oss-120b (agy's `gpt-oss-120b-medium`) — OpenAI lists no price for it, and the
 * hosts that sell it disagree. agy's multi-model orchestrators (`gemini-pro-orchestrator`,
 * `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-argon`, `gemini-pro-orchestrator-carbon`,
 * `gemini-pro-orchestrator-hydrogen`) route dynamically between a planner and a faster executor
 * without a separate public rate; we estimate them at their primary planner model's rate as an
 * upper bound. A model not in the table stays unpriced. Rates are the standard tier; the higher
 * long-context tier (over 272K input tokens for OpenAI) is not modelled.
 */
import type { ModelPricing } from "@real-bot/protocol";
import { estimateCostUsdTicks } from "../spend-pricing";

/** The day the rates below were read from the vendors' pages. */
export const AGENT_PRICES_AS_OF = "2026-11-24";

/** USD per 1,000,000 tokens, keyed by `normalizeAgentModel` ids. */
export const AGENT_PRICES: Readonly<Record<string, ModelPricing>> = {
  // https://developers.openai.com/api/docs/pricing (read 2026-11-17)
  "gpt-5.6-terra": { input: 2, cached_input: 0.2, output: 12 },
  // https://developers.openai.com/api/docs/pricing (read 2026-11-17)
  "gpt-5.6-luna": { input: 0.2, cached_input: 0.02, output: 1.2 },
  // https://developers.openai.com/api/docs/pricing (read 2026-11-17)
  "gpt-6-astra": { input: 10, cached_input: 1, output: 50 },
  // https://aistudio.google.com/docs/pricing (read 2026-11-17). This is the rate through
  // 2026-12-31; Google doubles it from 2027-01-01 (1.5 / 0.15 / 7.5), so update then.
  "gemini-3.8-flash": { input: 0.75, cached_input: 0.075, output: 3.75 },
  // https://ai.google.dev/gemini-api/docs/pricing (read 2026-11-24)
  "gemini-4-hydrogen": { input: 1.5, cached_input: 0.075, output: 7.5 },
  "gemini-4-neon": { input: 3, cached_input: 0.15, output: 15 },
  // Introductory rate through 2026-11-30; Google doubles it from 2026-12-01 (4 / 0.2 / 20), so update then.
  "gemini-4-carbon": { input: 2, cached_input: 0.1, output: 10 },
  "gemini-4-argon": { input: 2, cached_input: 0.1, output: 10 },
  // https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-24)
  "claude-sonnet-4-6": { input: 3, cached_input: 0.3, output: 15 },
  "claude-opus-4-6": { input: 5, cached_input: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cached_input: 0.5, output: 25 },
  "claude-sonnet-5-5": { input: 2, cached_input: 0.1, output: 10 },
  "claude-opus-5-5": { input: 4, cached_input: 0.2, output: 20 },
  // https://docs.x.ai/docs/pricing (read 2026-11-18), the rate below 200K prompt tokens. Grok reports
  // most turns' price itself; these are for a turn it leaves out (`usageIsIncomplete`).
  "grok-4.7": { input: 2, cached_input: 0.5, output: 6 },
  "grok-4.6": { input: 2, cached_input: 0.5, output: 6 },
  "grok-4.5": { input: 2, cached_input: 0.3, output: 6 },
  // "Grok 4.7 Fast pricing (Cursor and Grok Build only)" on the same page: 2x the standard rate.
  "grok-4.7-build-fast": { input: 4, cached_input: 1, output: 12 },
};

/**
 * Lower-case, drop agy's thinking-level suffix so one model has one entry, map Grok's `-build`
 * usage name to its priced model, and map agy's `gemini-pro-orchestrator*` aliases to their
 * primary Gemini 4 planner model (an upper-bound estimate).
 */
export function normalizeAgentModel(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/-(xhigh|high|medium|low|thinking)$/, "")
    .replace(/^(grok-[\d.]+)-build$/, "$1")
    .replace(/^gemini-pro-orchestrator-(neon|argon|carbon|hydrogen)$/, "gemini-4-$1")
    .replace(/^gemini-pro-orchestrator$/, "gemini-4-carbon");
}

export function agentModelPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const key = normalizeAgentModel(model);
  return Object.hasOwn(AGENT_PRICES, key) ? AGENT_PRICES[key]! : null;
}

/** Ticks for one row's tokens, or null when the model has no entry in the table. */
export function estimateAgentCost(
  model: string | null | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
): number | null {
  const pricing = agentModelPricing(model);
  return pricing ? estimateCostUsdTicks(usage, pricing) : null;
}
