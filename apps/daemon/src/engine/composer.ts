/**
 * The ✨ button: a short, cheap call on a light model that drafts what the user might send next.
 * Nothing here posts to the transcript — a suggestion is only ever shown in the composer, and
 * typing again aborts the request before it is used.
 */
import { USER_MEMBER, type ComposerSuggestion } from "@real-bot/protocol";
import { composerAnswerReadable, parseComposerSuggestions } from "../composer-suggestions";
import type { CompletionsClient } from "../completions";
import { assembleComposerSuggestUser } from "../context";
import { resolveCompletionTarget } from "../models";
import { promptPage } from "../prompts/book";
import type { Store } from "../store";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { CallTarget, Creds } from "./types";

export type ComposerDeps = {
  store: Store;
  completions: CompletionsClient;
  credentials: Routing["credentials"];
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  spendOwner: SpendTracker["spendOwner"];
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
    const target: CallTarget = {
      providerId: provider.id,
      providerName: provider.name,
      model: lightModel,
      thinkingLevel: null,
    };
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
      result = await completions.judge({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: lightModel,
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
    recordResponseSpend({
      kind: "composer_suggest",
      owner: owned,
      target,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
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
