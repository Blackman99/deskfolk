/**
 * 读句: what a line means, as the app acts on it (ADR 0055). Whether a line of yours tells the Bots
 * to stop or go on, only asks where the work stands, or objects to what was handed over; whether a
 * Bot's line says the work is still going, claims a run, has nothing in it, is a bare status, or only
 * asks the user's OK to go on (ADR 0058).
 * And which job a line of yours is about (ADR 0057) — that one has no word lists behind it.
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
import { findWords, quoteWords } from "./quote-words";
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
  /**
   * It only asks the user's OK to go on with what they already asked for — a sign-off on work in
   * progress, a go-ahead for the next step — with nothing only they can give and no choice of
   * theirs to make (ADR 0058). Only a model reads this: the word lists never say so.
   */
  goAhead: boolean;
};


/**
 * How much of a "still going" sentence must stand word for word in the line the Bot was answering
 * to be that line's own words, as the quote check folds them: a sentence repeated from it, not a
 * phrase both happen to use (「结论随后」).
 */
const REPEATED_MIN = 20;

/**
 * The sentence in which a Bot's line says the work goes on, unless it repeats the line the Bot was
 * answering: a translation's source put back above it, a quote, a text it was given to rewrite all
 * restate what that text promises, and nothing of it is the Bot's to carry on (2026-10-08: 专业翻译官
 * put your English paragraph back above its translation in your direct, and its 「Once it's back,
 * I'll compare the two」 was read as the Bot's own promise — sent back once, then a line about it).
 */
function ownLater(later: string | null, answering: string | null | undefined): string | null {
  if (!later || !answering) return later;
  const repeated = findWords(later, answering);
  return repeated !== null && quoteWords(repeated).length >= REPEATED_MIN ? null : later;
}

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

/** A Bot's line as the word lists read it; `answering` is the line it answers, when there is one. */
export function botLineByWords(body: string, answering?: string | null): BotLineReading {
  const later = ownLater(laterWorkSentence(body), answering);
  return {
    source: "words",
    later: later ? clipped(later, LATER_QUOTE_MAX) : null,
    claimsVerified: claimsVerification(body),
    noWork: isNoWorkCloser(body),
    bareStatus: isBareStatus(body.trim()),
    goAhead: false,
  };
}

/**
 * Where a line of yours belongs, as a model read it (ADR 0057). Nothing stands in for the model
 * here: a line it could not read (`unread`) is the Bot's to place at its desk, as is one it read as
 * new work (`new`), as something done in place (`in_place`) or could not tell which (`unclear`).
 */
export type FilingReading = {
  /** `unread` when no model read it: none set, the call failed or ran out of time, or the answer did not read. */
  source: "model" | "unread";
  /**
   * `jobs`: about the jobs in `targets`; `new`: new work with something to hand over or carry on with,
   * about none of the jobs it might have been; `in_place`: about none of them either, and done where
   * it was asked, the reply saying how it went — a question, a look-up, a setting, a small action, a
   * greeting; `unclear`: about one of the jobs, no telling which.
   */
  about: "jobs" | "new" | "in_place" | "unclear";
  /** What it is about, when `jobs`: a job, a ticket of it, a part of that ticket. */
  targets: Array<{ taskId: string; ticketId: string | null; partKey: string | null }>;
};

/** The jobs a reading of where a line belongs was shown, by the refs its answer names them with. */
export type FilingRefs = Array<{ ref: string; taskId: string; tickets: Array<{ ref: string; ticketId: string; parts: string[] }> }>;

/** Where a line goes when no model read it: nowhere yet, for the Bot's desk. */
export const UNREAD_FILING: FilingReading = { source: "unread", about: "unclear", targets: [] };

const ABOUT = ["jobs", "new", "in_place", "unclear"] as const;
/** At most this many targets one reading files a line under. */
const FILED_MAX = 6;

/**
 * A model's answer about where a line of yours belongs, checked against what it was shown: a job
 * by a ref it was given, a ticket of that job, parts that ticket has (a part named without its
 * ticket is the ticket's when only one ticket of the job has it). A ticket it got wrong leaves the
 * job; a job it got wrong is dropped, and with none left the line reads as `unclear`. Null when
 * the answer is not a reading at all.
 */
