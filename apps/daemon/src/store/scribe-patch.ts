/**
 * The ledger's write protocol for the scribe (ADR 0040 P3). The scribe (scribe.ts) reads one filed
 * line of yours, or an answer you gave, and proposes a patch to the requirements ledger: entries
 * the line adds, entries it says again, entries it changes. None of it is taken on trust. Each item
 * is checked on its own — its quote has to be words of that line, and for anything new enough of
 * them to mean something — and one that fails is dropped and logged while the rest land. There is
 * no delete and no whole list to replace, and no change lands by itself: a change becomes a
 * proposed replacement beside the entry, which stays open until you choose. A change to a number
 * you gave (the line gives one other number for the entry's dimension) is proposed whatever
 * category the scribe named; the same number again only raises the entry; any other change is
 * proposed only beside an entry of the same category, or one with no category to tell by (a line
 * you typed on the board, an old rule), and one aimed at another category is dropped. So whatever
 * the scribe answers, every entry open before it is open after it (I9).
 *
 * The fallback capture is here too: a line that complains about a job that has already delivered,
 * which the scribe filed nothing for, is kept whole as a proposed entry, so a complaint is not lost
 * to a model that failed or saw nothing in it.
 */
import { soundsLikeComplaint } from "../complaint-words";
import { conversationWideEntry } from "../craft-words";
import { dimensionValueJson, readDimensionSpans, readDimensions } from "../quote-dimensions";
import { findWords, quoteWords } from "../quote-words";
import { takeCodePoints } from "../text";
import type { UserQuote } from "./quotes";
import {
  addRequirement,
  getRequirement,
  newNumberFor,
  planDomains,
  raiseRequirement,
  repeatsNumber,
  REQUIREMENT_NATURES,
  REQUIREMENT_QUOTE_MAX,
  requirementsBearingOn,
  setRequirementHere,
  type Requirement,
  type RequirementNature,
  type RequirementScope,
  type RequirementSourceKind,
} from "./requirements";
import type { StoreContext } from "./shared";
import { getTask } from "./tasks";
import { listTickets } from "./tickets";
import { recordWorkEvent } from "./work-events";

/** Who wrote an entry the scribe proposed, in `added_by` and the work log. */
export const SCRIBE_WRITER = "scribe";
/** Who wrote an entry the fallback capture kept. */
export const CAPTURE_WRITER = "capture";

/** New entries one line may bring: a line lists a few requirements, not dozens. */
export const SCRIBE_ADDS_MAX = 8;
/**
 * The fewest units (as {@link quoteWords} counts them) the words of a new entry or a proposed
 * replacement may be, or the whole line when it is shorter: one character of the line is in the
 * line, and says nothing, so an entry standing on it would stand on the scribe's restatement.
 * Words that read as one number for a running time, a resolution, an aspect or a frame rate
 * (「90 秒」「4K」「16:9」, quote-dimensions.ts) may be shorter: the number is what they say.
 */
export const SCRIBE_QUOTE_MIN = 4;
const CATEGORY_MAX = 40;

/**
 * Whether words of a line are too few to stand on as an entry: shorter than {@link SCRIBE_QUOTE_MIN}
 * units, not the whole line, and not one number for a dimension. A number is read with the line
 * around it (「画幅用 16:9」 makes 16:9 a ratio), so the words are one number when they hold exactly
 * one reading of the line, or read as one on their own.
 */
export function quoteTooShort(words: string, line: string): boolean {
  if (quoteWords(words).length >= Math.min(SCRIBE_QUOTE_MIN, quoteWords(line).length)) return false;
  if (readDimensions(words).length === 1) return false;
  const folded = words.normalize("NFKC");
  const text = line.normalize("NFKC");
  return readDimensionSpans(text).filter((span) => folded.includes(text.slice(span.start, span.end))).length !== 1;
}

/** The scribe's answer as parsed: each list as the model wrote it, every item still to be checked. */
export type ScribePatch = { adds: unknown[]; raises: unknown[]; supersedes: unknown[] };

export type ScribeOutcome = {
  added: string[];
  raised: string[];
  /** Proposed replacements, each beside the entry it would replace, which stays open. */
  proposed: string[];
  /** Items dropped, each logged as `scribe.rejected`. */
  rejected: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? takeCodePoints(trimmed, max).text : null;
}

function sameCategory(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase();
}

