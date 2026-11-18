import { connectorFor, type ApiFormat, type BotRunner, type ConnectorId, type Provider, type SpeechPresetId } from "@real-bot/protocol";
import type { Copy } from "./copy.ts";
import type { SelectOption } from "./select-options.ts";

/**
 * A vendor whose logo the app draws (`settings/ConnectorLogo.svelte`): a built-in connector's
 * (ADR 0072), or a speech service's (ADR 0073) that is not a connector.
 */
export type VendorId = ConnectorId | "openai" | "groq" | "siliconflow" | "deepgram" | "elevenlabs";

/**
 * Where a model in a picker comes from, drawn in front of its name: a built-in connector's endpoint
 * (ADR 0072) shows that vendor's logo, a model run through your own Claude Code (ADR 0061) the
 * Claude spark, and any other endpoint "Custom". It is read from the endpoint's address each time,
 * as the endpoint card does, so a connector added to the protocol shows in every picker without
 * touching any of them. A speech service (ADR 0073) is marked the same way, by its vendor. A model
 * run through any other local agent of yours (ADR 0079) wears that agent's logo (`AgentLogo.svelte`;
 * an ACP agent of your own a plain prompt glyph). `name` is what the mark stands for, for its tooltip.
 */
export type ModelSource =
  | { kind: "connector"; id: ConnectorId; name: string }
  | { kind: "vendor"; id: VendorId; name: string }
  | { kind: "claude-agent"; name: string }
  | { kind: "agent"; runner: BotRunner; name: string }
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

/** A model run by one of your local agents other than Claude Code (ADR 0079): its logo, its name for the tooltip. */
export function agentSource(runner: BotRunner, name: string): ModelSource {
  return { kind: "agent", runner, name };
}

/** The mark of whatever runs a Bot's turns: Claude's spark for Claude Agent, the agent's logo for the rest. */
export function runnerSource(runner: BotRunner, name: string, t: Copy): ModelSource {
  return runner === "claude_code" ? claudeAgentSource(t) : agentSource(runner, name);
}

/**
 * Whose logo each speech service wears. Keyed by every service, so one added to the protocol
 * without a vendor here fails the type check. Alibaba Bailian's wear the Qwen connector's, as the
 * Bailian endpoint whose key they can take does, and Xiaomi MiMo the Xiaomi connector's; Custom is
 * any address, so it is marked Custom.
 */
const SPEECH_VENDOR: Record<SpeechPresetId, VendorId | null> = {
  openai: "openai",
  groq: "groq",
  siliconflow: "siliconflow",
  bailian: "qwen",
  bailian_token_plan: "qwen",
  xiaomi: "xiaomi",
  deepgram: "deepgram",
  elevenlabs: "elevenlabs",
  custom: null,
};

export function speechServiceSource(id: SpeechPresetId, t: Copy): ModelSource {
  const vendor = SPEECH_VENDOR[id];
  return vendor ? { kind: "vendor", id: vendor, name: t.speech.presets[id] } : { kind: "custom", name: t.connectors.customMark };
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
