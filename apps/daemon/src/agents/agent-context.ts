/**
 * Context window usage helpers for project sessions: extracts current prompt occupancy and window
 * size strictly from what each agent itself reports. Never guesses a model's context window from
 * its name (the same model id can run on 200k or 1M windows depending on plan/settings), and never
 * substitutes cumulative multi-hop billing totals for current context occupancy.
 */
import type { ProjectContextUsage } from "@real-bot/protocol";

const posInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);
const nonNegInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const cleanModel = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Strips bracketed context suffixes (`claude-opus-4-6[1m]` → `claude-opus-4-6`) for key matching. */
const stripVariant = (name: string): string => name.trim().replace(/\[[^\]]+\]$/, "");

/** Whether two model names refer to the same base model (ignoring `[1m]`-style context suffixes). */
export function sameModelBase(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = cleanModel(a);
  const right = cleanModel(b);
  return left !== null && right !== null && stripVariant(left) === stripVariant(right);
}

/**
 * Preserves a previously reported context window limit for the same base model when a later usage
 * update omits `limit`, without ever carrying one model's window onto a different model.
 */
export function carryContextLimit(prev: ProjectContextUsage | null | undefined, next: ProjectContextUsage): ProjectContextUsage {
  if (next.limit !== null) return next;
  if (prev?.limit && prev.limit > 0 && (sameModelBase(prev.model, next.model) || (!prev.model && !next.model))) {
    return { ...next, limit: prev.limit };
  }
  return next;
}

/**
 * Total prompt tokens of one Claude Code `assistant` message (`input_tokens + cache_read + cache_creation`),
 * which reflects the actual context window occupancy of that single API call; null when absent or zero.
 */
export function claudeAssistantPromptTokens(message: unknown): number | null {
  const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const total = (nonNegInt(usage.input_tokens) ?? 0) + (nonNegInt(usage.cache_read_input_tokens) ?? 0) + (nonNegInt(usage.cache_creation_input_tokens) ?? 0);
  return total > 0 ? total : null;
}

/**
 * Structured context usage attached directly to a Claude Code `assistant` message (e.g. `/context`
 * output via `SDKAssistantMessage.context_usage`); null when absent.
 */
export function claudeContextUsageField(message: unknown): ProjectContextUsage | null {
  const ctx = (message as { context_usage?: { total_tokens?: unknown; raw_max_tokens?: unknown; model?: unknown } } | null)?.context_usage;
  if (!ctx || typeof ctx !== "object") return null;
  const used = nonNegInt(ctx.total_tokens);
  if (used === null || used <= 0) return null;
  const limit = posInt(ctx.raw_max_tokens);
  const model = cleanModel(ctx.model);
  return { used, limit, ...(model ? { model } : {}) };
}

/**
 * Context window size and model from Claude Agent SDK's `getContextUsage({ detail: "summary" })`,
 * even before the first response (`totalTokens === 0`). Uses `rawMaxTokens` (the window Claude
 * Code itself measures percentage against), falling back to `maxTokens` when `rawMaxTokens` is absent.
 */
export function claudeControlContextWindow(response: unknown): { limit: number | null; model: string | null } {
  const res = response as { rawMaxTokens?: unknown; maxTokens?: unknown; model?: unknown } | null;
  if (!res || typeof res !== "object") return { limit: null, model: null };
  return {
    limit: posInt(res.rawMaxTokens) ?? posInt(res.maxTokens),
    model: cleanModel(res.model),
  };
}

/**
 * Context usage returned by Claude Agent SDK's `getContextUsage({ detail: "summary" })`.
 * Uses `rawMaxTokens` (the window Claude Code itself measures percentage against), falling back to
 * `maxTokens` when `rawMaxTokens` is absent.
 */
export function claudeControlContextUsage(response: unknown): ProjectContextUsage | null {
  const res = response as { totalTokens?: unknown; rawMaxTokens?: unknown; maxTokens?: unknown; model?: unknown } | null;
  if (!res || typeof res !== "object") return null;
  const used = nonNegInt(res.totalTokens);
  if (used === null || used <= 0) return null;
  const { limit, model } = claudeControlContextWindow(res);
  return { used, limit, ...(model ? { model } : {}) };
}

type ModelUsageEntry = { contextWindow?: unknown; canonicalModel?: unknown };

/**
 * Context window for the main model from Claude Code's `modelUsage` map (either on a `result`
 * message or a `cost-state` JSONL entry). Matches by exact key, `canonicalModel`, or base name
 * without `[1m]` suffix, and only falls back to a sole entry when `modelUsage` has a single model —
 * never misattributing a subagent model's (e.g. Haiku's 200k) window to the main model.
 */
export function claudeModelContextWindow(usage: unknown, model: string | null): number | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const entries = Object.entries(usage as Record<string, ModelUsageEntry>);
  if (entries.length === 0) return null;
  if (model) {
    const exact = (usage as Record<string, ModelUsageEntry>)[model];
    const exactSize = posInt(exact?.contextWindow);
    if (exactSize) return exactSize;
    const base = stripVariant(model);
    for (const [key, entry] of entries) {
      const size = posInt(entry?.contextWindow);
      if (!size) continue;
      if (cleanModel(entry?.canonicalModel) === model || stripVariant(key) === base) return size;
    }
  }
  if (entries.length === 1) return posInt(entries[0]![1]?.contextWindow);
  return null;
}

/** Context window reported in a Claude Code `result` message's `modelUsage`; null when absent. */
export function claudeResultContextWindow(result: unknown, model: string | null): number | null {
  return claudeModelContextWindow((result as { modelUsage?: unknown } | null)?.modelUsage, model);
}

/**
 * Context usage from Codex's `thread/tokenUsage/updated` notification: `last.totalTokens` (falling
 * back to `last.inputTokens`) for current occupancy, and `modelContextWindow` when Codex reports it.
 */
export function codexContextUsage(tokenUsage: unknown, model: string | null): ProjectContextUsage | null {
  const raw = tokenUsage as { last?: Record<string, unknown>; modelContextWindow?: unknown } | null;
  if (!raw?.last || typeof raw.last !== "object") return null;
  const used = posInt(raw.last.totalTokens) ?? posInt(raw.last.inputTokens);
  if (used === null) return null;
  const limit = posInt(raw.modelContextWindow);
  const clean = cleanModel(model);
  return { used, limit, ...(clean ? { model: clean } : {}) };
}

/**
 * Context usage from an ACP `session/update` with `sessionUpdate: "usage_update"` (`used` and
 * `size`, per ACP spec); null when `used` is missing or zero. Leaves `limit` null when `size` is
 * omitted rather than guessing.
 */
export function acpContextUsage(update: Record<string, unknown>, model: string | null): ProjectContextUsage | null {
  const used = nonNegInt(update.used);
  if (used === null || used <= 0) return null;
  const limit = posInt(update.size);
  const clean = cleanModel(model);
  return { used, limit, ...(clean ? { model: clean } : {}) };
}
