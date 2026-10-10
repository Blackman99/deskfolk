/**
 * The ✨ button: a short, cheap call on a light model that drafts what the user might send next —
 * the composer's model when you chose one (ADR 0077), an endpoint's or a Claude model of yours.
 * Nothing here posts to the transcript — a suggestion is only ever shown in the composer, and
 * typing again aborts the request before it is used.
 */
import { USER_MEMBER, type ComposerSuggestion } from "@real-bot/protocol";
import { composerAnswerReadable, parseComposerSuggestions } from "../composer-suggestions";
import type { ClaudeJudge } from "../claude-code/reading";
import type { CompletionsClient } from "../completions";
import { assembleComposerSuggestUser } from "../context/judgement";
import { resolveCompletionTarget } from "../models";
import { promptPage } from "../prompts/book";
import type { Store } from "../store";
import { recordSideSpend, sideJudge, spentOf, type BuiltinTarget, type BuiltinTargetOf } from "./builtin-models";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { Creds } from "./types";

export type ComposerDeps = {
  store: Store;
  completions: CompletionsClient;
  credentials: Routing["credentials"];
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  recordClaudeSpend?: SpendTracker["recordClaudeSpend"];
  spendOwner: SpendTracker["spendOwner"];
  /** The composer's model, when you chose one (ADR 0077). */
  builtinTarget?: BuiltinTargetOf;
  claudeJudge?: ClaudeJudge | null;
};

export type Composer = {
  suggestComposer: (sessionId: string, signal?: AbortSignal, guard?: () => void) => Promise<ComposerSuggestion[]>;
};

export function createComposer(deps: ComposerDeps): Composer {
  const { store, completions, credentials, recordResponseSpend, spendOwner } = deps;

  async function suggestComposer(
    sessionId: string,
    signal: AbortSignal = new AbortController().signal,
    guard?: () => void,
  ): Promise<ComposerSuggestion[]> {
    store.getSession(sessionId);
    // These draft what the user would send; in a Bot↔Bot direct they have nothing to draft.
    if (!store.isPresent(sessionId, USER_MEMBER)) return [];
    if (signal.aborted) return [];
    const chosen = (await deps.builtinTarget?.("composer").catch(() => null)) ?? null;
    let target: BuiltinTarget;
    if (chosen) {
      if (signal.aborted) return [];
      guard?.();
      target = chosen;
    } else {
      let creds: Creds | null;
      try {
        creds = await credentials();
      } catch {
        return [];
      }
      if (!creds || signal.aborted) return [];
      guard?.();
      const resolved = resolveCompletionTarget(creds.providers, {
        botModel: null,
        botProviderId: null,
        defaultProviderId: creds.defaultProviderId,
      });
      if (!resolved) return [];
      const provider = creds.providers.find((row) => row.id === resolved.providerId);
      if (!provider) return [];
      const lightModel =
        provider.models.find((name) => /flash|mini|lite|fast/i.test(name)) ?? resolved.model;
      target = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiFormat: provider.apiFormat,
        workspaceId: provider.workspaceId,
        providerId: provider.id,
        providerName: provider.name,
        model: lightModel,
        thinkingLevel: null,
      };
    }
    const owned = spendOwner(sessionId, null);
    let user: string;
    try {
      user = assembleComposerSuggestUser(store, sessionId);
    } catch {
      return [];
    }
    const prompt = promptPage(store, "zh").resolve("call.composer");
    let result;
    try {
      result = await sideJudge({ completions, claudeJudge: deps.claudeJudge }, target, {
        prompt: prompt.ref,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: user },
        ],
        signal,
        // Someone pressed ✨ and is watching it spin. 8s suited the silent fetch this used to
        // be; a thinking "flash" model takes 3-8s, so a press often came back empty.
        timeoutMs: 20_000,
      });
    } catch {
      return [];
    }
    // Typing again aborts the request, but a body that already came back was paid for.
    recordSideSpend(
      {
        callOf: ({ providerId, providerName, model, thinkingLevel }) => ({ providerId, providerName, model, thinkingLevel }),
        recordResponseSpend,
        recordClaudeSpend: deps.recordClaudeSpend ?? (() => null),
      },
      { kind: "composer_suggest", owner: owned, target, ...spentOf(result) },
    );
    if (signal.aborted) return [];
    if (result.failKind || result.hadToolCalls) return [];
    if (!composerAnswerReadable(result.content ?? "")) {
      store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable", sessionId });
      return [];
    }
    const roster = store
      .presentBotIds(sessionId)
      .map((id) => {
        try {
          return store.getBot(id).name;
        } catch {
          return null;
        }
      })
      .filter((name): name is string => Boolean(name));
    return parseComposerSuggestions(result.content ?? "", roster);
  }

  return { suggestComposer };
}
