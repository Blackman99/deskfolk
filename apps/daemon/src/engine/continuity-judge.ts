/**
 * Wires a `continuity` acceptance check's vision model to the real endpoint: the default
 * endpoint's default model — the same target `routing.routingTarget` resolves for the organizer
 * and the closing check (see `organizer.ts`, `engine/routing.ts`). One call per batch of pair
 * images; each image is sent as an OpenAI `image_url` data URI, the same content-part shape
 * `context.ts` sends for a `read_file` image. Every call bills the ledger as `acceptance_check`,
 * owned by the plan's session, never a Bot — `createPlanChecks` only calls this with a
 * `sessionId` when the plan still has one.
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatContentPart, CompletionsClient } from "../completions";
import { CONTINUITY_JUDGE_TIMEOUT_MS, continuityJudgePrompt, type ContinuityImage, type JudgeContinuity } from "../continuity-check";
import type { SpendTracker } from "./spend";
import type { CallTarget } from "./types";

export type ContinuityJudgeDeps = {
  completions: CompletionsClient;
  /** Resolves the default endpoint's default model; null when none is configured. */
  routing: () => Promise<(CallTarget & { baseUrl: string; apiKey: string }) | null>;
  spend: SpendTracker;
};

function imageContent(images: readonly ContinuityImage[], locale: Locale): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const image of images) {
    parts.push({ type: "text", text: locale === "en" ? `Cut ${image.n}:` : `第 ${image.n} 处：` });
    parts.push({ type: "image_url", image_url: { url: image.dataUri } });
  }
  return parts;
}

export function createContinuityJudge(deps: ContinuityJudgeDeps): JudgeContinuity {
  return async (images, rules, item, locale, sessionId) => {
    const target = await deps.routing().catch(() => null);
    if (!target) throw new Error(locale === "en" ? "no model endpoint is configured" : "没有配置模型端点");
    const result = await deps.completions.judge({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      messages: [
        { role: "system", content: continuityJudgePrompt(item, rules, locale) },
        { role: "user", content: imageContent(images, locale) },
      ],
      signal: new AbortController().signal,
      timeoutMs: CONTINUITY_JUDGE_TIMEOUT_MS,
      maxTokens: 1024,
    });
    if (sessionId) {
      try {
        deps.spend.recordResponseSpend({
          kind: "acceptance_check",
          owner: deps.spend.spendOwner(sessionId, null),
          target: deps.spend.callOf(target),
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
      } catch {
        // the ledger is best-effort; the verdict still counts
      }
    }
    if (result.failKind && result.failKind !== "incomplete") {
      throw new Error(locale === "en" ? "the model call failed" : "模型调用失败");
    }
    return result.content ?? "";
  };
}
