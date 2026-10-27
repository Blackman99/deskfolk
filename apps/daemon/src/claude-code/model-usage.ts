/** What a Claude Code session reports it has used, per model, as the spend ledger bills it. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type ModelTotals = { input: number; output: number; cached: number; cost: number };

type ModelUsageRow = { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number };

/** Claude Code's `modelUsage`, per model: the input with its cache reads and writes, the output, the cache reads, the estimated cost. */
function modelUsageTotals(usage: Record<string, ModelUsageRow>): Array<[string, ModelTotals]> {
  return Object.entries(usage).map(([model, row]) => [model, {
    input: (row.inputTokens ?? 0) + (row.cacheReadInputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0),
    output: row.outputTokens ?? 0, cached: row.cacheReadInputTokens ?? 0, cost: row.costUSD ?? 0 }]);
}

/** A result's usage, per model: the session's so far, so a row bills only what grew since the last one. */
export function resultTotals(result: SDKResultMessage, model: string | null): Array<[string, ModelTotals]> {
  const usage = (result as { modelUsage?: Record<string, ModelUsageRow> }).modelUsage ?? {};
  const totals: Array<[string, ModelTotals]> = Object.keys(usage).length > 0
    ? modelUsageTotals(usage)
    : [[model ?? "claude", {
      input: (result.usage?.input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0),
      output: result.usage?.output_tokens ?? 0, cached: result.usage?.cache_read_input_tokens ?? 0, cost: result.total_cost_usd ?? 0 }]];
  return totals;
}

const CHUNK = 256 * 1024;

/**
 * The totals a resumed session starts from. Claude Code (2.1.307) writes its running totals into
 * the session's file as a `cost-state` entry when it exits, and a run that resumes the session, or
 * branches off it, starts counting from the last one: its results then count every earlier run too.
 * Read from the end of the file back, since the last entry is near it. Null when there is none (a
 * Claude Code that writes none starts from zero) or the file cannot be read.
 */
export function carriedTotals(file: string): Map<string, ModelTotals> | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    let end = fstatSync(fd).size;
    // The start of a line the chunk read before this one began part way through.
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      let bytes = Buffer.concat([chunk, rest]);
      if (start > 0) {
        const cut = bytes.indexOf(0x0a);
        rest = cut < 0 ? bytes : bytes.subarray(0, cut);
        bytes = cut < 0 ? Buffer.alloc(0) : bytes.subarray(cut + 1);
      }
      const lines = bytes.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const totals = lines[i]!.includes('"cost-state"') ? costStateTotals(lines[i]!) : null;
        if (totals) return totals;
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function costStateTotals(line: string): Map<string, ModelTotals> | null {
  try {
    const entry = JSON.parse(line) as { type?: unknown; modelUsage?: unknown };
    if (entry.type !== "cost-state" || !entry.modelUsage || typeof entry.modelUsage !== "object") return null;
    return new Map(modelUsageTotals(entry.modelUsage as Record<string, ModelUsageRow>));
  } catch {
    return null;
  }
}
