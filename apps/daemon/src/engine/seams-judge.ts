/**
 * Wires a `continuity` (衔接一致 / "Seams") acceptance check's judge to the real endpoint: the
 * picture checks' model when you chose one that can do the call (an endpoint's, or a Claude model of
 * yours, ADR 0077), else the default endpoint's default model (see `builtin-models.ts`,
 * `engine/routing.ts`). One call per batch of
 * seam evidence, or one call for the whole-set digest; a text-only or digest call never attaches an
 * `image_url` part, so it never actually requires the model to have vision. Every call bills the
 * ledger as `acceptance_check`, owned by the plan's session, never a Bot — `createPlanChecks` only
 * calls this with a `sessionId` when the plan still has one. A call that sends frames is a judgement
 * of pictures and carries the `vision` purpose, so the spend view shows it apart (ADR 0042).
 */
import type { CallRunVerdict, Locale } from "@real-bot/protocol";
import type { ClaudeJudge } from "../claude-code/reading";
import type { ChatContentPart, CompletionsClient } from "../completions";
import { parseSeamsJudgeAnswer, SEAMS_JUDGE_TIMEOUT_MS, seamsJudgePrompt, seamsRulesText, type JudgeAbout, type JudgeSeams, type SeamEvidence } from "../seams-check";
import { parseStandardAnswer, type JudgeStandard, type StandardEvidence } from "../standard-check";
import { recordSideSpend, runOn, sideJudge, spentOf, type BuiltinTarget, type SideAnswer } from "./builtin-models";
import type { SpendTracker } from "./spend";
import { promptPage } from "../prompts/book";
import type { Store } from "../store";

export type SeamsJudgeDeps = {
  completions: CompletionsClient;
  /** Where your edits to the judges' prompts come from (ADR 0064), and where an unreadable answer is noted. */
  store?: Store;
  /**
   * Resolves the model for a call (ADR 0075, 0077), told whether it is about to send frames; null
   * when no endpoint is configured.
   */
  routing: (opts: { pictures: boolean }) => Promise<BuiltinTarget | null>;
  /** Runs the call when the picture checks' model is a Claude model of yours (ADR 0077). */
  claudeJudge?: ClaudeJudge | null;
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

/**
 * A judge's call record (ADR 0083): one per model call, a check run's several batches each their
 * own, all carrying the check run. `verdict` reads the answer; a failed call has none.
 */
function recordJudgeRun(deps: SeamsJudgeDeps, input: {
  prompt: { ref: { id: string; revision_id: string | null; locale: string } } | null;
  promptId: string;
  sessionId: string | null;
  about: JudgeAbout | undefined;
  target: BuiltinTarget;
  result: SideAnswer;
  spendId: string | null;
  started: number;
  verdict: (raw: string) => CallRunVerdict | null;
}): void {
  if (!deps.store) return;
  const { result } = input;
  const failed = Boolean(result.failKind && result.failKind !== "incomplete");
  const verdict = failed ? null : input.verdict(result.content ?? "");
  try {
    deps.store.recordCallRun({
      role: "judge",
      prompt: input.prompt?.ref ?? { id: input.promptId, revision_id: null, locale: "zh" },
      sessionId: input.sessionId,
      taskId: input.about?.taskId ?? null,
      checkRunId: input.about?.checkRunId ?? null,
      ...runOn(input.target),
      outcome: failed ? "failed" : verdict ? "ok" : "unreadable",
      failKind: failed ? result.failKind : verdict ? null : result.truncated ? "truncated" : "unreadable",
      verdict,
      raw: result.content ?? null,
      spendId: input.spendId,
      ms: Date.now() - input.started,
    });
  } catch {
    // the call record is a record; the verdict still counts
  }
}

export function createSeamsJudge(deps: SeamsJudgeDeps): JudgeSeams {
  return async (evidence, rules, item, locale, sessionId, about) => {
    const mode = evidence[0]?.kind === "digest" ? "digest" : evidence[0]?.kind === "text" ? "text" : "image";
    const started = Date.now();
    let spendId: string | null = null;
    const target = await deps.routing({ pictures: mode === "image" }).catch(() => null);
    if (!target) throw new Error(locale === "en" ? "no model endpoint is configured" : "没有配置模型端点");
    const prompt = deps.store ? promptPage(deps.store, locale).resolve(`call.seams_${mode}`, { item, rules: seamsRulesText(rules, locale) }) : null;
    const result = await sideJudge(deps, target, {
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
        spendId = recordSideSpend(deps.spend, {
          kind: "acceptance_check",
          purpose: mode === "image" ? "vision" : null,
          owner: deps.spend.spendOwner(sessionId, null),
          target,
          ...spentOf(result),
        })?.id ?? null;
      } catch {
        // the ledger is best-effort; the verdict still counts
      }
    }
    recordJudgeRun(deps, {
      prompt, promptId: `call.seams_${mode}`, sessionId, about, target, result, spendId, started,
      verdict: (raw) => {
        const parsed = parseSeamsJudgeAnswer(raw);
        if (!parsed) return null;
        const pairs = parsed.pairs ?? [];
        const good = pairs.filter((pair) => pair.ok).length;
        const passed = good === pairs.length && parsed.overall?.ok !== false;
        return { kind: "judge", mode, passed, note: pairs.length ? `${good}/${pairs.length}` : (parsed.overall?.issues[0] ?? null) };
      },
    });
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
  return async (evidence: StandardEvidence[], system: string, sessionId: string | null, about?: JudgeAbout) => {
    const pictures = evidence.some((item) => item.kind === "image");
    const started = Date.now();
    let spendId: string | null = null;
    const target = await deps.routing({ pictures }).catch(() => null);
    if (!target) throw new Error("no model endpoint is configured");
    const content: ChatContentPart[] = evidence.flatMap((item): ChatContentPart[] => item.kind === "image"
      ? [{ type: "text", text: `${item.label}:` }, { type: "image_url", image_url: { url: item.dataUri } }]
      : [{ type: "text", text: item.text }]);
    const result = await sideJudge(deps, target, {
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
        spendId = recordSideSpend(deps.spend, {
          kind: "acceptance_check",
          purpose: pictures ? "vision" : null,
          owner: deps.spend.spendOwner(sessionId, null),
          target,
          ...spentOf(result),
        })?.id ?? null;
      } catch {
        // the ledger is best-effort; the verdict still counts
      }
    }
    recordJudgeRun(deps, {
      prompt: null, promptId: "call.standard", sessionId, about, target, result, spendId, started,
      verdict: (raw) => {
        const parsed = parseStandardAnswer(raw);
        return parsed ? { kind: "judge", mode: "standard", passed: parsed.ok, note: parsed.issues[0] ?? null } : null;
      },
    });
    if (result.failKind && result.failKind !== "incomplete") throw new Error("the model call failed");
    return result.content ?? "";
  };
}
