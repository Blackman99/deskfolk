import { connectorFor, type ApiFormat, type ConnectorId, type Provider } from "@real-bot/protocol";
import type { Copy } from "./copy.ts";
import type { SelectOption } from "./select-options.ts";

/**
 * Where a model in a picker comes from, drawn in front of its name: a built-in connector's endpoint
 * (ADR 0072) shows that vendor's logo, a model run through your own Claude Code (ADR 0061) the
 * Claude spark, and any other endpoint "Custom". It is read from the endpoint's address each time,
 * as the endpoint card does, so a connector added to the protocol shows in every picker without
 * touching any of them. `name` is what the mark stands for, for its tooltip.
 */
export type ModelSource =
  | { kind: "connector"; id: ConnectorId; name: string }
  | { kind: "claude-agent"; name: string }
  | { kind: "custom"; name: string };

export function endpointSource(
  endpoint: { base_url: string | null; api_format?: ApiFormat },
  t: Copy,
): ModelSource {
  const builtIn = connectorFor(endpoint.base_url, endpoint.api_format);
  return builtIn
    ? { kind: "connector", id: builtIn.connector.id, name: t.connectors.name[builtIn.connector.id] }
    : { kind: "custom", name: t.connectors.customMark };
}

export function claudeAgentSource(t: Copy): ModelSource {
  return { kind: "claude-agent", name: t.claudeAgent.title };
}

/**
 * Every model the endpoints list, as one picker offers it: the model's name, its endpoint's name
 * beside it once there is more than one endpoint, and where it comes from. Every model picker builds
 * its rows here, so they read the same everywhere; only what a row's value is differs.
 */
export function endpointModelOptions(
  providers: readonly Pick<Provider, "id" | "name" | "base_url" | "api_format" | "models">[],
  t: Copy,
  valueOf: (providerId: string, model: string) => string,
): SelectOption[] {
  return providers.flatMap((provider) => {
    const source = endpointSource(provider, t);
    const hint = providers.length > 1 ? provider.name : undefined;
    return provider.models.map((model) => ({ value: valueOf(provider.id, model), label: model, hint, source }));
  });
}
