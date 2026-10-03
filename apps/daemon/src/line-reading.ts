/**
 * 读句: what a line means, as the app acts on it (ADR 0055). Whether a line of yours tells the Bots
 * to stop or go on, only asks where the work stands, or objects to what was handed over; whether a
 * Bot's line says the work is still going, claims a run, has nothing in it, or is a bare status.
 *
 * A model reads each line (`reader.ts`, the prompts in `prompts/reader.ts`); this file holds what the
 * reading is, the checks every answer goes through before anything acts on it (a quoted sentence
 * must be words of the line), and the reading the old word lists give, which is what the app goes
 * by when no model can read the line: none set, the call failed or ran out of time, or the answer
 * did not read. What either reading says is only ever understanding: the bounce, the card, the
 * hold are still written by the code that reads it, by the same rules as before (ADR 0040: 模型负责
 * 理解，状态只由确定性代码写入).
 */
import { isBareStatus } from "./bare-status";
import { clauseObjects, clausesOf } from "./complaint-words";
import { claimsVerification } from "./closing-check";
import { LATER_QUOTE_MAX, laterWorkSentence } from "./later-words";
import { isNoWorkCloser, noWorkShape } from "./no-work";
import { findWords } from "./quote-words";
import { takeCodePoints } from "./text";

/** Who read the line: a model, or the word lists when no model could. */
export type ReadingSource = "model" | "words";

/** What a line of yours says, for the app to act on. */
export type UserLineReading = {
  source: ReadingSource;
  /**
   * Whether the line tells the Bots to stop or to go on, now: `both` when it says each of something.
   * Null when the word lists read it: what a line of control is stays with the fixed rules of
   * `control-line.ts` then, as it always did.
   */
  control: "stop" | "go_on" | "both" | "none" | null;
  /** The line is nothing but that (who it is said to, politeness and emphasis aside). */
  controlOnly: boolean;
  /** The line only asks where the work stands, and nothing else. */
  statusOnly: boolean;
  /** The clauses, in the line's own words, that object to the work as it stands now; empty when none does. */
  objections: string[];
};

/** What a Bot's line says, for the app to act on. */
export type BotLineReading = {
  source: ReadingSource;
  /** The sentence, in the line's own words, saying the work is still going or more is to follow; null when none does. */
  later: string | null;
  /** It says something was run, tested or verified and came out fine. */
  claimsVerified: boolean;
  /** Nothing but that there is nothing to do, nothing to add or no reply needed. */
  noWork: boolean;
  /** Nothing but an acknowledgement, a claim of being done, a wait or a short promise: nothing of its own. */
  bareStatus: boolean;
};


function clipped(text: string, max: number): string {
  const cut = takeCodePoints(text.trim(), max);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

/** A line of yours as the word lists read it: `control` is left to the rules, the rest as they always read it. */
export function userLineByWords(body: string, opts: { statusQuestion: boolean }): UserLineReading {
  return {
    source: "words",
    control: null,
    controlOnly: false,
    statusOnly: opts.statusQuestion,
    objections: clausesOf(body).filter(clauseObjects),
  };
}

/** A Bot's line as the word lists read it. */
export function botLineByWords(body: string): BotLineReading {
  const later = laterWorkSentence(body);
  return {
    source: "words",
    later: later ? clipped(later, LATER_QUOTE_MAX) : null,
    claimsVerified: claimsVerification(body),
    noWork: isNoWorkCloser(body),
    bareStatus: isBareStatus(body.trim()),
  };
}

const CONTROL = ["stop", "go_on", "both", "none"] as const;

/**
 * A model's answer about a line of yours, checked: control one of its four values, flags true only
 * when the answer says so, and each objection kept as the words of the line it quotes (whatever
 * spaces, width or punctuation the model copied them with). An objection the model gave that is not
 * in the line is dropped; if every one was, the whole line stands as the one objection, since the
 * model did say the line objects. Null when the answer is not a reading at all.
 */
export function checkUserReading(answer: Record<string, unknown>, body: string): UserLineReading | null {
  if (!CONTROL.includes(answer.control as (typeof CONTROL)[number])) return null;
  const said = Array.isArray(answer.objections) ? answer.objections.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  const found = [...new Set(said.map((quote) => findWords(quote, body)).filter((words): words is string => words !== null))];
  const objections = found.length > 0 ? found : said.length > 0 && body.trim() ? [body.trim()] : [];
  const control = answer.control as UserLineReading["control"];
  return {
    source: "model",
    control,
    controlOnly: control !== "none" && answer.control_only === true,
    statusOnly: answer.status_only === true,
    objections,
  };
}

/**
 * A model's answer about a Bot's line, checked. `later` is kept as the words of the line it quotes;
 * a sentence the line does not hold falls back to the one the word lists find, else the line's
 * opening, since the model did say the line promises more. Null when the answer is not a reading.
 */
export function checkBotReading(answer: Record<string, unknown>, body: string): BotLineReading | null {
  const keys = ["later", "claims_verified", "no_work", "bare_status"];
  if (!keys.some((key) => key in answer)) return null;
  const raw = typeof answer.later === "string" && answer.later.trim() ? answer.later : null;
  const later = raw === null ? null : findWords(raw, body) ?? laterWorkSentence(body) ?? body;
  return {
    source: "model",
    later: later === null || !later.trim() ? null : clipped(later, LATER_QUOTE_MAX),
    claimsVerified: answer.claims_verified === true,
    noWork: answer.no_work === true,
    bareStatus: answer.bare_status === true,
  };
}

/**
 * Whether a Bot's line is only a no-work closer: by its shape when that settles it (nothing in it,
 * or too long, asking, naming someone, carrying a path), else as `read` reads it — so a line that
 * cannot be one costs no call.
 */
export async function readsAsNoWork(body: string, read: (body: string) => Promise<BotLineReading>): Promise<boolean> {
  const shape = noWorkShape(body);
  if (shape !== "maybe") return shape === "empty";
  return (await read(body)).noWork;
}

/** A Bot's line read by the word lists only: what a module built without the reader (a test) reads with. */
export function readBotLineByWords(body: string): Promise<BotLineReading> {
  return Promise.resolve(botLineByWords(body));
}
