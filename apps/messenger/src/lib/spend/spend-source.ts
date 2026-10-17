import { AGENT_KINDS, connectorFor, type BotRunner, type Provider } from "@real-bot/protocol";
import type { ModelSource } from "../model-source.ts";

const RUNNER_BY_LABEL = new Map(Object.values(AGENT_KINDS).map((kind) => [kind.label, kind.runner] as const));

/**
 * Where a spend row's model ran, for the mark in front of it. A local agent's call is written with
 * no endpoint and the agent's name (`Claude Agent`, `Codex`, …; an ACP agent of your own its own
 * name), so it wears that agent's logo. An endpoint's call wears its vendor's logo, read from the
 * endpoint's address as the pickers do; one of no known vendor, or one since deleted, a plain tile.
 * A row with neither, an unrecorded model, has no mark.
 */
export function spendSource(
  providerId: string | null | undefined,
  providerName: string | null | undefined,
  providers: readonly Pick<Provider, "id" | "base_url" | "api_format">[],
): ModelSource | null {
  if (!providerId) {
    if (!providerName) return null;
    const runner: BotRunner = RUNNER_BY_LABEL.get(providerName) ?? "custom";
    return runner === "claude_code" ? { kind: "claude-agent", name: providerName } : { kind: "agent", runner, name: providerName };
  }
  const name = providerName ?? providerId;
  const provider = providers.find((row) => row.id === providerId);
  const builtIn = provider ? connectorFor(provider.base_url, provider.api_format) : null;
  return builtIn ? { kind: "connector", id: builtIn.connector.id, name } : { kind: "custom", name };
}
