/** What a Claude Code session reports it has used, per model, as the spend ledger bills it. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectContextUsage } from "@real-bot/protocol";
import { claudeAssistantPromptTokens, claudeContextUsageField, claudeModelContextWindow } from "../agents/agent-context";

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
/** Scans a JSONL file from the end back in 256 KiB chunks, returning the first non-null pick. */
function scanJsonlBack<T>(file: string, pick: (line: string) => T | null): T | null {
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
        const found = pick(lines[i]!);
        if (found !== null) return found;
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

export function carriedTotals(file: string): Map<string, ModelTotals> | null {
  return scanJsonlBack(file, (line) => (line.includes('"cost-state"') ? costStateTotals(line) : null));
}

/**
 * The latest main-thread context occupancy from a Claude Code session JSONL file, so existing or
 * imported sessions show accurate context usage before their next run. Reads the latest
 * non-sidechain `assistant` message's prompt tokens, any `cost-state` entry's reported
 * `contextWindow` for that model, and any matching `api-request` beta header (`context-1m-*`) so
 * 1M-variant requests stay distinguishable when `cost-state` omits `contextWindow`.
 */
export function lastContextUsage(file: string): ProjectContextUsage | null {
  let assistant: { used: number; model: string | null } | null = null;
  let costModelUsage: unknown = null;
  let costLimit: number | null = null;
  const apiRequest1m = new Map<string, boolean>();
  const direct = scanJsonlBack<ProjectContextUsage>(file, (line) => {
    if (!assistant && line.includes('"assistant"')) {
      try {
        const entry = JSON.parse(line) as { type?: unknown; isSidechain?: unknown; context_usage?: unknown; message?: { model?: unknown; usage?: unknown } };
        if (entry.type === "assistant" && entry.isSidechain !== true) {
          const explicit = claudeContextUsageField(entry);
          if (explicit) return explicit;
          const used = entry.message ? claudeAssistantPromptTokens(entry.message) : null;
          if (used !== null) {
            const model = typeof entry.message?.model === "string" && entry.message.model.trim() ? entry.message.model.trim() : null;
            assistant = { used, model };
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    if (costLimit === null && line.includes('"cost-state"')) {
      try {
        const entry = JSON.parse(line) as { type?: unknown; modelUsage?: unknown };
        if (entry.type === "cost-state" && entry.modelUsage && typeof entry.modelUsage === "object") {
          costModelUsage ??= entry.modelUsage;
          if (assistant) {
            const found = claudeModelContextWindow(entry.modelUsage, assistant.model);
            if (found !== null) costLimit = found;
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    if (line.includes('"api-request"')) {
      try {
        const entry = JSON.parse(line) as { type?: unknown; params?: { model?: unknown; betas?: unknown } };
        if (entry.type === "api-request" && typeof entry.params?.model === "string" && entry.params.model.trim()) {
          const reqModel = entry.params.model.trim();
          if (!apiRequest1m.has(reqModel)) {
            const betas = Array.isArray(entry.params.betas) ? entry.params.betas : [];
            apiRequest1m.set(reqModel, betas.some((b) => typeof b === "string" && /^context-1m-/i.test(b)));
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    if (assistant) {
      if (costLimit === null && costModelUsage) {
        costLimit = claudeModelContextWindow(costModelUsage, assistant.model);
      }
      if (costLimit !== null) {
        return { used: assistant.used, limit: costLimit, ...(assistant.model ? { model: assistant.model } : {}) };
      }
      // Once we have seen both cost-state (if any) and the matching api-request right beside the
      // last assistant message, we have all facts this transcript carries.
      if (costModelUsage && (!assistant.model || apiRequest1m.has(assistant.model))) {
        const model = assistant.model && !/\[[^\]]+\]$/.test(assistant.model) && apiRequest1m.get(assistant.model)
          ? `${assistant.model}[1m]`
          : assistant.model;
        return { used: assistant.used, limit: null, ...(model ? { model } : {}) };
      }
    }
    return null;
  });
  if (direct) return direct;
  if (!assistant) return null;
  const { used, model: rawModel } = assistant as { used: number; model: string | null };
  const limit = costLimit ?? (costModelUsage ? claudeModelContextWindow(costModelUsage, rawModel) : null);
  const model = limit === null && rawModel && !/\[[^\]]+\]$/.test(rawModel) && apiRequest1m.get(rawModel)
    ? `${rawModel}[1m]`
    : rawModel;
  return { used, limit, ...(model ? { model } : {}) };
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
