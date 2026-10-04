/**
 * The requirements ledger as one plan sees it (ADR 0040 P3): the entries bearing on it, with how
 * often and in how many plans you said each, where the words were said and what it inherits from
 * the rest of its conversation; the board's rules and Done-when lines written into the ledger as
 * you edit them; the old rules of every plan taken in once; and how the app's cards about entries,
 * put up until 2026-10-04, still answer. The situation block every turn opens on and the board both
 * read from here, so a Bot and you see the same list.
 */
import type { Database } from "bun:sqlite";
import type { PlanRequirement } from "@real-bot/protocol";
import { conversationWide, craftEntry } from "../craft-words";
import { isoNow } from "../ids";
import { quoteWords } from "../quote-words";
import { takeCodePoints } from "../text";
import { userWrittenSpec } from "./plan-spec";
import { parsePlanSpec } from "./plan-shape";
import {
  addRequirement,
  confirmRequirement,
  getRequirement,
  getRequirementOrNull,
  IMPORT_WRITER,
  planDomains,
  raiseRequirement,
  rejectRequirement,
  REQUIREMENT_QUOTE_MAX,
  requirementsBearingOn,
  setRequirementHere,
  waiveRequirement,
  type BearingRequirement,
  type Requirement,
} from "./requirements";
import { setSetting, type StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** The settings key that says the old rules have been taken into the ledger, once. */
export const LEGACY_IMPORTED_KEY = "requirements_imported";

type QuoteRef = { via: "message" | "ask_answer" | "annotation" | "board"; session_id: string | null; message_id: string | null; at: string };

/**
 * Every entry bearing on the plan that is in force, proposed or old and unverified, as the board
 * shows it and the situation block reads it: each with how many plans the words raising it were
 * said in, where its own words were said, the plan it was first said in when that is another, and
 * whether you set it not to hold here. Oldest first.
 */
export function planRequirements(ctx: StoreContext, taskId: string): PlanRequirement[] {
  const entries = requirementsBearingOn(ctx, taskId, ["open", "proposed", "unverified"]);
  if (entries.length === 0) return [];
  const ids = JSON.stringify(entries.map((entry) => entry.id));
  const plans = new Map(
    ctx.db
      .query<{ id: string; n: number }, [string]>(
        `SELECT rid AS id, COUNT(DISTINCT t) AS n FROM (
           SELECT m.requirement_id AS rid, q.task_id AS t FROM requirement_mentions m JOIN user_quotes q ON q.id = m.quote_id
           WHERE m.requirement_id IN (SELECT value FROM json_each(?1)) AND q.task_id IS NOT NULL
           UNION SELECT id, origin_task_id FROM requirements WHERE id IN (SELECT value FROM json_each(?1)) AND origin_task_id IS NOT NULL)
         GROUP BY rid`,
      )
      .all(ids)
      .map((row) => [row.id, row.n]),
  );
  const sources = new Map(
    ctx.db
      .query<QuoteRef & { id: string }, [string]>(
        `SELECT r.id, q.via, q.session_id, q.message_id, q.created_at AS at
         FROM requirements r JOIN user_quotes q ON q.id = r.source_quote_id
         WHERE r.id IN (SELECT value FROM json_each(?1))`,
      )
      .all(ids)
      .map(({ id, ...ref }) => [id, ref]),
  );
  const titles = new Map<string, string | null>();
  const titleOf = (id: string): string | null => {
    if (!titles.has(id)) titles.set(id, ctx.db.query<{ title: string }, [string]>(`SELECT title FROM tasks WHERE id = ?`).get(id)?.title ?? null);
    return titles.get(id)!;
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const replaced = (id: string | null): PlanRequirement["supersedes"] => {
    if (!id) return null;
    const entry = byId.get(id) ?? ctx.db.query<Requirement, [string]>(`SELECT * FROM requirements WHERE id = ?`).get(id);
    return entry ? { id: entry.id, seq: entry.seq, quote: entry.quote } : null;
  };
  return entries.map((entry) => {
    const inherited = entry.origin_task_id && entry.origin_task_id !== taskId ? titleOf(entry.origin_task_id) : null;
    return {
      id: entry.id,
      seq: entry.seq,
      quote: entry.quote,
      restated: entry.restated,
      category: entry.category,
      polarity: entry.polarity,
      dimension: entry.dimension,
      value: entry.value,
      status: entry.status as PlanRequirement["status"],
      scope: entry.scope,
      ticket_id: entry.scope === "ticket" ? entry.scope_id : null,
      domain: entry.domain,
      times_raised: entry.times_raised,
      plans_raised: Math.max(1, plans.get(entry.id) ?? 0),
      last_raised_at: entry.last_raised_at,
      source_kind: entry.source_kind,
      source: sources.get(entry.id) ?? null,
      added_by: entry.added_by,
      inherited_from: inherited !== null && entry.origin_task_id ? { task_id: entry.origin_task_id, title: inherited } : null,
      excluded: entry.excluded,
      supersedes: replaced(entry.supersedes),
    };
  });
}

/** Whether two lines are the same words, as the ledger compares them. */
function sameWords(a: string, b: string): boolean {
  const key = quoteWords(a);
  return key !== "" && key === quoteWords(b);
}

/**
 * Whether a plan other than `taskId` still holds an entry that holds beyond one plan (one of the
 * whole conversation's, or a standing one) by those words, so that taking the line out of this
 * plan sets the entry aside here rather than letting it go: a plan that has not set it aside and
 * has the line on its board (rules or Done when), raised it by words of yours filed under it (not
 * erased), or is the plan it was first said in; or you widened it yourself (对这个会话都适用, 升为
 * 常设), which says it holds for the other plans by your own click.
 */
function heldElsewhere(ctx: StoreContext, entry: Requirement, taskId: string, line: string): boolean {
  const widenedByYou = ctx.db
    .query(
      `SELECT 1 FROM work_events w, json_each(w.payload, '$.requirements') r
       WHERE w.kind = 'requirement.rescope' AND w.actor = 'user' AND r.value = ?1
         AND json_extract(w.payload, '$.cause') IN ('whole_project', 'standing') LIMIT 1`,
    )
    .get(entry.id);
  if (widenedByYou) return true;
  const aside = new Set(
    ctx.db
      .query<{ task_id: string }, [string]>(`SELECT task_id FROM requirement_exclusions WHERE requirement_id = ?`)
      .all(entry.id)
      .map((row) => row.task_id),
  );
  aside.add(taskId);
  const holders = new Set(
    ctx.db
      .query<{ t: string }, [string]>(
        `SELECT q.task_id AS t FROM requirement_mentions m JOIN user_quotes q ON q.id = m.quote_id
         WHERE m.requirement_id = ?1 AND q.task_id IS NOT NULL AND q.redacted_at IS NULL
         UNION SELECT origin_task_id FROM requirements WHERE id = ?1 AND origin_task_id IN (SELECT id FROM tasks)`,
      )
      .all(entry.id)
      .map((row) => row.t),
  );
  if ([...holders].some((plan) => !aside.has(plan))) return true;
  // Another plan's board with the line: the conversation's plans for one of the conversation's, any for a standing one.
  const boards =
    entry.scope === "project"
      ? ctx.db.query<{ id: string; spec: string }, [string | null]>(`SELECT id, spec FROM tasks WHERE session_id = ? AND spec IS NOT NULL`).all(entry.scope_id)
      : ctx.db.query<{ id: string; spec: string }, []>(`SELECT id, spec FROM tasks WHERE spec IS NOT NULL`).all();
  return boards.some((plan) => {
    if (aside.has(plan.id)) return false;
    const spec = parsePlanSpec(plan.spec);
    return !!spec && [...spec.rules, ...spec.acceptance].some((other) => sameWords(other, line));
  });
}

/**
 * Your edit of a plan's rules or Done-when lines on the board, as ledger operations (ADR 0042),
 * inside the edit's own write, each naming the plan's version your edit made (`action`) in the work
 * log. Each line you brought in is an entry of the plan standing on the board quote kept of it
 * (`quoteOf`) — or, when the same words already bear on the plan as a whole (its own, its
 * conversation's or a standing entry; a ticket's holds for less than a line of the plan), that
 * entry said again: taken up if it was only proposed or an old rule nobody found your words for,
 * and holding here again if you had set it aside for this plan. Each line you took out lets go of
 * every entry with those words that holds here, whichever plan it came from. One of the plan's own
 * is waived when in force and rejected when it was only an old rule. One of the whole
 * conversation's, or a standing one, is set not to hold for this plan only while another plan
 * still holds those words ({@link heldElsewhere}: the line on its board, your words raising it
 * there, or it was first said there) — the one entry an old rule several plans of the conversation
 * shared was taken in as, or a line of yours here that only said another plan's entry again. When
 * no other plan does, the line you took out was its last hold, and it goes the same way as one of
 * the plan's own: a later plan of the conversation would otherwise inherit, or be asked about, a
 * line you took off the only board that had it.
 */
export function boardLedgerOps(
  ctx: StoreContext,
  input: { taskId: string; added: readonly string[]; removed: readonly string[]; quoteOf: (line: string) => string | null; action: string },
): void {
  const { taskId, action } = input;
  const bearing = (): BearingRequirement[] => requirementsBearingOn(ctx, taskId, ["open", "proposed", "unverified"]);
  // Held beyond this plan: every plan of the conversation, or every plan of a kind.
  const wider = (entry: Requirement): boolean => entry.scope === "project" || entry.scope === "standing";
  for (const line of input.removed) {
    for (const entry of bearing()) {
      if (entry.excluded || entry.status === "proposed" || !sameWords(entry.quote, line)) continue;
      if (entry.scope !== "plan" && !wider(entry)) continue;
      if (wider(entry) && heldElsewhere(ctx, entry, taskId, line)) setRequirementHere(ctx, entry.id, { taskId, holds: false, action });
      else if (entry.status === "open") waiveRequirement(ctx, entry.id, { taskId, action });
      else rejectRequirement(ctx, entry.id, { taskId, action });
    }
  }
  for (const line of input.added) {
    const quoteId = input.quoteOf(line);
    // A proposed replacement is about another entry, not these words standing alone.
    const matches = bearing().filter(
      (entry) => (entry.scope === "plan" || wider(entry)) && !(entry.status === "proposed" && entry.supersedes) && sameWords(entry.quote, line),
    );
    const same = matches.find((entry) => entry.status === "open" && !entry.excluded) ?? matches[0];
    if (same) {
      if (same.excluded) setRequirementHere(ctx, same.id, { taskId, holds: true, action });
      if (same.status !== "open") confirmRequirement(ctx, same.id, { taskId, action });
      if (quoteId) raiseRequirement(ctx, same.id, { quoteId, actor: "user", action });
      continue;
    }
    addRequirement(ctx, {
      scope: "plan",
      scopeId: taskId,
      quote: line,
      sourceKind: "board",
      sourceQuoteId: quoteId,
      addedBy: "user",
      originTaskId: taskId,
      action,
    });
  }
}

/**
 * The rules and Done-when lines every plan had before the ledger, taken into it once (ADR 0040 P3),
 * at the first open of a build that has it. What you typed on the board is in force, standing on
 * the board quote kept of it when there is one; a line found in your own words about the plan is in
 * force standing on them (`legacy`, verified); anything else — the organizer's lines — is an old
 * rule nobody found your words for (`unverified`): shown for reference, never in force, until you
 * say it is yours. In a video job (`planDomains`), a line about how the work is made, a choice of
 * how it looks or sounds, or what stays the same across a series (craft-words.ts) holds for the
 * plan's whole conversation, as a new one would; the rest, and every line of other work, for its
 * plan. A line whose words the plan already bears as a whole (taken in for it, or for its
 * conversation from another plan) is taken in once. Verified lines go first, so an old rule two
 * plans of one conversation share is in force once rather than also unverified. Returns what was
 * taken in.
 */
export function importLegacyRules(ctx: StoreContext): string[] {
  if (ctx.db.query(`SELECT 1 FROM settings WHERE key = ?`).get(LEGACY_IMPORTED_KEY)) return [];
  return ctx.db.transaction(() => {
    type Line = { taskId: string; sessionId: string | null; text: string; board: boolean; quoteId: string | null };
    const verified: Line[] = [];
    const unverified: Line[] = [];
    const plans = ctx.db
      .query<{ id: string; session_id: string | null; spec: string }, []>(
        `SELECT id, session_id, spec FROM tasks WHERE spec IS NOT NULL ORDER BY created_at ASC, rowid ASC`,
      )
      .all();
    for (const plan of plans) {
      const spec = parsePlanSpec(plan.spec);
      if (!spec) continue;
      const lines = [...new Set([...spec.rules, ...spec.acceptance].map((line) => line.trim()).filter(Boolean))];
      if (lines.length === 0) continue;
      const typed = userWrittenSpec(ctx, plan.id);
      const quotes = ctx.db
        .query<{ id: string; via: string; body: string }, [string]>(
          `SELECT id, via, body FROM user_quotes WHERE task_id = ? AND redacted_at IS NULL ORDER BY created_at ASC, rowid ASC`,
        )
        .all(plan.id)
        .map((quote) => ({ ...quote, words: quoteWords(quote.body) }));
      for (const text of lines) {
        const words = quoteWords(takeCodePoints(text, REQUIREMENT_QUOTE_MAX).text);
        const board = typed.rules.includes(text) || typed.acceptance.includes(text);
        const said = words ? quotes.find((quote) => (board ? quote.via === "board" && quote.words === words : quote.words.includes(words))) : undefined;
        const line = { taskId: plan.id, sessionId: plan.session_id, text, board, quoteId: said?.id ?? null };
        (board || said ? verified : unverified).push(line);
      }
    }
    const taken: string[] = [];
    const video = new Map<string, boolean>();
    const isVideo = (taskId: string): boolean => {
      if (!video.has(taskId)) video.set(taskId, planDomains(ctx, taskId).includes("video"));
      return video.get(taskId)!;
    };
    const take = (line: Line, status: "open" | "unverified"): void => {
      const project = line.sessionId !== null && conversationWide(null, line.text) && isVideo(line.taskId);
      const scope = project ? "project" : "plan";
      const scopeId = project ? line.sessionId! : line.taskId;
      // The same words already taken in for this plan, or for its whole conversation (a ticket's hold for less).
      const same = requirementsBearingOn(ctx, line.taskId, ["open", "proposed", "unverified"]).find(
        (entry) => entry.scope !== "ticket" && sameWords(entry.quote, line.text),
      );
      if (same) {
        if (line.quoteId && same.status === "open") raiseRequirement(ctx, same.id, { quoteId: line.quoteId, actor: IMPORT_WRITER });
        return;
      }
      const entry = addRequirement(ctx, {
        scope,
        scopeId,
        quote: line.text,
        sourceKind: line.board ? "board" : "legacy",
        sourceQuoteId: line.quoteId,
        addedBy: IMPORT_WRITER,
        status,
        originTaskId: line.taskId,
      });
      taken.push(entry.id);
    };
    for (const line of verified) take(line, "open");
    for (const line of unverified) take(line, "unverified");
    if (taken.length > 0) recordWorkEvent(ctx, { kind: "requirement.import", actor: IMPORT_WRITER, payload: { requirements: taken } });
    setSetting(ctx, LEGACY_IMPORTED_KEY, isoNow());
    return taken;
  })();
}

/** Categories compare folded, as the scribe's do. */
function categoryKey(category: string | null): string {
  return category ? category.normalize("NFKC").toLowerCase().trim() : "";
}

/** The conversation a plan lives in; null for one that belongs to none (or is gone). */
function sessionOf(ctx: StoreContext, taskId: string): string | null {
  return ctx.db.query<{ session_id: string | null }, [string]>(`SELECT session_id FROM tasks WHERE id = ?`).get(taskId)?.session_id ?? null;
}

/**
 * Whether an entry is one a standing card in a conversation could name, and 升为常设 widen:
 * in force, not standing yet, of `category`, about how the work is made (its `nature` as the scribe
 * read it, else craft-words.ts — a choice of look or sound such as 色调偏冷, a series' constants, a
 * running time, anything naming one part are not), and held by that conversation or one of its plans. Never a ticket's, which is
 * about one piece of the work, nor one of another conversation, which you said about other work.
 */
function standingCandidate(ctx: StoreContext, entry: Requirement, at: { sessionId: string; category: string }): boolean {
  const key = categoryKey(entry.category);
  if (entry.status !== "open" || !key || key !== categoryKey(at.category) || !craftEntry(entry.nature, entry.category, entry.quote)) return false;
  if (entry.scope === "project") return entry.scope_id === at.sessionId;
  return entry.scope === "plan" && sessionOf(ctx, entry.scope_id!) === at.sessionId;
}

/**
 * Whether 升为常设 on a standing card made for this plan (one put up before 2026-10-04) still widens
 * this entry: the card named it, and it is one such a card could name now — a craft entry of this
 * conversation, in force, of the card's category.
 */
export function mayMakeStanding(ctx: StoreContext, id: string, card: { taskId: string; category: string | null }): boolean {
  const sessionId = sessionOf(ctx, card.taskId);
  const entry = getRequirementOrNull(ctx, id);
  if (!sessionId || !entry || !card.category) return false;
  return standingCandidate(ctx, entry, { sessionId, category: card.category });
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** A card about old rules nobody pressed, none of whose rules is still unverified, says so in place of its buttons. */
const SETTLE_LEGACY_CARDS = `UPDATE messages SET control = json_set(control, '$.settled_at', ${NOW_SQL})
  WHERE json_valid(control) AND json_extract(control, '$.kind') = 'requirement' AND json_extract(control, '$.event') = 'legacy'
    AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0 AND json_type(control, '$.settled_at') IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(messages.control, '$.requirement_ids')) named
      JOIN requirements r ON r.id = named.value WHERE r.status = 'unverified')`;

/**
 * A card asking 「这些是你说的吗」 asks only while one of its old rules is still unverified. Once
 * you have gone through them on the board (逐条看, then each one's own button, or a rules edit
 * that takes a line up or off), 都是 would put nothing in force and the card would still ask:
 * it settles instead. Whoever moves the entry, an older build sharing the database included. A
 * press of 都是 confirms its rules first, then writes the press over this (`acted` wins).
 */
export const REQUIREMENT_CARD_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "requirement_cards_follow_ledger",
    sql: `CREATE TRIGGER requirement_cards_follow_ledger AFTER UPDATE OF status ON requirements
      WHEN OLD.status = 'unverified' AND NEW.status <> 'unverified'
      BEGIN
        ${SETTLE_LEGACY_CARDS}
          AND EXISTS (SELECT 1 FROM json_each(json_extract(messages.control, '$.requirement_ids')) WHERE value = OLD.id);
      END`,
  },
];

/** The cards a build without the trigger left asking after their rules were gone through, and any whose rules were purged; run on every open, after it. */
export function settleAnsweredLegacyCards(db: Database): void {
  db.run(`${SETTLE_LEGACY_CARDS} AND control LIKE '%"legacy"%'`);
}
