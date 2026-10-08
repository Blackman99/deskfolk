/**
 * What one hop may write and how long it may stream (ADR 0040 P1, output caps and failure shapes).
 *
 * A hop used to have neither an output cap nor a clock of its own. On 2026-09-29, three times, a hop
 * streamed one sentence over and over to the endpoint's default cap of 128,000 tokens (one of them
 * for 17 minutes, the sentence 3,457 times), and stopped with `finish_reason: "length"`. A cut-off
 * reply counted as a reply: it was posted as the turn's closing line, and in a Bot↔Bot direct that
 * woke the other Bot, whose next hop read the whole repetition again.
 *
 * So each hop sends `max_tokens` from its model's catalog entry and gets a streaming time limit
 * sized from the same entry. The completions client watches the body text for repetition while it
 * streams and cuts the stream off as soon as it loops; the turn engine judges the finished reply
 * the same way, together with a provider's canned refusal, before anything is posted. A failed
 * hop is never a reply: nothing of it is posted, it wakes nobody, and the hop goes again once with
 * one of the notes below.
 */
import type { EndpointModel, Locale } from "@real-bot/protocol";

/**
 * The output cap when the model's entry names none, reasoning included. In the spend table normal
 * turn hops peaked at 30,473 output tokens and the only three past 32,768 were the repetitions, so a
 * 12K or 16K cap would cut hops that write a large file.
 */
export const DEFAULT_MAX_OUTPUT = 32_768;
/** No hop's stream is cut off sooner than this. */
export const MIN_STREAM_WALL_MS = 10 * 60_000;
/** Room over the time the cap takes at the model's slow-end speed. */
const STREAM_WALL_SLACK = 1.5;

export type HopLimits = {
  /** Sent as the request's `max_tokens`. */
  maxTokens: number;
  /**
   * How long one attempt may stream, counting only the completion itself: tool calls have their own
   * timeouts. The larger of ten minutes and the time the cap takes at the model's measured 10th
   * percentile speed, times 1.5; without a measurement, ten minutes.
   */
  wallMs: number;
};

export function hopLimits(model: Pick<EndpointModel, "max_output" | "stream_tps_p10"> | undefined): HopLimits {
  const maxTokens = model?.max_output ?? DEFAULT_MAX_OUTPUT;
  const tps = model?.stream_tps_p10;
  const measured = tps ? Math.ceil((maxTokens / tps) * STREAM_WALL_SLACK * 1000) : 0;
  return { maxTokens, wallMs: Math.max(MIN_STREAM_WALL_MS, measured) };
}

// ── Repetition ─────────────────────────────────────────────────────────────────────────────────

/** How much body text the watch looks back over, in characters. */
export const REPEAT_WINDOW_CHARS = 6000;
/**
 * The same sentence this many times inside the window is a loop, when nothing new came between one
 * copy and the next. A loop has nothing between its copies but more of itself; a per-item verdict
 * list (「Shot 03：通过。画面稳定，无需返工。」 on every line) puts each item's own name between two
 * copies of the same comment, and is not one.
 */
const REPEAT_SAME_SENTENCE = 5;
/** A sentence shorter than this once normalized never counts that way: 「好的。」「已完成。」 recur in any reply. */
const REPEAT_MIN_SENTENCE = 8;
/**
 * With at least this many sentences of any length in the window, fewer distinct ones than this
 * share is a loop too. Over long sentences the rule above usually trips first, so this one is
 * what catches a loop of short lines.
 */
const REPEAT_MIN_SENTENCES = 20;
const REPEAT_MIN_DISTINCT = 0.2;

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

/**
 * Sentences of the reply's body text as they stream, and whether they have started to loop. Only
 * prose counts: a fenced code block and a Markdown table repeat lines by nature, and tool call
 * arguments never reach it. A sentence is compared by its letters and digits alone, case folded,
 * so punctuation and spacing do not tell two copies apart, while 「Shot 11」 and 「Shot 12」 stay
 * different sentences. The share rule looks at the window as a whole, so twenty lines of the same
 * short 「- [x] 完成」 with no item named on them trip it: that is what a loop of short lines looks
 * like, and a checklist names what each line is for.
 */
