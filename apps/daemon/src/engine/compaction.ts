/**
 * The summary call of a turn's context compaction (ADR 0068): the old part of the loop written out
 * and sent to the turn's own model on the built-in prompt `call.compact` (yours to edit, ADR 0064),
 * billed to the turn as `compact`. Sizing, the split and the texts are in ../compaction.ts; the hop
 * loop (lifecycle.ts) decides when to compact and puts the summary in place.
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatMessage, CompletionsClient } from "../completions";
import { COMPACT_MAX_TOKENS, COMPACT_TIMEOUT_MS, compactPayload, writeOutLoop, type CompactionPlan } from "../compaction";
import type { PromptPage } from "../prompts/book";
import type { SpendTracker } from "./spend";
import type { EndpointTarget, SpendOwner } from "./types";

export type SummarizeDeps = {
  completions: CompletionsClient;
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  callOf: SpendTracker["callOf"];
};

export type SummarizeInput = {
  turnId: string;
  target: EndpointTarget;
  owner: SpendOwner;
  locale: Locale;
  signal: AbortSignal;
  page: PromptPage;
  plan: CompactionPlan;
  /** The line that started the turn, so the summary keeps to what it was for. */
  trigger: string;
  /** The note an earlier compaction of this turn left, folded into the new summary. */
  earlier: ChatMessage | null;
};

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The summary of `plan.old`, or null when there is none to use: the call failed, or answered
 * nothing. Refused as over the context itself, it goes once more with half the record.
 */
export async function summarizeLoop(deps: SummarizeDeps, input: SummarizeInput): Promise<string | null> {
  const prompt = input.page.resolve("call.compact");
  let budget = input.plan.inputBytes - bytesOf(prompt.text);
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = writeOutLoop(input.plan.old, budget, input.locale, input.earlier);
    const result = await deps.completions.judge({
      baseUrl: input.target.baseUrl,
      apiKey: input.target.apiKey,
      apiFormat: input.target.apiFormat,
      model: input.target.model,
      prompt: prompt.ref,
      messages: [
        { role: "system", content: prompt.text },
        { role: "user", content: compactPayload(input.locale, input.trigger, record) },
      ],
      signal: input.signal,
      timeoutMs: COMPACT_TIMEOUT_MS,
      maxTokens: COMPACT_MAX_TOKENS,
    });
    try {
      deps.recordResponseSpend({
        kind: "turn",
        purpose: "compact",
        owner: input.owner,
        turnId: input.turnId,
        target: deps.callOf(input.target),
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
    } catch {
      // the ledger is best effort
    }
    if (result.failKind === "context_full" && attempt === 0) {
      budget = Math.floor(budget / 2);
      continue;
    }
    // A summary cut off at its cap is still most of one; the Bot can read the files for the rest.
    const summary = result.failKind === null ? (result.content ?? "").trim() : "";
    return summary || null;
  }
  return null;
}
