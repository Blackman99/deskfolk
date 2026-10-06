/**
 * Runs the retrospective (ADR 0062) from the scheduler's tick: one due delivery and Bot at a time,
 * on the Bot's own model (its pin, its default, the endpoint's default — the level-7 decision with
 * no turn), billed as `organize` with the `retrospect` purpose. The store decides what is due and
 * writes what the answer becomes; this only makes the call. The changes reach the window through
 * the store's own change journal (memories, skills, and the plan the retrospective is shown on).
 */
import { parseRetrospective } from "../store/retrospectives";
import type { CompletionsClient } from "../completions";
import { retrospectivePayload, retrospectiveSystem } from "../prompts/retrospective";
import type { Store } from "../store";
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
}): Retrospector {
  let running = false;

  async function run(at: Date): Promise<void> {
    // No endpoint, nothing claimed: what is due waits for one rather than failing for good.
    const creds = await deps.routing.credentials().catch(() => null);
    if (!creds) return;
    const due = deps.store.claimDueRetrospective(at.toISOString());
    if (!due) return;
    let model: string | null = null;
    let content = "";
    let failed: string | null = "no_model";
    try {
      const routed = deps.routing.decideRoute(due.botId, creds, due.plan.title);
      if (routed) {
        model = routed.target.model;
        const locale = deps.store.settingsCached().locale === "en" ? "en" : "zh";
        const result = await deps.completions.judge({
          baseUrl: routed.target.baseUrl,
          apiKey: routed.target.apiKey,
          model: routed.target.model,
          messages: [
            { role: "system", content: retrospectiveSystem(locale) },
            { role: "user", content: retrospectivePayload(due) },
          ],
          signal: new AbortController().signal,
          timeoutMs: RETROSPECT_TIMEOUT_MS,
          maxTokens: RETROSPECT_MAX_TOKENS,
        });
        try {
          deps.spend.recordResponseSpend({
            kind: "organize",
            purpose: "retrospect",
            owner: deps.spend.spendOwner(due.sessionId ?? "", due.botId),
            target: deps.spend.callOf(routed.target),
            usage: result.usage,
            responded: result.failKind === null || result.failKind === "incomplete",
          });
        } catch {
          // the ledger is best effort
        }
        content = result.content ?? "";
        // An answer cut off mid-way writes nothing: half of what it meant could undo the other half.
        failed = result.failKind ? (result.failKind === "incomplete" ? "truncated" : "call_failed") : null;
      }
    } catch {
      failed = "call_failed";
    }
    const outcome = failed ? null : parseRetrospective(content);
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