export class RepeatWatch {
  private sentence = "";
  /** The current line so far, until it shows whether it is prose, a table row or a fence. */
  private head = "";
  private line: "start" | "maybe_fence" | "prose" | "skip" | "fence" = "start";
  private inFence = false;
  /** A "." just went by: it ends the sentence if whitespace follows, as in English prose. */
  private dot = false;
  private readonly window: Array<{ key: string; chars: number }> = [];
  private windowChars = 0;
  private readonly counts = new Map<string, number>();
  /** Per sentence in the window: where its last copy closed, and how many copies ran up to it. */
  private readonly runs = new Map<string, { at: number; copies: number }>();
  /** How many sentences have closed, and where the last one the window did not hold yet closed. */
  private closed = 0;
  private lastNew = 0;
  private looped = false;

  /** Takes the next piece of body text; true once the reply is looping, and from then on. */
  feed(text: string): boolean {
    for (const ch of text) {
      if (this.looped) break;
      this.take(ch);
    }
    return this.looped;
  }

  /** Counts the sentence still open at the end of the reply; true when the reply loops. */
  end(): boolean {
    if (this.line === "maybe_fence" && !this.inFence) this.prose(this.head);
    this.close();
    return this.looped;
  }

  private take(ch: string): void {
    if (ch === "\n") {
      if (this.line === "fence") this.inFence = !this.inFence;
      else if (this.line === "maybe_fence" && !this.inFence) this.prose(this.head);
      this.close();
      this.line = "start";
      this.head = "";
      return;
    }
    if (this.line === "start") {
      if (ch === " " || ch === "\t") return;
      if (ch === "`" || ch === "~") {
        this.line = "maybe_fence";
      } else {
        this.line = this.inFence || ch === "|" ? "skip" : "prose";
      }
    }
    if (this.line === "maybe_fence") {
      this.head += ch;
      if (this.head.length < 3) return;
      if (this.head === "```" || this.head === "~~~") {
        this.line = "fence";
      } else if (this.inFence) {
        this.line = "skip";
      } else {
        this.line = "prose";
        const head = this.head;
        this.head = "";
        this.prose(head);
      }
      return;
    }
    if (this.line === "prose") this.prose(ch);
  }

  private prose(text: string): void {
    for (const ch of text) {
      if (this.dot) {
        this.dot = false;
        if (ch === " " || ch === "\t") {
          this.close();
          continue;
        }
      }
      this.sentence += ch;
      if (SENTENCE_END.has(ch)) this.close();
      else if (ch === ".") this.dot = true;
      // One sentence as long as the window cannot repeat inside it; count it and start over.
      else if (this.sentence.length >= REPEAT_WINDOW_CHARS) this.close();
    }
  }

  private close(): void {
    const sentence = this.sentence;
    this.sentence = "";
    this.dot = false;
    const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!key) return;
    this.closed += 1;
    const run = this.runs.get(key);
    const copies = run && this.lastNew <= run.at ? run.copies + 1 : 1;
    if (!run) this.lastNew = this.closed;
    this.runs.set(key, { at: this.closed, copies });
    this.window.push({ key, chars: sentence.length });
    this.windowChars += sentence.length;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    while (this.windowChars > REPEAT_WINDOW_CHARS && this.window.length > 1) {
      const oldest = this.window.shift()!;
      this.windowChars -= oldest.chars;
      const left = this.counts.get(oldest.key)! - 1;
      if (left > 0) {
        this.counts.set(oldest.key, left);
      } else {
        this.counts.delete(oldest.key);
        this.runs.delete(oldest.key);
      }
    }
    // Copies of one run that the window has already let go of do not count.
    if (Math.min(copies, this.counts.get(key)!) >= REPEAT_SAME_SENTENCE && [...key].length >= REPEAT_MIN_SENTENCE) {
      this.looped = true;
    }
    if (this.window.length >= REPEAT_MIN_SENTENCES && this.counts.size / this.window.length < REPEAT_MIN_DISTINCT) {
      this.looped = true;
    }
  }
}

