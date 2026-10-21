import { CLAUDE_EFFORTS, type ClaudeCodeModel, type PatchProjectSessionRequest } from "@real-bot/protocol";
import { effortChoices, modelChoices, modelRowOf, type Choice } from "../claude-models.svelte.ts";

/**
 * What a project session's runs go on (ADR 0095): its account, its model and its thinking level,
 * each '' for what your Claude Code settings say. The composer picks the three in one cascading
 * picker (`ProjectAgentTune.svelte`), since each depends on the one before it: an account lists its
 * own models, a model takes its own levels.
 */
export type AgentTune = { account: string; model: string; effort: string };

/** A picker row: a choice, what Claude Code says of it under its name, and whether it can be taken now. */
export type TuneRow = Choice & { detail?: string; disabled?: boolean };

/** The models an account lists, each with what Claude Code says of it; your settings' default first. */
export function modelRows(list: ClaudeCodeModel[] | null, current: string, defaultLabel: string, defaultHint: string): TuneRow[] {
  return modelChoices(list, current, defaultLabel).map((choice) => ({
    ...choice,
    detail: modelRowOf(list, choice.value)?.description || (choice.value ? undefined : defaultHint),
  }));
}

/** Whether a model has a thinking level to pick: one that takes none has none, unless one is set already. */
export function effortsShown(list: ClaudeCodeModel[] | null, model: string, current: string): boolean {
  return effortChoices(list, model).length > 0 || Boolean(current);
}

/** The levels a model takes, your settings' default first; one set already that it does not take stays a choice. */
export function effortRows(list: ClaudeCodeModel[] | null, model: string, current: string, defaultLabel: string, levels: Partial<Record<string, string>>): TuneRow[] {
  const values: string[] = [...effortChoices(list, model)];
  if (current && !values.includes(current)) values.push(current);
  return [{ value: "", label: defaultLabel }, ...values.map((level) => ({ value: level, label: levels[level] ?? level }))];
}

/** The level a session keeps on a model: its own, if the model takes it; else your settings' default. */
export function effortOn(list: ClaudeCodeModel[] | null, model: string, current: string): string {
  return !current || effortChoices(list, model).some((level) => level === current) ? current : "";
}

/**
 * What a pick changes, as one PATCH: the account, model and level along the picked path that
 * differ from the session's. A model picked without a level keeps the session's only if it takes
 * it (`list` is the picked account's). Null when nothing changes.
 */
export function tunePatch(now: AgentTune, picked: { account: string; model?: string; effort?: string }, list: ClaudeCodeModel[] | null): PatchProjectSessionRequest | null {
  const change: PatchProjectSessionRequest = {};
  if (picked.account !== now.account) change.config_dir = picked.account || null;
  if (picked.model !== undefined && picked.model !== now.model) {
    change.model = picked.model || null;
    if (picked.effort === undefined && effortOn(list, picked.model, now.effort) !== now.effort) change.effort = null;
  }
  if (picked.effort !== undefined && picked.effort !== now.effort) {
    change.effort = CLAUDE_EFFORTS.find((level) => level === picked.effort) ?? null;
  }
  return Object.keys(change).length > 0 ? change : null;
}
