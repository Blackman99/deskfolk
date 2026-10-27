/** What a Claude Code session reports it has used, per model, as the spend ledger bills it. */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type ModelTotals = { input: number; output: number; cached: number; cost: number };

/** A result's usage, per model: the session's so far, so a row bills only what grew since the last one. */
export function resultTotals(result: SDKResultMessage, model: string | null): Array<[string, ModelTotals]> {
  const usage = (result as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }).modelUsage ?? {};
  const totals: Array<[string, ModelTotals]> = Object.keys(usage).length > 0
    ? Object.entries(usage).map(([model, row]) => [model, {
      input: (row.inputTokens ?? 0) + (row.cacheReadInputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0),
      output: row.outputTokens ?? 0, cached: row.cacheReadInputTokens ?? 0, cost: row.costUSD ?? 0 }])
    : [[model ?? "claude", {
      input: (result.usage?.input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0),
      output: result.usage?.output_tokens ?? 0, cached: result.usage?.cache_read_input_tokens ?? 0, cost: result.total_cost_usd ?? 0 }]];
  return totals;
}
