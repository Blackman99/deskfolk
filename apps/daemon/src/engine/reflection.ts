/**
 * Runs the narrowed reflection (ADR 0051) from the scheduler's tick: one due reflection at a time,
 * on the reflection's model when you chose one (ADR 0077), else on the Bot's own (its pin, its
 * default, the endpoint's default — the level-7 decision with no turn), billed as `organize` with
 * the `reflect` purpose. The store decides what is due and what the
 * answer becomes; this only makes the call.
 */
import type { Message } from "@real-bot/protocol";
import { parseReflection } from "../store/reflection";
import type { ClaudeJudge } from "../claude-code/reading";
import type { CompletionsClient } from "../completions";
import { reflectionPayload } from "../prompts/reflection";
import type { Store } from "../store";
import { recordSideSpend, sideJudge, spentOf, type BuiltinTargetOf } from "./builtin-models";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import { promptPage } from "../prompts/book";

/** How long one reflection may take. */
const REFLECT_TIMEOUT_MS = 90_000;

export type Reflector = { reflect: (at: Date) => void };

export function createReflector(deps: {
  store: Store;
  completions: CompletionsClient;
  routing: Pick<Routing, "credentials" | "decideRoute">;
  spend: SpendTracker;
  track: <T>(promise: Promise<T>) => Promise<T>;
  publishMessage: (message: Message) => void;
  /** The reflection's model when you chose one (ADR 0077). */
  builtinTarget?: BuiltinTargetOf;
  claudeJudge?: ClaudeJudge | null;
}): Reflector {
  let running = false;

  async function run(at: Date): Promise<void> {
    // No model at all, nothing claimed: what is due waits for one rather than failing for good. A
    // Claude model you chose needs no endpoint.
    const chosen = (await deps.builtinTarget?.("reflection").catch(() => null)) ?? null;
    const creds = await deps.routing.credentials().catch(() => null);
    if (!creds && !chosen) return;
    const due = deps.store.claimDueReflection(at.toISOString());
    if (!due) return;
    let outcome = null;
    try {
      // The model you chose for reflections, told how hard to think (ADR 0077); else the Bot's own,
      // which thinks as it likes, as before.
      const own = chosen || !creds ? null : (deps.routing.decideRoute(due.botId, creds, due.ticketTitle)?.target ?? null);
      const target = chosen ?? own;
      if (target) {
        const locale = deps.store.settingsCached().locale === "en" ? "en" : "zh";
        const prompt = promptPage(deps.store, locale).resolve("call.reflection");
        const result = await sideJudge(deps, own ? { ...own, thinkingLevel: null } : target, {
          prompt: prompt.ref,
          messages: [
            { role: "system", content: prompt.text },
            { role: "user", content: reflectionPayload(due) },
          ],
          signal: new AbortController().signal,
          timeoutMs: REFLECT_TIMEOUT_MS,
          maxTokens: 800,
        });
        try {
          const session = deps.store.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(due.taskId)?.session_id;
          recordSideSpend(deps.spend, {
            kind: "organize",
            purpose: "reflect",
            owner: deps.spend.spendOwner(session ?? "", due.botId),
            target,
            ...spentOf(result),
          });
        } catch {
          // the ledger is best effort
        }
        if (!result.failKind || result.failKind === "incomplete") outcome = parseReflection(result.content ?? "");
        if (!result.failKind && !result.truncated && outcome?.kind === "none" && outcome.reason === "unreadable") {
          deps.store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable", taskId: due.taskId, botId: due.botId });
        }
      }
    } catch {
      outcome = null;
    }
    try {
      const { message } = deps.store.recordReflection(due, outcome, new Date().toISOString());
      if (message) deps.publishMessage(message);
    } catch {
      // left pending; the next claim fails it as interrupted
    }
  }

  return {
    reflect(at) {
      if (running || !deps.store.learningOn()) return;
      running = true;
      void deps.track(run(at).finally(() => {
        running = false;
      }));
    },
  };
}