/** Whether a finished reply's body text loops, by the same rules the stream is watched with. */
export function repeatsItself(text: string): boolean {
  const watch = new RepeatWatch();
  watch.feed(text);
  return watch.end();
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────

/**
 * Finish reasons that mean the endpoint withheld the answer: OpenAI's `content_filter`, Anthropic's
 * `refusal`, and the reasons Gemini's own API uses, which some OpenAI-compatible proxies pass through
 * as they are (`RECITATION` withholds text too close to a source; it reads the same from here).
 */
const DECLINED_FINISH: ReadonlySet<string> = new Set([
  "content_filter",
  "refusal",
  "safety",
  "prohibited_content",
  "blocklist",
  "spii",
  "recitation",
  "image_safety",
]);

export function declinedFinish(finishReason: string | null): boolean {
  return finishReason !== null && DECLINED_FINISH.has(finishReason.toLowerCase());
}

/** A refusal is one canned line; a Bot explaining what it cannot do and why writes more. */
const DECLINE_MAX_CHARS = 300;

/**
 * Canned refusals as models and providers word them: the model speaking as a language model and
 * saying it cannot (a Bot in its role never calls itself one; 「我是一个 AI 助手」 introducing itself
 * is not this), or a whole reply that is only "I can't help with that". A Gemini refusal went out as
 * a Bot's message twice before this.
 */
const AS_A_MODEL = [
  /\b(?:i['’]m|i am) (?:just |only )?(?:an? )?(?:ai language model|large language model|language model|text-based ai)\b|\bas an? (?:ai language model|large language model|language model)\b/i,
  /我(?:只|仅)?是(?:一个|一种)?(?:大型)?(?:AI\s*)?语言模型|我是(?:一个|一种)?文本\s*AI|作为(?:一个|一种)?(?:大型)?(?:AI\s*)?语言模型|我的设计用途(?:只)?是处理和生成文本/i,
];
const CANNOT = /\b(?:can(?:not|['’]t)|unable|not able|don['’]t have the (?:capacity|ability)|not programmed)\b|无法|没法|不能|没有能力|做不到|帮不了/i;
const BARE_REFUSAL = [
  /^(?:(?:i['’]m )?sorry,?\s*(?:but\s*)?)?i(?:\s*can(?:not|['’]t)|\s*won['’]t|['’]m (?:not able|unable) to|\s*am (?:not able|unable) to)\s*(?:help|assist|comply|continue)(?:\s*you)?\s*with\s*(?:that|this)(?:\s*request)?\s*[.!]?$/i,
  /^(?:抱歉|对不起)[，,]?\s*我(?:无法|不能|没法)(?:协助|帮助|帮你|回答|处理|提供)(?:你)?(?:处理|帮助|协助)?(?:这个|此|该)?(?:请求|问题)?[。.!！]?$/,
];

/** A reply with no tool call that is only a canned refusal. */
export function isDeclined(content: string, hasToolCalls: boolean): boolean {
  if (hasToolCalls) return false;
  const body = content.trim();
  if (!body || [...body].length > DECLINE_MAX_CHARS) return false;
  if (BARE_REFUSAL.some((pattern) => pattern.test(body))) return true;
  return AS_A_MODEL.some((pattern) => pattern.test(body)) && CANNOT.test(body);
}

/**
 * What a finished reply is worth before the turn posts or runs any of it: null when it is a reply,
 * otherwise the failure it is. The streaming client already cuts off a loop and reports the
 * endpoint's own refusals; this judges the finished body once more, since it is what the turn
 * would post, and a client may hand it over whole.
 */
export function replyFailure(reply: {
  content: string;
  toolCalls: readonly unknown[];
  finishReason: string | null;
}): "repeat" | "declined" | null {
  if (declinedFinish(reply.finishReason)) return "declined";
  if (repeatsItself(reply.content)) return "repeat";
  if (isDeclined(reply.content, reply.toolCalls.length > 0)) return "declined";
  return null;
}

// ── Notes ──────────────────────────────────────────────────────────────────────────────────────

/** The failures a hop is sent back once for, with a note; any other failure ends the turn. */
export type RetriedFailure = "repeat" | "declined" | "incomplete" | "overtime";

export function isRetriedFailure(kind: string): kind is RetriedFailure {
  return kind === "repeat" || kind === "declined" || kind === "incomplete" || kind === "overtime";
}

/**
 * The note a failed hop goes again with. The failed output itself stays out of the loop: a loop
 * read back invites more of it, and a refusal is not worth the tokens.
 */
export function retryNote(locale: Locale, kind: RetriedFailure): string {
  const en = locale === "en";
  switch (kind) {
    case "repeat":
      return en
        ? "(App note) Your last reply kept repeating the same sentence; it was cut off and not sent. Do not restate it or write a sign-off: do the next step by calling the tool directly, and if you reply, say the conclusion once."
        : "（应用提示）你上一条回复一直在重复同一句话，已被中止，没有发出去。不要复述，也不要写收尾话：接着要做的事直接调用工具去做；要回复就只写一次结论。";
    case "declined":
      return en
        ? "(App note) Your last reply gave no answer, only a one-line refusal, and it was not sent. Look again at what this job needs: if you can do it, carry on with the next step; if a part really cannot be done, say which part, why, and what you need from whom."
        : "（应用提示）你上一条回复没有给出内容，只有一句拒答，没有发出去。重新看一下这件事要做什么：能做就接着做下一步；确实有做不了的部分，就直说是哪一部分、为什么，以及需要谁做什么。";
    case "incomplete":
      return en
        ? "(App note) Your last reply did not arrive whole (the stream broke off, or a tool call's arguments were incomplete); nothing of it was run or sent. Give this step again."
        : "（应用提示）你上一条回复没有完整到达（流中途断了，或者工具调用的参数不完整），没有执行，也没有发出去。重新给出这一步。";
    case "overtime":
      return en
        ? "(App note) Your last reply ran past this step's time limit; it was cut off and not sent. Do the next step by calling the tool directly; put long content in files, written in parts, and keep the reply to the conclusion."
        : "（应用提示）你上一条回复写了太久，超过了这一步的时间上限，被中止了，没有发出去。要做的事直接调用工具去做；长内容写进文件并分块写，回复只写结论。";
  }
}

/**
 * The note a reply cut off at the output cap goes on with, once. Cut in prose, the text so far stays
 * in the loop so the Bot can carry on from it, but none of it is posted. Cut inside a tool call's
 * arguments, the call cannot run, and the way through is smaller calls.
 */
export function continueNote(locale: Locale, toolArgsCut: boolean): string {
  const en = locale === "en";
  if (toolArgsCut) {
    return en
      ? "(App note) Your last tool call's arguments reached the output limit and were cut off; it was not run. Write in parts: write the first part with write_file and append the rest with shell, or split it into several files, keeping each call well under the limit."
      : "（应用提示）你上一次工具调用的参数写到了输出上限，被截断了，没有执行。分块写：先用 write_file 写第一部分，其余部分用 shell 追加，或者拆成几个文件，每次调用都远小于上限。";
  }
  return en
    ? "(App note) Your last reply reached the output limit and was cut off; it was not sent. Carry on: do the next step by calling the tool directly; put long content in files, written in parts, and keep the reply to the conclusion."
    : "（应用提示）你上一条回复写到了输出上限，被截断了，没有发出去。接着写：要做的事直接调用工具去做；长内容写进文件并分块写，回复只写结论。";
}