/**
 * Whether a change the scribe gives may be proposed beside `entry` by category: the category it
 * named is the entry's, or the entry has none (typed on the board, or an old rule taken in), so
 * nothing tells that the change is about something else. A proposal takes nothing out of force.
 */
function mayReplaceByCategory(named: string | null, entry: Requirement): boolean {
  return entry.category === null || sameCategory(named, entry.category);
}

function sourceKindOf(quote: UserQuote): RequirementSourceKind {
  return quote.via === "ask_answer" ? "ask_answer" : "message";
}

/**
 * Applies one scribe answer for `quote` (filed under a plan), in one write. `offered` are the entries
 * the scribe was shown: a raise or a change may only name one of them, and only while it is still
 * open. Changes are taken first, then raises, then additions, so a change that gives an entry's own
 * number again counts as its one raise for the line. Nothing here closes an entry.
 */
export function applyScribePatch(
  ctx: StoreContext,
  input: { quote: UserQuote; offered: readonly string[]; patch: ScribePatch },
): ScribeOutcome {
  const { quote, patch } = input;
  if (!quote.task_id) throw new Error("the scribe files only a quote filed under a plan");
  const taskId = quote.task_id;
  const offered = new Set(input.offered);
  const sourceKind = sourceKindOf(quote);
  const outcome: ScribeOutcome = { added: [], raised: [], proposed: [], rejected: 0 };

  return ctx.db.transaction(() => {
    const task = getTask(ctx, taskId);
    const ticketIds = new Set(listTickets(ctx, taskId).map((ticket) => ticket.id));
    const reject = (item: "add" | "raise" | "supersede", index: number, reason: string, requirement?: string): void => {
      outcome.rejected += 1;
      recordWorkEvent(ctx, {
        kind: "scribe.rejected",
        actor: SCRIBE_WRITER,
        taskId,
        sessionId: quote.session_id,
        payload: { quote: quote.id, item, index, reason, ...(requirement ? { requirement } : {}) },
      });
    };
    /** An entry the scribe was shown and may still act on; the reason it may not, otherwise. */
    const offeredEntry = (id: unknown): Requirement | string => {
      if (typeof id !== "string" || !offered.has(id)) return "not_offered";
      let entry: Requirement;
      try {
        entry = getRequirement(ctx, id);
      } catch {
        return "not_offered"; // purged since it was shown
      }
      return entry.status === "open" ? entry : "not_open";
    };

    const tooShort = (words: string): boolean => quoteTooShort(words, quote.body);
    const raisedIds = new Set<string>();
    const raise = (id: string): void => {
      raisedIds.add(id);
      raiseRequirement(ctx, id, { quoteId: quote.id, actor: SCRIBE_WRITER });
      outcome.raised.push(id);
    };

    const proposedFor = new Set<string>();
    patch.supersedes.forEach((raw, index) => {
      const item = asRecord(raw);
      const said = item ? text(item.quote, Number.MAX_SAFE_INTEGER) : null;
      if (!item || !said) return reject("supersede", index, "malformed");
      const entry = offeredEntry(item.requirement_id);
      if (typeof entry === "string") return reject("supersede", index, entry, typeof item.requirement_id === "string" ? item.requirement_id : undefined);
      const words = findWords(said, quote.body);
      if (!words) return reject("supersede", index, "quote_not_in_line", entry.id);
      // The entry's own number again («还是约 2 分钟吧»): it is said again, not replaced.
      if (repeatsNumber(entry, words)) {
        if (raisedIds.has(entry.id)) return reject("supersede", index, "duplicate", entry.id);
        return raise(entry.id);
      }
      // A new number for the entry's dimension («约 2 分钟» → «改成 3 分钟»): proposed whatever
      // category the scribe named, since the number says what it replaces. Anything else only
      // beside an entry of the same category, or of none.
      const number = newNumberFor(entry, words);
      if (!number && !mayReplaceByCategory(text(item.category, CATEGORY_MAX), entry)) return reject("supersede", index, "other_category", entry.id);
      if (!number && tooShort(words)) return reject("supersede", index, "quote_too_short", entry.id);
      if (proposedFor.has(entry.id)) return reject("supersede", index, "duplicate", entry.id);
      proposedFor.add(entry.id);
      const proposal = addRequirement(ctx, {
        scope: entry.scope,
        scopeId: entry.scope_id,
        domain: entry.domain,
        quote: words,
        restated: text(item.restated, REQUIREMENT_QUOTE_MAX),
        category: entry.category,
        polarity: entry.polarity,
        ...(number ? { dimension: number.dimension, value: dimensionValueJson(number) } : {}),
        sourceKind,
        sourceQuoteId: quote.id,
        addedBy: SCRIBE_WRITER,
        status: "proposed",
        supersedes: entry.id,
        nature: natureOf(item) ?? entry.nature,
      });
      outcome.proposed.push(proposal.id);
    });

    patch.raises.forEach((raw, index) => {
      const item = asRecord(raw);
      const said = item ? text(item.quote, Number.MAX_SAFE_INTEGER) : null;
      if (!item || !said) return reject("raise", index, "malformed");
      const entry = offeredEntry(item.requirement_id);
      if (typeof entry === "string") return reject("raise", index, entry, typeof item.requirement_id === "string" ? item.requirement_id : undefined);
      if (!findWords(said, quote.body)) return reject("raise", index, "quote_not_in_line", entry.id);
      if (raisedIds.has(entry.id)) return reject("raise", index, "duplicate", entry.id);
      raise(entry.id);
    });

    let adds = 0;
    // Read once and kept up to date as entries are added: the adds of one answer are weighed against each other too.
    const openHere = requirementsBearingOn(ctx, taskId, ["open"]);
    // The conversation-wide default is for video work (ADR 0042): 「段落之间要有过渡」 in a report is that report's.
    let video: boolean | undefined;
    const isVideo = (): boolean => (video ??= planDomains(ctx, taskId).includes("video"));
    patch.adds.forEach((raw, index) => {
      const item = asRecord(raw);
      const said = item ? text(item.quote, Number.MAX_SAFE_INTEGER) : null;
      if (!item || !said) return reject("add", index, "malformed");
      const words = findWords(said, quote.body);
      if (!words) return reject("add", index, "quote_not_in_line");
      if (tooShort(words)) return reject("add", index, "quote_too_short");
      if (adds >= SCRIBE_ADDS_MAX) return reject("add", index, "too_many");
      const category = text(item.category, CATEGORY_MAX);
      const { scope, scopeId } = addScope(item, {
        ticketIds,
        ticketId: quote.ticket_id,
        taskId,
        sessionId: task.session_id,
        wide: conversationWideEntry(natureOf(item), category, words) && isVideo(),
      });
      // The same words already stand as an open entry bearing on the plan that holds at least as
      // far as the new one would: said again, not a second entry. (A proposal does not count: it
      // is about replacing another entry, not this one.) A ticket's entry counts only for an
      // addition to that same ticket: one for the plan or the conversation raising it would leave
      // the words held for one piece of the work, and the next plan would inherit nothing. One you
      // set not to hold for this plan holds here again: you have just said its very words in it,
      // and a second entry beside it would put those words twice before every other plan of the
      // conversation.
      const key = quoteWords(words);
      const reaches = (row: Requirement): boolean => row.scope !== "ticket" || (scope === "ticket" && row.scope_id === scopeId);
      const same = openHere.find((row) => reaches(row) && quoteWords(row.quote) === key);
      if (same) {
        if (raisedIds.has(same.id) || outcome.added.includes(same.id)) return reject("add", index, "duplicate", same.id);
        if (same.excluded) {
          setRequirementHere(ctx, same.id, { taskId, holds: true, actor: SCRIBE_WRITER, quoteId: quote.id });
          same.excluded = false;
        }
        return raise(same.id);
      }
      adds += 1;
      const entry = addRequirement(ctx, {
        scope,
        scopeId,
        quote: words,
        restated: text(item.restated, REQUIREMENT_QUOTE_MAX),
        category,
        polarity: item.polarity === "must_not" ? "must_not" : "must",
        sourceKind,
        sourceQuoteId: quote.id,
        addedBy: SCRIBE_WRITER,
        nature: natureOf(item),
      });
      openHere.push({ ...entry, excluded: false });
      outcome.added.push(entry.id);
    });
    return outcome;
  })();
}

