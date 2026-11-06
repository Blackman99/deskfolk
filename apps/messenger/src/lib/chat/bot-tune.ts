import {
  AGENT_KINDS,
  isClaudeEffort,
  isThinkingLevel,
  type AgentStatus,
  type Bot,
  type BotRunner,
  type ClaudeCodeModel,
  type ClaudeEffort,
  type PatchBotRequest,
  type PatchProjectSessionRequest,
  type Provider,
} from "@real-bot/protocol";
import { thinkingLevelLabel, type Copy } from "../copy.ts";
import { applyModelPin, pinnableThinkingLevels } from "../panels/create-form.ts";
import { agentModelsOf } from "../runner-choice.ts";
import { modelSelectValue } from "../settings/provider-form.ts";
import type { TuneLevel, TuneRow, TuneTree } from "./tune-picker.ts";

/**
 * What a Bot's direct picks in its composer (`BotTune.svelte`): the Bot's own model and thinking
 * level, the ones its profile sets, so a pick holds wherever the Bot works. A Bot on the app's own
 * loop picks an endpoint, one of its models and a level (`endpointTuneTree`); a Bot on a local
 * agent picks as a project session does (`AgentTune.svelte`), the agent's names put back into the
 * Bot's fields (`agentBotPatch`).
 */

type Endpoint = Pick<Provider, "id" | "name" | "models" | "model_catalog">;

/** The endpoint a Bot's pinned model is on: its own, else the first that lists the model; '' on automatic. */
export function pinnedEndpoint(bot: Pick<Bot, "model" | "provider_id">, providers: readonly Endpoint[]): string {
  if (!bot.model) return "";
  if (bot.provider_id) return bot.provider_id;
  return providers.find((provider) => provider.models.includes(bot.model!))?.id ?? "";
}

/** What the picker reads of a Bot on the app's own loop, each time it asks. */
export type EndpointTuneSource = {
  readonly t: Copy;
  readonly bot: Pick<Bot, "model" | "provider_id" | "thinking_level">;
  readonly providers: readonly Endpoint[];
  onpick(change: PatchBotRequest): void;
};

/**
 * A Bot on the app's own loop: automatic first (the app picks per message), then each endpoint that
 * lists models; an endpoint opens its models, a model the levels it takes. Picking a model picks a
 * level with it, as the profile does (`applyModelPin`): the Bot's own on its own model, else the one
 * it had if the model takes it, else that model's default.
 */
export function endpointTuneTree(source: EndpointTuneSource): TuneTree {
  const endpointLevel = (): TuneLevel => ({ key: "endpoint", heading: source.t.composer.tuneEndpoint, width: 240, details: true });
  const modelLevel = (): TuneLevel => ({ key: "model", heading: source.t.project.modelLabel, width: 290, details: true });
  const thinkingLevel = (): TuneLevel => ({ key: "thinking", heading: source.t.project.effortLabel, width: 140, leaf: true });
  const listing = () => source.providers.filter((provider) => provider.models.length > 0);
  const pin = () => pinnedEndpoint(source.bot, source.providers);
  const pinnedModel = () => source.bot.model ?? "";
  const levelsOf = (endpoint: string, model: string) => pinnableThinkingLevels(modelSelectValue(endpoint, model), source.providers);
  /** The level a model would run at, picked without one. */
  const kept = (endpoint: string, model: string): string =>
    endpoint === pin() && model === pinnedModel()
      ? (source.bot.thinking_level ?? "")
      : applyModelPin(modelSelectValue(endpoint, model), source.bot.thinking_level ?? "", source.providers).thinkingLevel;

  function modelRows(endpoint: string): TuneRow[] {
    const listed = source.providers.find((provider) => provider.id === endpoint)?.models ?? [];
    const rows: TuneRow[] = listed.map((model) => ({ value: model, label: model }));
    // A pin no endpoint lists any more (ADR 0048) stays where it was, marked, so it still reads.
    if (endpoint === pin() && pinnedModel() && !listed.includes(pinnedModel())) {
      rows.push({ value: pinnedModel(), label: pinnedModel(), detail: source.t.sidebar.botModelUnlisted });
    }
    return rows;
  }

  return {
    start: () => ({ endpoint: pin(), model: pinnedModel(), thinking: source.bot.thinking_level ?? "" }),
    levels: (focus) =>
      [endpointLevel(), focus.endpoint ? modelLevel() : null, focus.endpoint && focus.model ? thinkingLevel() : null].filter(
        (level): level is TuneLevel => level !== null,
      ),
    room: () => (listing().length > 0 ? [endpointLevel(), modelLevel(), thinkingLevel()] : [endpointLevel()]),
    rows: (level, focus) => {
      if (level === "endpoint") {
        return [
          { value: "", label: source.t.sidebar.botModelDefault, detail: source.t.composer.tuneAutomaticHint },
          ...listing().map((provider) => ({ value: provider.id, label: provider.name })),
        ];
      }
      if (level === "model") return modelRows(focus.endpoint ?? "");
      return levelsOf(focus.endpoint ?? "", focus.model ?? "").map((value) => ({
        value,
        label: thinkingLevelLabel(source.t.sidebar.thinkingLevels, value),
      }));
    },
    checked: (level, focus) => {
      if (level === "endpoint") return pin();
      if (level === "model") return focus.endpoint === pin() ? pinnedModel() : "";
      return kept(focus.endpoint ?? "", focus.model ?? "");
    },
    // Automatic is a pick; an endpoint opens its models, a model its levels.
    opensMore: (level, value, focus) =>
      level === "endpoint" ? value !== "" : level === "model" && levelsOf(focus.endpoint ?? "", value).length > 0,
    focusAt: (level, value, focus) => {
      if (level === "endpoint") {
        if (value === focus.endpoint) return focus;
        const model = value === pin() ? pinnedModel() : "";
        return { endpoint: value, model, thinking: model ? kept(value, model) : "" };
      }
      if (level === "model") return value === focus.model ? focus : { ...focus, model: value, thinking: kept(focus.endpoint ?? "", value) };
      return value === focus.thinking ? focus : { ...focus, thinking: value };
    },
    commit: (level, focus) => {
      const change = endpointPatch(source.bot, source.providers, {
        endpoint: focus.endpoint ?? "",
        model: focus.model ?? "",
        thinking: level === "thinking" ? (focus.thinking ?? "") : undefined,
      });
      if (change) source.onpick(change);
    },
  };
}