export function checkFilingReading(answer: Record<string, unknown>, refs: FilingRefs): FilingReading | null {
  const about = answer.about as (typeof ABOUT)[number];
  if (!ABOUT.includes(about)) return null;
  if (about !== "jobs") return { source: "model", about, targets: [] };
  const targets: FilingReading["targets"] = [];
  const push = (target: FilingReading["targets"][number]): void => {
    const known = targets.some((t) => t.taskId === target.taskId && t.ticketId === target.ticketId && t.partKey === target.partKey);
    if (!known && targets.length < FILED_MAX) targets.push(target);
  };
  for (const raw of Array.isArray(answer.jobs) ? answer.jobs : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const job = refs.find((candidate) => candidate.ref === entry.job);
    if (!job) continue;
    const named = Array.isArray(entry.parts) ? entry.parts.filter((key): key is string => typeof key === "string" && key !== "") : [];
    let ticket = typeof entry.ticket === "string" ? job.tickets.find((candidate) => candidate.ref === entry.ticket) ?? null : null;
    if (!ticket && named.length > 0) {
      const holders = job.tickets.filter((candidate) => named.every((key) => candidate.parts.includes(key)));
      if (holders.length === 1) ticket = holders[0]!;
    }
    const parts = ticket ? named.filter((key) => ticket!.parts.includes(key)) : [];
    if (ticket && parts.length > 0) for (const key of parts) push({ taskId: job.taskId, ticketId: ticket.ticketId, partKey: key });
    else push({ taskId: job.taskId, ticketId: ticket?.ticketId ?? null, partKey: null });
  }
  return targets.length > 0 ? { source: "model", about: "jobs", targets } : { source: "model", about: "unclear", targets: [] };
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
 * opening, since the model did say the line promises more; one that repeats `answering`, the line
 * the Bot answers, is that line's and not the Bot's. Null when the answer is not a reading.
 */
export function checkBotReading(answer: Record<string, unknown>, body: string, answering?: string | null): BotLineReading | null {
  const keys = ["later", "claims_verified", "no_work", "bare_status", "go_ahead"];
  if (!keys.some((key) => key in answer)) return null;
  const raw = typeof answer.later === "string" && answer.later.trim() ? answer.later : null;
  const later = ownLater(raw === null ? null : findWords(raw, body) ?? laterWorkSentence(body) ?? body, answering);
  return {
    source: "model",
    later: later === null || !later.trim() ? null : clipped(later, LATER_QUOTE_MAX),
    claimsVerified: answer.claims_verified === true,
    noWork: answer.no_work === true,
    bareStatus: answer.bare_status === true,
    goAhead: answer.go_ahead === true,
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

/** What a Bot's line answers, for reading it: the line that opened its segment and the mail it read there. */
export type BotLineContext = { answering?: string | null };

/** A Bot's line read by the word lists only: what a module built without the reader (a test) reads with. */
export function readBotLineByWords(body: string, _sessionId?: string | null, context?: BotLineContext): Promise<BotLineReading> {
  return Promise.resolve(botLineByWords(body, context?.answering));
}

/**
 * Whether a job is a large one (大活, ADR 0060): one to lay out in several units, with a sample made
 * and approved first. Only a model reads this — there is no word list for how big a thing is — and
 * a job no model could read stays unread (`source: "unread"`), which only the signal acts on.
 */
export type ScaleReading = {
  source: "model" | "unread";
  large: boolean;
  /** The words of yours that show it is large, as they are in your lines; null when none were quoted or found. */
  quote: string | null;
  /** What one unit of it is, in a few words (「一场」「一章」); null when not large. */
  unit: string | null;
};

export const UNREAD_SCALE: ScaleReading = { source: "unread", large: false, quote: null, unit: null };

/**
 * A model's answer about a job's size, checked: `large` a boolean, the quote kept only as words of
 * your lines (a quote the model made up is dropped, the reading stands), the unit a few words.
 * Null when the answer is not a reading at all.
 */
export function checkScaleReading(answer: Record<string, unknown>, said: readonly string[]): ScaleReading | null {
  if (typeof answer.large !== "boolean") return null;
  const quoted = typeof answer.quote === "string" && answer.quote.trim() ? answer.quote.trim() : null;
  const quote = quoted ? said.map((line) => findWords(quoted, line)).find((found): found is string => found !== null) ?? null : null;
  const unit = answer.large && typeof answer.unit === "string" && answer.unit.trim() ? clipped(answer.unit, 24) : null;
  return { source: "model", large: answer.large, quote: quote ? clipped(quote, 120) : null, unit };
}
