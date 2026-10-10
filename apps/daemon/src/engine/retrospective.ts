/**
 * Runs the retrospective (ADR 0062) from the scheduler's tick: one due delivery and Bot at a time,
 * on the retrospective's model when you chose one (ADR 0077), else on the Bot's own (its pin, its
 * default, the endpoint's default — the level-7 decision with no turn), billed as `organize` with
 * the `retrospect` purpose. The store decides what is due and
 * writes what the answer becomes; this only makes the call. The changes reach the window through
 * the store's own change journal (memories, skills, and the plan the retrospective is shown on).
 */
import { parseRetrospective } from "../store/retrospectives";
import type { ClaudeJudge } from "../claude-code/reading";
import type { CompletionsClient } from "../completions";
import { retrospectivePayload } from "../prompts/retrospective";
import { promptPage, type PromptUse } from "../prompts/book";
import type { Store } from "../store";
import { recordSideSpend, sideJudge, spentOf, type BuiltinTargetOf } from "./builtin-models";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";

/** How long one retrospective may take: it reads a whole job and may rewrite a passage of a skill. */
const RETROSPECT_TIMEOUT_MS = 240_000;
/** Room for the findings and a few edits, with the model's own reasoning on top where it counts toward the cap. */
const RETROSPECT_MAX_TOKENS = 12_000;

export type Retrospector = { retrospect: (at: Date) => void };

export function createRetrospector(deps: {
  store: Store;
  completions: CompletionsClient;
  routing: Pick<Routing, "credentials" | "decideRoute">;
  spend: SpendTracker;
  track: <T>(promise: Promise<T>) => Promise<T>;
  /** The retrospective's model when you chose one (ADR 0077). */
  builtinTarget?: BuiltinTargetOf;
  claudeJudge?: ClaudeJudge | null;
}): Retrospector {
  let running = false;

  async function run(at: Date): Promise<void> {
    // No model at all, nothing claimed: what is due waits for one rather than failing for good. A
    // Claude model you chose needs no endpoint.
    const chosen = (await deps.builtinTarget?.("retrospective").catch(() => null)) ?? null;
    const creds = await deps.routing.credentials().catch(() => null);
    if (!creds && !chosen) return;
    const due = deps.store.claimDueRetrospective(at.toISOString());
    if (!due) return;
    let model: string | null = null;
    let content = "";
    let failed: string | null = "no_model";
    let prompt: PromptUse | null = null;
    let cut = false;
    try {
      // The model you chose for retrospectives, told how hard to think (ADR 0077); else the Bot's
      // own, which thinks as it likes, as before.
      const own = chosen || !creds ? null : (deps.routing.decideRoute(due.botId, creds, due.plan.title)?.target ?? null);
      const target = chosen ?? own;
      if (target) {
        model = target.model;
        const locale = deps.store.settingsCached().locale === "en" ? "en" : "zh";
        prompt = promptPage(deps.store, locale).resolve("call.retrospective");
        const result = await sideJudge(deps, own ? { ...own, thinkingLevel: null } : target, {
          prompt: prompt.ref,
          messages: [
            { role: "system", content: prompt.text },
            { role: "user", content: retrospectivePayload(due) },
          ],
          signal: new AbortController().signal,
          timeoutMs: RETROSPECT_TIMEOUT_MS,
          maxTokens: RETROSPECT_MAX_TOKENS,
        });
        try {
          recordSideSpend(deps.spend, {
            kind: "organize",
            purpose: "retrospect",
            owner: deps.spend.spendOwner(due.sessionId ?? "", due.botId),
            target,
            ...spentOf(result),
          });
        } catch {
          // the ledger is best effort
        }
        content = result.content ?? "";
        // An answer cut off mid-way writes nothing: half of what it meant could undo the other half.
        failed = result.failKind ? (result.failKind === "incomplete" ? "truncated" : "call_failed") : null;
        cut = result.truncated === true;
      }
    } catch {
      failed = "call_failed";
    }
    const outcome = failed ? null : parseRetrospective(content);
    if (prompt && !failed && !cut && !outcome) {
      deps.store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable", sessionId: due.sessionId, taskId: due.taskId, botId: due.botId });
    }
    try {
      deps.store.recordRetrospective(due, outcome, { model, note: failed ?? (outcome ? null : "unreadable"), raw: content || null });
    } catch {
      // left pending; the next claim fails it as interrupted
    }
  }

  return {
    retrospect(at) {
      if (running || !deps.store.learningOn()) return;
      running = true;
      void deps.track(run(at).finally(() => {
        running = false;
      }));
    },
  };
}
