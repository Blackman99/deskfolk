import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, type ClaudeCodeModel, type ClaudeCodeModelList, type ClaudeEffort } from "@real-bot/protocol";
import type { MessengerApi } from "./messenger-api.ts";

/**
 * The models your Claude Code lists for an account, as its own `/model` does (ADR 0095), and the
 * thinking levels each takes: what every picker of a Claude model offers — a project session's, a
 * Bot's, the setup's, Settings' and a ticket's. The lists are asked for once a page per account; the
 * daemon keeps its answers too.
 */
type ModelsState = ClaudeCodeModelList | "loading" | "failed";

const models = $state<Record<string, ModelsState>>({});

/** Asks for an account's models, once. */
export function loadClaudeModels(api: Pick<MessengerApi, "claudeCodeModels"> | null, configDir: string | null): void {
  const key = configDir ?? "";
  if (!api || models[key]) return;
  models[key] = "loading";
  // A Mac from before the list answers 404: the aliases stand in.
  Promise.resolve()
    .then(() => api.claudeCodeModels(configDir))
    .then(
      (list) => {
        models[key] = Array.isArray(list?.models) && list.models.length ? list : "failed";
      },
      () => {
        models[key] = "failed";
      },
    );
}

/** The account's models once they came; null while asking, or when they could not be had. */
export function claudeModelsOf(configDir: string | null): ClaudeCodeModel[] | null {
  const state = models[configDir ?? ""];
  return state && typeof state === "object" ? state.models : null;
}

export type Choice = { value: string; label: string };

/**
 * The models to pick from, by the names Claude Code gives them: its own rows but `default` (each
 * picker says what no pick means), or, before the list comes or when it cannot, its aliases.
 */
export function claudeModelOptions(list: ClaudeCodeModel[] | null): Choice[] {
  return list
    ? list.filter((row) => row.value !== "default").map((row) => ({ value: row.value, label: row.display_name }))
    : CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias }));
}

/**
 * The model picker: Claude Code's own rows, its `default` first as the session's no-pick (the
 * empty value: your settings decide). Before the list comes, or when it cannot, Claude Code's
 * aliases. A model set elsewhere that the list lacks stays a choice.
 */
export function modelChoices(list: ClaudeCodeModel[] | null, current: string, defaultLabel: string): Choice[] {
  const choices: Choice[] = [
    { value: "", label: list?.find((row) => row.value === "default")?.display_name ?? defaultLabel },
    ...claudeModelOptions(list),
  ];
  if (current && !choices.some((choice) => choice.value === current)) choices.push({ value: current, label: current });
  return choices;
}

/** The row a session's model stands for: its own value, or the full id one of them resolves to. */
export function modelRowOf(list: ClaudeCodeModel[] | null, model: string): ClaudeCodeModel | null {
  if (!list) return null;
  const wanted = model || "default";
  return list.find((row) => row.value === wanted) ?? list.find((row) => row.resolved_model === wanted) ?? null;
}

/** The thinking levels the picked model takes: all of them until the list says otherwise. */
export function effortChoices(list: ClaudeCodeModel[] | null, model: string): readonly ClaudeEffort[] {
  return modelRowOf(list, model)?.efforts ?? CLAUDE_EFFORTS;
}

/** Forgets every list asked for: another Mac, or a test starting clean. */
export function forgetClaudeModels(): void {
  for (const key of Object.keys(models)) delete models[key];
}
