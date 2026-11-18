// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 578ee444112d00bd
import { deep } from "../../lib/reactive";
import { isClaudeEffort, type AgentsStatusResponse, type BotRunner, type ClaudeCodeModel, type ClaudeCodeStatus } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { forgetClaudeModels, reloadClaudeModels, type Choice } from "../claude-models.svelte.ts";
import { agentStatusOf } from "../runner-choice.ts";

/**
 * What a composer's model picker offers besides Claude Code's models (`claude-models.svelte.ts`,
 * ADR 0095): your Claude accounts, and your other local agents with the models each lists — a Codex
 * session's (ADR 0099), a Bot's on one of them. Each is asked for when a composer first needs it,
 * and again when a picker opens or a composer shows after the answer has aged (`OPTIONS_FRESH_MS`):
 * you may have signed in with another account meanwhile, in a terminal.
 */
/** How old an answer may be before the next picker or composer asks again; the daemon keeps its own a minute too. */
export const OPTIONS_FRESH_MS = 30_000;

const claude = deep<{ status: ClaudeCodeStatus | null }>({ status: null });
const agents = deep<{ list: AgentsStatusResponse | null }>({ list: null });
/** When each was last answered (or failed), whether an ask is out, and the forgetting it belongs to. */
type Asked = { at: number | null; out: boolean };
const asks: { claude: Asked; agents: Asked; generation: number } = { claude: { at: null, out: false }, agents: { at: null, out: false }, generation: 0 };

/** Never asked, or answered long enough ago, and no ask out. */
function due(asked: Asked): boolean {
  return !asked.out && (asked.at === null || Date.now() - asked.at >= OPTIONS_FRESH_MS);
}

/**
 * Asks for your Claude Code's accounts, unless they were had a moment ago. What was had stays shown
 * while asking, and when the ask fails; a Mac that never says leaves the account picker out. A
 * directory signed in as another account has its models asked for again.
 */
export function loadClaudeStatus(api: MessengerApi | null): void {
  if (!api || !due(asks.claude)) return;
  asks.claude.out = true;
  const generation = asks.generation;
  Promise.resolve()
    .then(() => api.claudeCode())
    .then(
      (status) => {
        if (generation !== asks.generation) return;
        const before = claude.status;
        claude.status = status;
        for (const dir of changedAccounts(before, status)) reloadClaudeModels(api, dir);
      },
      () => {},
    )
    .finally(() => {
      if (generation === asks.generation) asks.claude = { at: Date.now(), out: false };
    });
}

/** Who an account is: the same directory signed in as someone else, or on another plan, is another account. */
function accountKey(status: ClaudeCodeStatus, dir: string | null): string {
  const account = status.accounts?.find((entry) => entry.config_dir === dir);
  const email = account?.email ?? (dir === null ? (status.email ?? null) : null);
  return JSON.stringify([account?.logged_in ?? null, account?.auth_method ?? null, account?.subscription_type ?? null, email]);
}

/** The account directories (null: this computer's own) signed in as another account than before; none on the first answer. */
export function changedAccounts(before: ClaudeCodeStatus | null, after: ClaudeCodeStatus): Array<string | null> {
  if (!before) return [];
  const dirs = new Set<string | null>([null, ...(after.accounts ?? []).map((account) => account.config_dir)]);
  return [...dirs].filter((dir) => accountKey(before, dir) !== accountKey(after, dir));
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

/**
 * Asks for your local agents as the daemon last saw them, with the models each lists
 * (`GET /v1/runtime/agents`), unless they were had a moment ago. What was had stays shown while
 * asking, and when the ask fails; a Mac that never says offers only each agent's own default.
 */
export function loadAgentsStatus(api: Pick<MessengerApi, "agents"> | null): void {
  if (!api || !due(asks.agents)) return;
  asks.agents.out = true;
  const generation = asks.generation;
  Promise.resolve()
    .then(() => api.agents())
    .then(
      (list) => {
        if (generation === asks.generation) agents.list = list;
      },
      () => {},
    )
    .finally(() => {
      if (generation === asks.generation) asks.agents = { at: Date.now(), out: false };
    });
}

/** Your local agents once they came; null while asking, or when they could not be had. */
export function agentsStatus(): AgentsStatusResponse | null {
  return agents.list;
}

/**
 * An agent's own models as the composer's picker reads them (Codex, ADR 0099, and every agent but
 * Claude Code, whose list is its own): each with the levels it takes. Empty until they came, or
 * when the agent lists none: the picker then offers only what your settings for it say.
 */
export function agentModels(runner: BotRunner): ClaudeCodeModel[] {
  return (agentStatusOf(agents.list, runner)?.models ?? []).map((model) => ({
    value: model.id, display_name: model.name, description: "", resolved_model: null, efforts: model.efforts.filter(isClaudeEffort),
  }));
}

/** Forgets every list and status asked for: another Mac, or a test starting clean. */
export function forgetClaudeOptions(): void {
  forgetClaudeModels();
  claude.status = null;
  agents.list = null;
  asks.claude = { at: null, out: false };
  asks.agents = { at: null, out: false };
  asks.generation++;
}
