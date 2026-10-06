/**
 * Wires a `continuity` (衔接一致 / "Seams") acceptance check's judge to the real endpoint: the
 * default endpoint's default model — the same target `routing.routingTarget` resolves for the
 * organizer and the closing check (see `organizer.ts`, `engine/routing.ts`). One call per batch of
 * seam evidence, or one call for the whole-set digest; a text-only or digest call never attaches an
 * `image_url` part, so it never actually requires the model to have vision. Every call bills the
 * ledger as `acceptance_check`, owned by the plan's session, never a Bot — `createPlanChecks` only
 * calls this with a `sessionId` when the plan still has one. A call that sends frames is a judgement
 * of pictures and carries the `vision` purpose, so the spend view shows it apart (ADR 0042).
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatContentPart, CompletionsClient } from "../completions";
import { parseSeamsJudgeAnswer, SEAMS_JUDGE_TIMEOUT_MS, seamsJudgePrompt, seamsRulesText, type JudgeSeams, type SeamEvidence } from "../seams-check";
import type { JudgeStandard, StandardEvidence } from "../standard-check";
import type { SpendTracker } from "./spend";
import type { CallTarget } from "./types";
import { promptPage } from "../prompts/book";
import type { Store } from "../store";

export type SeamsJudgeDeps = {
  completions: CompletionsClient;
  /** Where your edits to the judges' prompts come from (ADR 0064), and where an unreadable answer is noted. */
  store?: Store;
  /** Resolves the default endpoint's default model; null when none is configured. */
  routing: () => Promise<(CallTarget & { baseUrl: string; apiKey: string }) | null>;
  spend: SpendTracker;
};

function evidenceContent(evidence: readonly SeamEvidence[], locale: Locale): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const item of evidence) {
    if (item.kind === "image") {
      parts.push({ type: "text", text: locale === "en" ? `Seam ${item.n}:` : `第 ${item.n} 处：` });
      parts.push({ type: "image_url", image_url: { url: item.dataUri } });
    } else if (item.kind === "text") {
      const label = locale === "en" ? `Seam ${item.n} (${item.label}):` : `第 ${item.n} 处（${item.label}）：`;
      const before = locale === "en" ? "End of the earlier part:" : "前一部分结尾：";
      const after = locale === "en" ? "Start of the later part:" : "后一部分开头：";
      parts.push({ type: "text", text: `${label}\n${before}\n${item.before}\n\n${after}\n${item.after}` });
    } else {
      parts.push({ type: "text", text: item.text });
    }
  }
  return parts;
}

export function createSeamsJudge(deps: SeamsJudgeDeps): JudgeSeams {
  return async (evidence, rules, item, locale, sessionId) => {
    const target = await deps.routing().catch(() => null);
    if (!target) throw new Error(locale === "en" ? "no model endpoint is configured" : "没有配置模型端点");
    const mode = evidence[0]?.kind === "digest" ? "digest" : evidence[0]?.kind === "text" ? "text" : "image";
    const prompt = deps.store ? promptPage(deps.store, locale).resolve(`call.seams_${mode}`, { item, rules: seamsRulesText(rules, locale) }) : null;
    const result = await deps.completions.judge({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      ...(prompt ? { prompt: prompt.ref } : {}),
      messages: [
        { role: "system", content: prompt?.text ?? seamsJudgePrompt(item, rules, locale, mode) },
        { role: "user", content: evidenceContent(evidence, locale) },
      ],
      signal: new AbortController().signal,
      timeoutMs: SEAMS_JUDGE_TIMEOUT_MS,
      maxTokens: 1024,
    });
    if (sessionId) {
      try {
        deps.spend.recordResponseSpend({
          kind: "acceptance_check",
          purpose: mode === "image" ? "vision" : null,
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
    // An answer that came back whole and does not read counts against the prompt it ran on.
    if (prompt && deps.store && !result.failKind && !result.truncated && parseSeamsJudgeAnswer(result.content ?? "") === null) {
      deps.store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable", sessionId });
    }
    return result.content ?? "";
  };
}

/**
 * The judge of a standard check (照样片, ADR 0060), on the same target and ledger as the seams
 * judge: one call with both sides' evidence, the sample first. Frames make it a judgement of
 * pictures in the spend view (`vision`), though unlike a seams check its verdict is a gate.
 */
export function createStandardJudge(deps: SeamsJudgeDeps): JudgeStandard {
  return async (evidence: StandardEvidence[], system: string, sessionId: string | null) => {
    const target = await deps.routing().catch(() => null);
    if (!target) throw new Error("no model endpoint is configured");
    const pictures = evidence.some((item) => item.kind === "image");
    const content: ChatContentPart[] = evidence.flatMap((item): ChatContentPart[] => item.kind === "image"
      ? [{ type: "text", text: `${item.label}:` }, { type: "image_url", image_url: { url: item.dataUri } }]
      : [{ type: "text", text: item.text }]);
    const result = await deps.completions.judge({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      signal: new AbortController().signal,
      timeoutMs: SEAMS_JUDGE_TIMEOUT_MS,
      maxTokens: 1024,
    });
    if (sessionId) {
      try {
        deps.spend.recordResponseSpend({
          kind: "acceptance_check",
          purpose: pictures ? "vision" : null,
          owner: deps.spend.spendOwner(sessionId, null),
          target: deps.spend.callOf(target),
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
      } catch {
        // the ledger is best-effort; the verdict still counts
      }
    }
    if (result.failKind && result.failKind !== "incomplete") throw new Error("the model call failed");
    return result.content ?? "";
  };
}
