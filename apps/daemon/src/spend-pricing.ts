import type { ModelPricing } from "@real-bot/protocol";

/** Provider reasoning tokens are already included in output tokens. */
export function estimateCostUsdTicks(
  usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
    costUsdTicks?: number | null;
  },
  pricing: ModelPricing | null | undefined,
): number | null {
  if (usage.costUsdTicks != null || !pricing) return null;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input == null || output == null) return null;
  const cached = usage.cachedTokens ?? 0;
  if (![input, output, cached, pricing.input, pricing.output, pricing.cached_input ?? pricing.input]
    .every((value) => Number.isFinite(value) && value >= 0) || cached > input) return null;
  // One USD is 1e10 ticks; each catalog rate is per 1e6 tokens.
  const ticks = Math.round(((input - cached) * pricing.input +
    cached * (pricing.cached_input ?? pricing.input) + output * pricing.output) * 1e4);
  return Number.isSafeInteger(ticks) ? ticks : null;
}
