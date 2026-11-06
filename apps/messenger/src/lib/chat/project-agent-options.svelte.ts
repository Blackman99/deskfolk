import { isClaudeEffort, type AgentsStatusResponse, type ClaudeCodeModel, type ClaudeCodeStatus } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { forgetClaudeModels, type Choice } from "../claude-models.svelte.ts";
import { agentStatusOf } from "../runner-choice.ts";

/**
 * What a composer's model picker offers besides Claude Code's models (`claude-models.svelte.ts`,
 * ADR 0095): your Claude accounts, and your other local agents with the models each lists — a Codex
 * session's (ADR 0099), a Bot's on one of them — each asked for once a page.
 */
const claude = $state<{ status: ClaudeCodeStatus | null; asked: boolean }>({ status: null, asked: false });
const agents = $state<{ list: AgentsStatusResponse | null; asked: boolean }>({ list: null, asked: false });

/** Asks for your Claude Code's accounts, once. */
export function loadClaudeStatus(api: MessengerApi | null): void {
  if (!api || claude.asked) return;
  claude.asked = true;
  Promise.resolve()
    .then(() => api.claudeCode())
    // Once a page, answered or not: a Mac that cannot say leaves the account picker out.
    .then(
      (status) => {
        claude.status = status;
      },
      () => {},
    );
}

export function claudeStatus(): ClaudeCodeStatus | null {
  return claude.status;
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

/** Asks for your local agents as the daemon last saw them, with the models each lists (`GET /v1/runtime/agents`), once. */
export function loadAgentsStatus(api: Pick<MessengerApi, "agents"> | null): void {
  if (!api || agents.asked) return;
  agents.asked = true;
  Promise.resolve()
    .then(() => api.agents())
    // Once a page, answered or not: a Mac that cannot say offers only each agent's own default.
    .then(
      (list) => {
        agents.list = list;
      },
      () => {},
    );
}

/** Your local agents once they came; null while asking, or when they could not be had. */
export function agentsStatus(): AgentsStatusResponse | null {
  return agents.list;
}

/**
 * Codex's models as the composer's picker reads them: each with the levels it takes. Empty until
 * they came, or when Codex lists none: the picker then offers only what your Codex settings say.
 */
export function codexModels(): ClaudeCodeModel[] {
  return (agentStatusOf(agents.list, "codex")?.models ?? []).map((model) => ({
    value: model.id, display_name: model.name, description: "", resolved_model: null, efforts: model.efforts.filter(isClaudeEffort),
  }));
}

/** Forgets every list and status asked for: another Mac, or a test starting clean. */
export function forgetClaudeOptions(): void {
  forgetClaudeModels();
  claude.status = null;
  claude.asked = false;
  agents.list = null;
  agents.asked = false;
}