/** What the scribe read an item to be about (ADR 0055); null when it said nothing the ledger knows. */
function natureOf(item: Record<string, unknown>): RequirementNature | null {
  return REQUIREMENT_NATURES.includes(item.nature as RequirementNature) ? (item.nature as RequirementNature) : null;
}

/**
 * Where a new entry holds: a ticket when the scribe names exactly one of this plan's tickets (or the
 * line was filed under one and it names none); the conversation the plan lives in — the project —
 * when it says every job there should keep to it, or, in a video job, when it is about how the work
 * is made, how it looks or sounds, or what stays the same across a series (`wide`: the item's
 * `nature` as the scribe read it, else craft-words.ts: 背景连贯, 过门要有过渡, 色调偏冷, 左手) and not
 * said of one ticket, so the next job there has it
 * from the start (ADR 0042); else the plan.
 */
function addScope(
  item: Record<string, unknown>,
  at: { ticketIds: ReadonlySet<string>; ticketId: string | null; taskId: string; sessionId: string | null; wide: boolean },
): { scope: RequirementScope; scopeId: string } {
  if (item.scope_hint === "ticket") {
    const named = Array.isArray(item.targets) ? [...new Set(item.targets.filter((id): id is string => typeof id === "string" && at.ticketIds.has(id)))] : [];
    if (named.length === 1) return { scope: "ticket", scopeId: named[0]! };
    if (named.length === 0 && at.ticketId && at.ticketIds.has(at.ticketId)) return { scope: "ticket", scopeId: at.ticketId };
  }
  const wide = item.scope_hint === "project" || (at.wide && item.scope_hint !== "ticket");
  if (wide && at.sessionId) return { scope: "project", scopeId: at.sessionId };
  return { scope: "plan", scopeId: at.taskId };
}

