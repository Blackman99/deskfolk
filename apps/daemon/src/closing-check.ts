/**
 * The closing check: before a turn hands a delivery to the user, one deterministic look — no
 * model call — at three things the app can prove on its own: whether this job's own acceptance
 * checks (`store/acceptance-checks.ts`, `acceptance-eval.ts`) are passing, whether a closing
 * message that promises "more to follow" actually has someone or something picking that up, and
 * whether a claim that something was run, tested or verified has a run behind it in `turn_runs`.
 * The engine hands the one combined note back to the Bot once per turn — as a failed
 * `send_message` or as a line in the loop — and lets the next reply through whatever it says.
 *
 * A 2026-09-28 benchmark ablation (78 real-model runs) found the old model-judged version —
 * `CLOSING_CHECK_SYSTEM`, a short call that read the brief, the deliveries and the transcript and
 * guessed what was missing — cost about a quarter of the turn's spend and time and never caught
 * anything a run of the app's own acceptance checks did not already prove (ADR 0036,
 * `docs/adr/0036-acceptance-checks-run-by-the-daemon.md`). This file keeps the two things that
 * check covered which acceptance checks do not — an unbacked "later" and an unverified claim —
 * and drops the model call entirely.
 *
 * A closing message that says the work is still going ("checking the 18 frames, conclusion to
 * follow") is checked too, cited files or not: the turn ends when it goes out, so "later" only
 * happens when a check-back is booked or someone named takes it. A reviewer once closed that way
 * and the group waited on a conclusion nothing was going to write.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import { describeCheck } from "./acceptance-eval";
import { takeCodePoints } from "./text";
import { classifyPath } from "./workspace-paths";

/** How much of one handed-over file the check reads. */
export const CLOSING_EXCERPT_LIMIT = 3000;

/**
 * Words a closing message uses when the work is still going. A match only means "check this reply
 * too"; the deterministic rules below decide whether anything is actually left hanging, so a
 * storyboard line that happens to say 随后 costs nothing more than that check.
 */
