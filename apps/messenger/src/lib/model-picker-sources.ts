import {
  AGENT_KINDS,
  CLAUDE_MODEL_ALIASES,
  isAgentModelName,
  type AgentStatus,
  type AgentsStatusResponse,
  type BotRunner,
  type Provider,
} from "@real-bot/protocol";
import type { Copy } from "./copy.ts";
import { groupModels, type PickerRow, type PickerSource } from "./model-picker.ts";
import { agentSource, claudeAgentSource, endpointSource } from "./model-source.ts";
import { agentBlocker, agentModelsOf } from "./runner-choice.ts";

/**
 * Where a model picker's models come from (`model-picker.ts`), built the same way for every picker:
 * one source per endpoint, Claude Code, one per other local agent (ADR 0079). Each takes what a row's
 * value is in that picker; the rest — names, marks, groups, which agents can be picked — is here.
 */

/** The rows of an agent's or an endpoint's models, named as it lists them, its own id under a name that differs. */
function modelRows(models: ReadonlyArray<{ id: string; name?: string }>, valueOf: (id: string) => string, keep?: (id: string) => boolean): PickerRow[] {
  return models
    .filter((model) => !keep || keep(model.id))
    .map((model) => {
      const name = model.name?.trim() || model.id;
      return { value: valueOf(model.id), id: model.id, label: name, ...(name !== model.id ? { detail: model.id } : {}) };
    });
}

export type EndpointLike = Pick<Provider, "id" | "name" | "base_url" | "api_format" | "models">;

/** One source per endpoint that lists models, with its connector's logo, in the endpoints' order. */
export function endpointPickerSources(
  providers: readonly EndpointLike[],
  t: Copy,
  valueOf: (providerId: string, model: string) => string,
  keep?: (providerId: string, model: string) => boolean,
): PickerSource[] {
  return providers
    .map((provider): PickerSource => ({
      key: `endpoint:${provider.id}`,
      label: provider.name,
      mark: endpointSource(provider, t),
      groups: groupModels(modelRows(provider.models.map((id) => ({ id })), (id) => valueOf(provider.id, id), keep ? (id) => keep(provider.id, id) : undefined)),
    }))
    .filter((source) => source.groups.length > 0);
}

/** Claude Code's models (ADR 0061): the aliases it takes, in the order given. */
export function claudePickerSource(t: Copy, valueOf: (model: string) => string, models: readonly string[] = CLAUDE_MODEL_ALIASES): PickerSource {
  return {
    key: "agent:claude_code",
    label: t.claudeAgent.title,
    mark: claudeAgentSource(t),
    groups: [{ key: "", label: null, rows: models.map((model) => ({ value: valueOf(model), label: model })) }],
  };
}

/** An agent's name in a picker: its label, your own ACP agent's name. */
function agentName(status: AgentStatus): string {
  return status.label || AGENT_KINDS[status.runner].label;
}

/**
 * One source per local agent other than Claude Code (ADR 0079), with its logo: the models it lists,
 * grouped by provider when they are `provider/model` names. One that is not found or not signed in
 * is shown, greyed out with why, only when `blocked` asks for it; a name typed into the search is
 * taken as the agent spells it when `typed` is set.
 */
export function agentPickerSources(
  agents: AgentsStatusResponse | null,
  t: Copy,
  valueOf: (runner: BotRunner, model: string, customId: string | null) => string,
  options: { only?: { runner: BotRunner; customId: string | null } | null; blocked?: boolean; typed?: boolean; keep?: (runner: BotRunner, model: string, customId: string | null) => boolean } = {},
): PickerSource[] {
  const items = agents?.items ?? [];
  return items
    .filter((status) => status.runner !== "claude_code")
    .filter((status) => !options.only || (status.runner === options.only.runner && (status.custom_id ?? null) === (options.only.runner === "custom" ? options.only.customId : null)))
    .flatMap((status): PickerSource[] => {
      const blocker = agentBlocker(status);
      if (blocker && !options.blocked) return [];
      const customId = status.custom_id ?? null;
      const name = agentName(status);
      // What it lists, or only the model it names as its default when it lists none.
      const rows = modelRows(agentModelsOf(status), (id) => valueOf(status.runner, id, customId), options.keep ? (id) => options.keep!(status.runner, id, customId) : undefined);
      return [{
        key: `agent:${status.runner}${customId ? `:${customId}` : ""}`,
        label: name,
        mark: agentSource(status.runner, name),
        ...(blocker ? { disabled: true, note: blocker === "missing" ? t.sidebar.botRunnerAgentMissingShort : t.sidebar.botRunnerAgentSignedOutShort }
          : rows.length === 0 && options.typed ? { note: t.modelPicker.typeShort } : {}),
        groups: groupModels(rows),
        ...(options.typed && !blocker ? { custom: (typed: string) => (isAgentModelName(typed) ? valueOf(status.runner, typed, customId) : null) } : {}),
      }];
    });
}
