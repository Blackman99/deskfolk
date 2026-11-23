/**
 * Context window usage helpers for project sessions: extracts current prompt occupancy and window
 * size from each agent's native protocol messages, falling back to known model window sizes only
 * when the agent does not report its own `contextWindow` / `size`.
 */
import type { ProjectContextUsage } from "@real-bot/protocol";
import { normalizeAgentModel } from "./agent-prices";

/** Known context windows (in tokens) for models whose agent does not always report a window size. */
const KNOWN_CONTEXT_WINDOWS: ReadonlyArray<[RegExp, number]> = [
  [/\[1m\]/i, 1_000_000],
  [/^claude-/i, 200_000],
  [/^gemini-/i, 1_000_000],
  [/^gpt-5\./i, 400_000],
  [/^gpt-6/i, 400_000],
  [/^o[134](?:-|$)/i, 200_000],
  [/^grok-4\.\d+-build-fast/i, 2_000_000],
  [/^grok-4/i, 256_000],
];

/** Fallback context window for a model name when the agent did not report one; null when unknown. */
export function agentContextWindow(model: string | null | undefined): number | null {
  if (!model || !model.trim()) return null;
  const raw = model.trim();
  if (/\[1m\]/i.test(raw)) return 1_000_000;
  const key = normalizeAgentModel(raw);
  for (const [pattern, size] of KNOWN_CONTEXT_WINDOWS) {
    if (pattern.test(key)) return size;
  }
  return null;
}

const posInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);
const nonNegInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/**
 * Total prompt tokens of one Claude Code `assistant` message (`input_tokens + cache_read + cache_creation`),
 * which reflects the actual context window occupancy of that API call; null when absent or zero.
 */
export function claudeAssistantPromptTokens(message: unknown): number | null {
  const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const total = (nonNegInt(usage.input_tokens) ?? 0) + (nonNegInt(usage.cache_read_input_tokens) ?? 0) + (nonNegInt(usage.cache_creation_input_tokens) ?? 0);
  return total > 0 ? total : null;
}

/**
 * Context window reported in a Claude Code `result` message's `modelUsage`, preferring the session's
 * main model; null when absent.
 */
export function claudeResultContextWindow(result: unknown, model: string | null): number | null {
  const usage = (result as { modelUsage?: Record<string, { contextWindow?: unknown }> } | null)?.modelUsage;
  if (!usage || typeof usage !== "object") return null;
  if (model && usage[model]) {
    const exact = posInt(usage[model].contextWindow);
    if (exact) return exact;
  }
  for (const entry of Object.values(usage)) {
    const size = posInt(entry?.contextWindow);
    if (size) return size;
  }
  return null;
}

/**
 * Context usage from an ACP `session/update` with `sessionUpdate: "usage_update"` (`used` and
 * `size`, per ACP spec); null when `used` is missing or not a valid number.
 */
export function acpContextUsage(update: Record<string, unknown>, model: string | null): ProjectContextUsage | null {
  const used = nonNegInt(update.used);
  if (used === null || used <= 0) return null;
  const limit = posInt(update.size) ?? agentContextWindow(model);
  return { used, limit, ...(model ? { model } : {}) };
}