const LATER_WORK =
  /随后|稍后|稍候|回头|待会|过会|晚些|晚点|结论后补|后续再|马上(就)?(给|发|补|出)|正在(逐|进行|核|检|审|处理|生成|渲染|排查|分析|比对|确认|整理|跑)|\b(?:to follow|shortly|in a (?:moment|bit|few minutes)|stay tuned)\b|\bI(?:'ll| will) (?:follow up|get back|report back|post|share|send)\b|\bI'm (?:now )?(?:checking|reviewing|verifying|comparing|working on)\b/i;

/** Whether a closing message says it is still working on something it has not handed over. */
export function promisesLaterWork(text: string): boolean {
  return LATER_WORK.test(text);
}

/**
 * A conservative match for "this was run / tested / verified", zh and en. Deliberately narrow: a
 * false negative just means the deterministic check stays quiet, the same as the old model call
 * failing open.
 */
const VERIFICATION_CLAIM =
  /测试(?:全部)?通过|全部通过|跑通了?|验证过了?|已验证|已经验证|构建成功|编译(?:通过|成功)|build (?:succeeded|passed)|builds? successfully|tests?\s?(?:all\s)?pass(?:ed|ing)?|all green|\bverified\b|\bconfirmed working\b/i;

/** A claim disclaimed in the same breath ("跑了但没验证 UI") should not be flagged. */
const VERIFICATION_DISCLAIMED =
  /未验证|没(?:有)?验证过?|没跑过?|not verified|not yet verified|haven'?t verified|not tested|no tests? (?:were|was) run/i;

/** Whether the body claims something was run, tested, or verified, without also disclaiming it. */
export function claimsVerification(text: string): boolean {
  return VERIFICATION_CLAIM.test(text) && !VERIFICATION_DISCLAIMED.test(text);
}

/** File kinds whose contents the check can read; anything else is named by path only. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".rb", ".sh", ".sql", ".svg", ".tex", ".rst",
]);
const EXCERPT_BYTES = 64 * 1024;

/**
 * The head of a workspace file, for a judge that only has to recognise what is in it. Null for a
 * path outside the workspace, a missing file, or a kind whose bytes are not text.
 */
export function deliveryExcerpt(root: string, relpath: string, limit: number = CLOSING_EXCERPT_LIMIT): { excerpt: string | null; truncated: boolean } {
  if (!TEXT_EXTENSIONS.has(extname(relpath).toLowerCase())) return { excerpt: null, truncated: false };
  const classified = classifyPath(root, relpath);
  if (classified.zone !== "inside" || !existsSync(classified.abs)) return { excerpt: null, truncated: false };
  try {
    const size = statSync(classified.abs).size;
    const buffer = Buffer.alloc(Math.min(size, EXCERPT_BYTES));
    const fd = openSync(classified.abs, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    const clipped = takeCodePoints(buffer.toString("utf8"), limit);
    return { excerpt: clipped.text, truncated: clipped.truncated || size > buffer.length };
  } catch {
    return { excerpt: null, truncated: false };
  }
}

/** Failing checks named in one note; past this a nudge is a rewrite, not a nudge. */
export const FAILING_CHECKS_LIMIT = 3;

/**
 * One failing check, named the way the note lists it: 「item」description：detail (zh) or
 * "item" description: detail (en). `detail` is either a fresh `evaluateFileCheck` verdict's
 * detail (file kinds) or the latest stored run's detail (command kind) — the caller decides which.
 */
export function describeFailingCheck(
  check: Pick<AcceptanceCheck, "item" | "kind" | "path" | "pattern" | "negate" | "command" | "cwd" | "measure">,
  locale: Locale,
  detail: string,
): string {
  const description = describeCheck(check, locale);
  return locale === "en" ? `"${check.item}" ${description}: ${detail}` : `「${check.item}」${description}：${detail}`;
}

/** What one closing check found; each is included in the note only when true / non-empty. */
export type ClosingSignals = {
  /** Up to {@link FAILING_CHECKS_LIMIT} lines from {@link describeFailingCheck}, in the plan's check order. */
  failingChecks: readonly string[];
  /** A closing message promised more later, with no check-back booked and nobody named to take it. */
  unbackedPromise: boolean;
  /** A claim that something was run, tested, or verified, with no run behind it this turn. */
  unverifiedClaim: boolean;
};

function failingChecksBlock(locale: Locale, lines: readonly string[]): string {
  const head = locale === "en" ? "This job's own acceptance checks are not passing:" : "这件事自己的验收检查还没过：";
  const tail =
    locale === "en"
      ? "Fix the deliverable, not the check, and hand it over again — or say why it can't be done now."
      : "要改的是交付物，不是检查本身：改好后再交一次；做不到的话，在收尾里说明现在为什么做不到。";
  return [head, ...lines, tail].join("\n");
}

function unbackedPromiseNote(locale: Locale): string {
  return locale === "en"
    ? "You said the rest comes later, but when this turn ends nobody picks it up: finish it now, book a check-back, or hand it to someone by name."
    : "你说了稍后还有下文，但这一轮一结束就没有人接手：现在做完、约一个 check_back，或者点名交给谁。";
}

function unverifiedClaimNote(locale: Locale): string {
  return locale === "en"
    ? "You say it was run, tested, or verified, but this turn ran no command: run it now, or write that it was not verified and why."
    : "你说已经跑过、测过或验证过，但这一轮没有跑任何命令：现在去跑，或者写明没有验证过以及原因。";
}

/**
 * The one note handed back, combining whichever of `signals` apply, in the turn's locale, in the
 * same "（应用提示）… / (App note) …" voice as the other in-loop notes (`turn-pace.ts`). Null
 * when nothing in `signals` applies.
 */
export function closingNote(locale: Locale, signals: ClosingSignals): string | null {
  const parts: string[] = [];
  if (signals.failingChecks.length > 0) parts.push(failingChecksBlock(locale, signals.failingChecks));
  if (signals.unbackedPromise) parts.push(unbackedPromiseNote(locale));
  if (signals.unverifiedClaim) parts.push(unverifiedClaimNote(locale));
  if (parts.length === 0) return null;
  const prefix = locale === "en" ? "(App note) " : "（应用提示）";
  return prefix + parts.join("\n");
}