/**
 * The plans that have a ticket handed over or done right now. Read as a line of yours arrives, it is
 * what the fallback capture judges the line by: by the time the capture runs, the line's filing or a
 * turn it woke has often sent that ticket back to doing over the very complaint.
 */
export function plansHandedOver(ctx: StoreContext): Set<string> {
  return new Set(
    ctx.db
      .query<{ task_id: string }, []>(`SELECT DISTINCT task_id FROM tickets WHERE status IN ('review', 'done')`)
      .all()
      .map((row) => row.task_id),
  );
}

/**
 * Whether the plan had delivered something before `at`: a Bot's line in it carrying a file, or a
 * ticket handed over or done — as `handedOver` read it when the line arrived, or, with no such
 * reading, a ticket still in review or done that has not moved since.
 */
function deliveredBefore(ctx: StoreContext, taskId: string, at: string, handedOver: ReadonlySet<string> | null): boolean {
  if (handedOver?.has(taskId)) return true;
  const file = ctx.db
    .query(
      `SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.task_id = ? AND m.kind = 'bot' AND m.created_at < ? LIMIT 1`,
    )
    .get(taskId, at);
  if (file || handedOver) return !!file;
  return !!ctx.db
    .query(`SELECT 1 FROM tickets WHERE task_id = ? AND status IN ('review', 'done') AND updated_at < ? LIMIT 1`)
    .get(taskId, at);
}

/**
 * The fallback capture: the scribe filed nothing for this line (it failed, found nothing, or every
 * item it gave was dropped), and the line complains about a job that had delivered by the time you
 * said it (`handedOver`: {@link plansHandedOver} as the line arrived). Whether it complains is
 * `objects`, as the line was read (ADR 0055); with no reading, the complaint words say. The line itself, as much as an
 * entry carries, becomes a proposed entry of the ticket it was filed under, else of the plan: shown
 * with the ledger, never a gate, for you to take up or mark as no requirement. Null when it does
 * not qualify.
 */
export function captureComplaint(
  ctx: StoreContext,
  quote: UserQuote,
  handedOver: ReadonlySet<string> | null = null,
  objects?: boolean,
): Requirement | null {
  if (!quote.task_id || quote.redacted_at || !quote.body.trim()) return null;
  if (!(objects ?? soundsLikeComplaint(quote.body)) || !deliveredBefore(ctx, quote.task_id, quote.created_at, handedOver)) return null;
  const onTicket = quote.ticket_id !== null && listTickets(ctx, quote.task_id).some((ticket) => ticket.id === quote.ticket_id);
  return addRequirement(ctx, {
    scope: onTicket ? "ticket" : "plan",
    scopeId: onTicket ? quote.ticket_id : quote.task_id,
    quote: quote.body,
    sourceKind: sourceKindOf(quote),
    sourceQuoteId: quote.id,
    addedBy: CAPTURE_WRITER,
    status: "proposed",
  });
}
