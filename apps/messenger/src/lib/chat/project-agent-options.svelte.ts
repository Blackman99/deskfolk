import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, type ClaudeCodeModel, type ClaudeCodeModelList, type ClaudeCodeStatus, type ClaudeEffort } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";

/**
 * What a project session's composer offers (ADR 0095): the models your Claude Code lists for the
 * session's account, as its own `/model` does, the thinking levels the picked model takes, and your
 * Claude accounts. The lists are asked for once a page per account; the daemon keeps its answers too.
 */
type ModelsState = ClaudeCodeModelList | "loading" | "failed";

const models = $state<Record<string, ModelsState>>({});
const claude = $state<{ status: ClaudeCodeStatus | null; asked: boolean }>({ status: null, asked: false });

/** Asks for an account's models, once. */
export function loadClaudeModels(api: MessengerApi | null, configDir: string | null): void {
  const key = configDir ?? "";
  if (!api || models[key]) return;
  models[key] = "loading";
  // A Mac from before the list answers 404: the aliases stand in.
  Promise.resolve()
    .then(() => api.claudeCodeModels(configDir))
    .then(
      (list) => (models[key] = list.models.length ? list : "failed"),
      () => (models[key] = "failed"),
    );
}

/** The account's models once they came; null while asking, or when they could not be had. */
export function claudeModelsOf(configDir: string | null): ClaudeCodeModel[] | null {
  const state = models[configDir ?? ""];
  return state && typeof state === "object" ? state.models : null;
}

/** Asks for your Claude Code's accounts, once. */
export function loadClaudeStatus(api: MessengerApi | null): void {
  if (!api || claude.asked) return;
  claude.asked = true;
  Promise.resolve()
    .then(() => api.claudeCode())
    // Once a page, answered or not: a Mac that cannot say leaves the account picker out.
    .then(
      (status) => (claude.status = status),
      () => {},
    );
}

export function claudeStatus(): ClaudeCodeStatus | null {
  return claude.status;
}

export type Choice = { value: string; label: string };

/**
 * The model picker: Claude Code's own rows, its `default` first as the session's no-pick (the
 * empty value: your settings decide). Before the list comes, or when it cannot, Claude Code's
 * aliases. A model set elsewhere that the list lacks stays a choice.
 */
export function modelChoices(list: ClaudeCodeModel[] | null, current: string, defaultLabel: string): Choice[] {
  const choices: Choice[] = list
    ? [
        { value: "", label: list.find((row) => row.value === "default")?.display_name ?? defaultLabel },
        ...list.filter((row) => row.value !== "default").map((row) => ({ value: row.value, label: row.display_name })),
      ]
    : [{ value: "", label: defaultLabel }, ...CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias }))];
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

/**
 * Your Claude accounts, by the email each signs in with, short enough for the composer: this
 * computer's own first (the empty value), then each one listed in Settings.
 */
export function accountChoices(status: ClaudeCodeStatus | null, current: string, defaultLabel: string): Choice[] {
  const ownEmail = status?.accounts?.find((account) => account.config_dir === null)?.email ?? status?.email ?? null;
  const choices: Choice[] = [{ value: "", label: ownEmail ?? defaultLabel }];
  for (const account of status?.accounts ?? []) {
    if (account.config_dir) choices.push({ value: account.config_dir, label: account.email ?? account.config_dir });
  }
  if (current && !choices.some((choice) => choice.value === current)) choices.push({ value: current, label: current });
  return choices;
}

/** Forgets every list and status asked for: another Mac, or a test starting clean. */
export function forgetClaudeOptions(): void {
  for (const key of Object.keys(models)) delete models[key];
  claude.status = null;
  claude.asked = false;
}
