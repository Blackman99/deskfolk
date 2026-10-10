/**
 * The summary call of a turn's context compaction (ADR 0068): the old part of the loop written out
 * and sent to the turn's own model — or to the compaction model you chose, an endpoint's or a Claude
 * model of yours (ADR 0077) — on the built-in prompt `call.compact` (yours to edit, ADR 0064),
 * billed to the turn as `compact`. Sizing, the split and the texts are in ../compaction.ts; the hop
 * loop (lifecycle.ts) decides when to compact and puts the summary in place.
 */
import type { Locale } from "@real-bot/protocol";
import type { ClaudeJudge } from "../claude-code/reading";
import type { ChatMessage, CompletionsClient } from "../completions";
import { COMPACT_MAX_TOKENS, COMPACT_TIMEOUT_MS, compactPayload, writeOutLoop, type CompactionPlan } from "../compaction";
import type { PromptPage } from "../prompts/book";
import { recordSideSpend, sideJudge, spentOf, type BuiltinTarget } from "./builtin-models";
import type { SpendTracker } from "./spend";
import type { EndpointTarget, SpendOwner } from "./types";

export type SummarizeDeps = {
  completions: CompletionsClient;
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  recordClaudeSpend?: SpendTracker["recordClaudeSpend"];
  callOf: SpendTracker["callOf"];
  claudeJudge?: ClaudeJudge | null;
};

export type SummarizeInput = {
  turnId: string;
  target: EndpointTarget;
  /** The compaction model you chose (ADR 0077), which the summary runs on instead of `target`. */
  chosen?: BuiltinTarget | null;
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
    // The turn's own model thinks as it likes here, as before; one you chose is told how hard.
    const result = await sideJudge(deps, input.chosen ?? { ...input.target, thinkingLevel: null }, {
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
      recordSideSpend(
        { callOf: deps.callOf, recordResponseSpend: deps.recordResponseSpend, recordClaudeSpend: deps.recordClaudeSpend ?? (() => null) },
        { kind: "turn", purpose: "compact", owner: input.owner, turnId: input.turnId, target: input.chosen ?? input.target, ...spentOf(result) },
      );
    } catch {
      // the ledger is best effort
    }
    // A Claude model's call says no more than that it failed, so it gets no second try with less.
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
