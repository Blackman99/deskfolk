import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { forgetClaudeModels, type Choice } from "../claude-models.svelte.ts";

/**
 * What a project session's composer offers besides the models (`claude-models.svelte.ts`, ADR 0095):
 * your Claude accounts, asked for once a page.
 */
const claude = $state<{ status: ClaudeCodeStatus | null; asked: boolean }>({ status: null, asked: false });

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

/** Forgets every list and status asked for: another Mac, or a test starting clean. */
export function forgetClaudeOptions(): void {
  forgetClaudeModels();
  claude.status = null;
  claude.asked = false;
}
