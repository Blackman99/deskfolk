/**
 * Runs the narrowed reflection (ADR 0051) from the scheduler's tick: one due reflection at a time,
 * on the Bot's own model (its pin, its default, the endpoint's default — the level-7 decision with no
 * turn), billed as `organize` with the `reflect` purpose. The store decides what is due and what the
 * answer becomes; this only makes the call.
 */
import type { Message } from "@real-bot/protocol";
import { parseReflection } from "../store/reflection";
import type { CompletionsClient } from "../completions";
import { reflectionPayload, reflectionSystem } from "../prompts/reflection";
import type { Store } from "../store";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";

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
}): Reflector {
  let running = false;

  async function run(at: Date): Promise<void> {
    // No endpoint, nothing claimed: what is due waits for one rather than failing for good.
    const creds = await deps.routing.credentials().catch(() => null);
    if (!creds) return;
    const due = deps.store.claimDueReflection(at.toISOString());
    if (!due) return;
    let outcome = null;
    try {
      const routed = deps.routing.decideRoute(due.botId, creds, due.ticketTitle);
      if (routed) {
        const locale = deps.store.settingsCached().locale === "en" ? "en" : "zh";
        const result = await deps.completions.judge({
          baseUrl: routed.target.baseUrl,
          apiKey: routed.target.apiKey,
          model: routed.target.model,
          messages: [
            { role: "system", content: reflectionSystem(locale) },
            { role: "user", content: reflectionPayload(due) },
          ],
          signal: new AbortController().signal,
          timeoutMs: REFLECT_TIMEOUT_MS,
          maxTokens: 800,
        });
        try {
          const session = deps.store.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(due.taskId)?.session_id;
          deps.spend.recordResponseSpend({
            kind: "organize",
            purpose: "reflect",
            owner: deps.spend.spendOwner(session ?? "", due.botId),
            target: deps.spend.callOf(routed.target),
            usage: result.usage,
            responded: result.failKind === null || result.failKind === "incomplete",
          });
        } catch {
          // the ledger is best effort
        }
        if (!result.failKind || result.failKind === "incomplete") outcome = parseReflection(result.content ?? "");
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