/**
 * What a pick changes on a Bot on the app's own loop, as one PATCH; null when nothing does. No
 * endpoint is automatic: model, endpoint and level all go. A model picked without a level takes the
 * one it would run at (`applyModelPin`).
 */
export function endpointPatch(
  bot: Pick<Bot, "model" | "provider_id" | "thinking_level">,
  providers: readonly Endpoint[],
  picked: { endpoint: string; model: string; thinking?: string },
): PatchBotRequest | null {
  if (!picked.endpoint) return bot.model ? { model: null, provider_id: null, thinking_level: null } : null;
  if (!picked.model) return null;
  const same = picked.endpoint === pinnedEndpoint(bot, providers) && picked.model === bot.model;
  const thinking =
    picked.thinking ?? (same ? (bot.thinking_level ?? "") : applyModelPin(modelSelectValue(picked.endpoint, picked.model), bot.thinking_level ?? "", providers).thinkingLevel);
  if (same && thinking === (bot.thinking_level ?? "")) return null;
  return { model: picked.model, provider_id: picked.endpoint, thinking_level: isThinkingLevel(thinking) ? thinking : null };
}

/** What the closed picker says of a Bot on the app's own loop. */
export function endpointTuneLabels(
  t: Copy,
  bot: Pick<Bot, "model" | "provider_id" | "thinking_level">,
  providers: readonly (Endpoint & Pick<Provider, "base_url" | "api_format">)[],
): { value: string; level: string | null; aside: string | null; endpoint: (Endpoint & Pick<Provider, "base_url" | "api_format">) | null; title: string } {
  if (!bot.model) {
    return { value: t.sidebar.botModelDefault, level: null, aside: null, endpoint: null, title: `${t.sidebar.botModelDefault} · ${t.composer.tuneAutomaticHint}` };
  }
  const endpointId = pinnedEndpoint(bot, providers);
  const endpoint = providers.find((provider) => provider.id === endpointId) ?? null;
  const listed = endpoint?.models.includes(bot.model) ?? false;
  const level = bot.thinking_level ? thinkingLevelLabel(t.sidebar.thinkingLevels, bot.thinking_level) : null;
  // The endpoint after the model, quieter, once there is more than one to tell apart.
  const many = providers.filter((provider) => provider.models.length > 0).length > 1;
  return {
    value: bot.model,
    level,
    aside: many && endpoint ? endpoint.name : null,
    endpoint,
    title: [endpoint?.name, listed ? bot.model : `${bot.model} · ${t.sidebar.botModelUnlisted}`, level].filter(Boolean).join("\n"),
  };
}

/**
 * An agent's models as the agent picker (`AgentTune.svelte`) reads them, for a Bot on a local agent
 * other than Claude: what it lists, each with the levels it takes — its own when it names them,
 * else every level the agent takes — and, under `default`, the levels its default model takes. A
 * model set elsewhere that it does not list is kept as a row, so no row falls back to Claude's levels.
 */
export function agentTuneModels(status: AgentStatus | null, runner: BotRunner, current: string, defaultLabel: string): ClaudeCodeModel[] {
  const takes = AGENT_KINDS[runner].efforts.filter(isClaudeEffort);
  const levels = (own: readonly string[]): ClaudeEffort[] => (own.length > 0 ? own.filter((level): level is ClaudeEffort => takes.some((taken) => taken === level)) : [...takes]);
  const row = (value: string, name: string, own: readonly string[] = []): ClaudeCodeModel => ({
    value,
    display_name: name,
    description: "",
    resolved_model: null,
    efforts: levels(own),
  });
  const listed = agentModelsOf(status);
  const rows = [row("default", defaultLabel), ...listed.map((model) => row(model.id, model.name || model.id, model.efforts))];
  if (current && current !== "default" && !listed.some((model) => model.id === current)) rows.push(row(current, current));
  return rows;
}

/** What an agent pick changes on a Bot: the picker's change, by the Bot's own names for it. */
export function agentBotPatch(change: PatchProjectSessionRequest): PatchBotRequest {
  const patch: PatchBotRequest = {};
  if (change.config_dir !== undefined) patch.agent_config_dir = change.config_dir;
  if (change.model !== undefined) patch.agent_model = change.model;
  if (change.effort !== undefined) patch.agent_effort = change.effort;
  return patch;
}
