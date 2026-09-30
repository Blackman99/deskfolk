/**
 * The requirements ledger (需求台账, ADR 0040): what you asked of the work, each entry standing on
 * words of yours kept in `user_quotes`, which the store checks it quotes. Entries are only added
 * to and raised again; a change of yours, a new number included, arrives as a proposed
 * replacement beside the entry, which stays open until you choose (I9). Every change is written to
 * the work log in the same write. The one way an entry is deleted is your purge, and the database
 * holds to that itself (I4): the triggers below refuse any delete the log has no purge for, and any
 * replacement that does not stand on later words of yours.
 */
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { dimensionValueJson, readDimensions, sameDimensionValue, type DimensionValue } from "../quote-dimensions";
import { quoteWords } from "../quote-words";
import { takeCodePoints } from "../text";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

export type RequirementScope = "part" | "ticket" | "plan" | "project" | "standing";
export type RequirementStatus = "proposed" | "open" | "superseded" | "waived" | "not_requirement" | "unverified";
export type RequirementSourceKind = "message" | "ask_answer" | "annotation" | "board" | "accepted_suggestion" | "legacy";

export type Requirement = {
  id: string;
  scope: RequirementScope;
  scope_id: string | null;
  domain: string | null;
  quote: string;
  restated: string | null;
  category: string | null;
  polarity: "must" | "must_not";
  dimension: string | null;
  value: unknown;
  source_kind: RequirementSourceKind;
  source_quote_id: string | null;
  status: RequirementStatus;
  supersedes: string | null;
  superseded_by: string | null;
  times_raised: number;
  last_raised_at: string;
  added_by: string;
  created_at: string;
  updated_at: string;
};

type RequirementRow = Omit<Requirement, "value"> & { value: string | null };

/** As much of your words as one entry carries. */
export const REQUIREMENT_QUOTE_MAX = 300;

/** What the database raises when a requirement is deleted without your purge (I4). */
export const REQUIREMENT_PURGE_ABORT = "requirement_purge_only";

/** What the database raises when an entry is marked superseded without later words of yours replacing it (I4). */
export const REQUIREMENT_SUPERSEDE_ABORT = "requirement_supersede_needs_later_words";

function toRequirement(row: RequirementRow): Requirement {
  return { ...row, value: row.value === null ? null : (JSON.parse(row.value) as unknown) };
}

export function getRequirement(ctx: StoreContext, id: string): Requirement {
  const row = ctx.db.query<RequirementRow, [string]>(`SELECT * FROM requirements WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "requirement not found");
  return toRequirement(row);
}

/** Oldest first. */
export function listRequirements(
  ctx: StoreContext,
  filter: { scope?: RequirementScope; scopeId?: string; status?: RequirementStatus } = {},
): Requirement[] {
  return ctx.db
    .query<RequirementRow, [string | null, string | null, string | null]>(
      `SELECT * FROM requirements
       WHERE (?1 IS NULL OR scope = ?1) AND (?2 IS NULL OR scope_id = ?2) AND (?3 IS NULL OR status = ?3)
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(filter.scope ?? null, filter.scopeId ?? null, filter.status ?? null)
    .map(toRequirement);
}

/**
 * The number an entry's words give for one of the four dimensions (quote-dimensions.ts), when they
 * give exactly one number in all: words with two, or none, make an entry with no number, which a
 * later number of yours is not proposed against by itself.
 */
function dimensionOfWords(quote: string): DimensionValue | null {
  const readings = readDimensions(quote);
  return readings.length === 1 ? readings[0]! : null;
}

/**
 * A new entry. `quote` is cut at {@link REQUIREMENT_QUOTE_MAX} code points: a front piece of your
 * words is still your words. The quote it came from, when there is one, is its first mention, and
 * the entry's words must be in it (compared as `quoteWords` folds them), whoever writes the entry:
 * an entry never stands on words its source does not hold, nor on words you erased. Unless the
 * caller says otherwise, `dimension` and `value` are what the words read as by fixed rules, so
 * which entries a later number is proposed against never rests on a model's labels.
 */
export function addRequirement(
  ctx: StoreContext,
  input: {
    scope: RequirementScope;
    scopeId: string | null;
    quote: string;
    sourceKind: RequirementSourceKind;
    sourceQuoteId?: string | null;
    addedBy: string;
    restated?: string | null;
    category?: string | null;
    polarity?: "must" | "must_not";
    dimension?: string | null;
    value?: unknown;
    domain?: string | null;
    status?: RequirementStatus;
    supersedes?: string | null;
    now?: string;
  },
): Requirement {
  const quote = takeCodePoints(input.quote.trim(), REQUIREMENT_QUOTE_MAX).text;
  if (!quote) throw new HttpError(422, "invalid_args", "a requirement needs your words");
  if ((input.scopeId === null) !== (input.scope === "standing")) {
    throw new HttpError(422, "invalid_args", "every scope but standing names what it holds for");
  }
  if (input.sourceQuoteId) {
    const source = ctx.db
      .query<{ body: string; redacted_at: string | null }, [string]>(`SELECT body, redacted_at FROM user_quotes WHERE id = ?`)
      .get(input.sourceQuoteId);
    if (!source) throw new HttpError(404, "not_found", "quote not found");
    const words = quoteWords(quote);
    if (source.redacted_at || !words || !quoteWords(source.body).includes(words)) {
      throw new HttpError(422, "invalid_args", "a requirement's words must be words of the quote it names");
    }
  }
  const now = input.now ?? isoNow();
  const id = ulid(Date.parse(now));
  const status = input.status ?? "open";
  const read = input.dimension === undefined ? dimensionOfWords(quote) : null;
  const dimension = input.dimension === undefined ? (read?.dimension ?? null) : input.dimension;
  const value = input.dimension === undefined ? (read ? dimensionValueJson(read) : undefined) : input.value;
  return ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO requirements
         (id, scope, scope_id, domain, quote, restated, category, polarity, dimension, value, source_kind, source_quote_id,
          status, supersedes, times_raised, last_raised_at, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        input.scope,
        input.scopeId,
        input.domain ?? null,
        quote,
        input.restated ?? null,
        input.category ?? null,
        input.polarity ?? "must",
        dimension,
        value === undefined ? null : JSON.stringify(value),
        input.sourceKind,
        input.sourceQuoteId ?? null,
        status,
        input.supersedes ?? null,
        now,
        input.addedBy,
        now,
        now,
      ],
    );
    if (input.sourceQuoteId) addMention(ctx, id, input.sourceQuoteId, now);
    recordWorkEvent(ctx, {
      kind: "requirement.add",
      actor: input.addedBy,
      payload: { requirement: id, scope: input.scope, scope_id: input.scopeId, source_kind: input.sourceKind, status },
    });
    return getRequirement(ctx, id);
  })();
}

/**
 * Words of yours saying it again: one more time raised, and the quote kept as a mention. `actor` is
 * who read the words as this entry, for the work log, as `addedBy` is for a new one.
 */
export function raiseRequirement(
  ctx: StoreContext,
  id: string,
  input: { quoteId: string; actor: string; now?: string },
): Requirement {
  getRequirement(ctx, id);
  if (!ctx.db.query(`SELECT 1 FROM user_quotes WHERE id = ?`).get(input.quoteId)) throw new HttpError(404, "not_found", "quote not found");
  const now = input.now ?? isoNow();
  return ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE requirements SET times_raised = times_raised + 1, last_raised_at = ?1, updated_at = ?1 WHERE id = ?2`,
      [now, id],
    );
    addMention(ctx, id, input.quoteId, now);
    recordWorkEvent(ctx, { kind: "requirement.raise", actor: input.actor, payload: { requirement: id, quote: input.quoteId } });
    return getRequirement(ctx, id);
  })();
}

/**
 * The open entries a line filed under this plan is weighed against: the plan's own, its tickets',
 * its conversation's (project) and the standing ones. The most often raised first, then the most
 * recently raised, at most `limit`.
 */
export function openRequirementsFor(ctx: StoreContext, taskId: string, limit: number): Requirement[] {
  return ctx.db
    .query<RequirementRow, [string, number]>(
      `SELECT * FROM requirements
       WHERE status = 'open' AND (
         (scope = 'plan' AND scope_id = ?1)
         OR (scope = 'ticket' AND scope_id IN (SELECT id FROM tickets WHERE task_id = ?1))
         OR (scope = 'project' AND scope_id = (SELECT session_id FROM tasks WHERE id = ?1))
         OR scope = 'standing'
       )
       ORDER BY times_raised DESC, last_raised_at DESC, rowid DESC
       LIMIT ?2`,
    )
    .all(taskId, limit)
    .map(toRequirement);
}

/** The number an entry keeps, as the dimension reader gives one; null for an entry with none. */
function entryNumber(entry: Requirement): DimensionValue | null {
  if (!entry.dimension || entry.value === null) return null;
  return { dimension: entry.dimension, ...(entry.value as Record<string, unknown>) } as DimensionValue;
}

/** The one number `quote` gives for the entry's dimension; null when it gives none or more than one. */
function numberFor(entry: Requirement, quote: string): DimensionValue | null {
  const readings = readDimensions(quote).filter((reading) => reading.dimension === entry.dimension);
  return readings.length === 1 ? readings[0]! : null;
}

/**
 * Whether `quote` gives an entry's own number again — one number for its dimension, the same
 * number and bound — so that words aimed at replacing it only say it again.
 */
export function repeatsNumber(entry: Requirement, quote: string): boolean {
  const before = entryNumber(entry);
  const said = before ? numberFor(entry, quote) : null;
  return !!before && !!said && sameDimensionValue(before, said);
}

/**
 * The one number `quote` gives for the entry's dimension when it is not the entry's own: words
 * that would change a number you gave («约 2 分钟» → «改成 3 分钟»). Null for an entry with no
 * number, or words giving none, more than one, or the same one.
 */
export function newNumberFor(entry: Requirement, quote: string): DimensionValue | null {
  const before = entryNumber(entry);
  const said = before ? numberFor(entry, quote) : null;
  return before && said && !sameDimensionValue(before, said) ? said : null;
}

/** Every quote that raised the entry, oldest first. */
export function requirementMentions(ctx: StoreContext, id: string): Array<{ quote_id: string; created_at: string }> {
  return ctx.db
    .query<{ quote_id: string; created_at: string }, [string]>(
      `SELECT quote_id, created_at FROM requirement_mentions WHERE requirement_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(id);
}

/**
 * Your purge: the one delete there is (I4). The purge goes into the work log first, in the same
 * write, and the trigger lets through exactly the entries it names; their mentions go with them.
 * Returns the ids that were there to delete.
 */
export function purgeRequirements(ctx: StoreContext, ids: readonly string[], opts: { taskId?: string | null } = {}): string[] {
  return ctx.db.transaction(() => {
    const present = [...new Set(ids)].filter((id) => ctx.db.query(`SELECT 1 FROM requirements WHERE id = ?`).get(id));
    if (present.length === 0) return [];
    recordWorkEvent(ctx, { kind: "requirement.purge", actor: "user", taskId: opts.taskId ?? null, payload: { requirements: present } });
    for (const id of present) {
      ctx.db.run(`DELETE FROM requirement_mentions WHERE requirement_id = ?`, [id]);
      ctx.db.run(`DELETE FROM requirements WHERE id = ?`, [id]);
    }
    return present;
  })();
}

/**
 * When a conversation is deleted, the entries that held for the whole of it (project scope) keep
 * standing with no conversation to name: a null `scope_id` is how the ledger says it was deleted.
 * Called inside the delete, and logged there like every other change to an entry.
 */
export function forgetRequirementsSession(ctx: StoreContext, sessionId: string, now: string = isoNow()): string[] {
  const ids = ctx.db
    .query<{ id: string }, [string, string]>(
      `UPDATE requirements SET scope_id = NULL, updated_at = ?1 WHERE scope = 'project' AND scope_id = ?2 RETURNING id`,
    )
    .all(now, sessionId)
    .map((row) => row.id);
  if (ids.length > 0) {
    recordWorkEvent(ctx, {
      kind: "requirement.rescope",
      actor: "user",
      sessionId,
      payload: { requirements: ids, scope: "project", scope_id: null, cause: "session_deleted" },
    });
  }
  return ids;
}

function addMention(ctx: StoreContext, requirementId: string, quoteId: string, now: string): void {
  ctx.db.run(`INSERT INTO requirement_mentions (id, requirement_id, quote_id, created_at) VALUES (?, ?, ?, ?)`, [
    ulid(Date.parse(now)),
    requirementId,
    quoteId,
    now,
  ]);
}

/**
 * I4 (ADR 0040): the database refuses to delete an entry unless the work log already holds your
 * purge naming it, whoever deletes — a later caller that forgot, or an older build. Made again on
 * every open by the migration, so the triggers are always this build's own.
 */
export const REQUIREMENT_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "requirements_purge_only",
    sql: `CREATE TRIGGER requirements_purge_only BEFORE DELETE ON requirements
      WHEN NOT EXISTS (
        SELECT 1 FROM work_events w, json_each(w.payload, '$.requirements') r
        WHERE w.kind = 'requirement.purge' AND r.value = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, '${REQUIREMENT_PURGE_ABORT}'); END`,
  },
  // The other half of I4: an entry is superseded only by one standing on words of yours said after
  // every word the old one stands on. Nothing in this build supersedes an entry (the scribe only
  // proposes, I9); this holds whatever does later to it, an older or newer build included. That
  // includes a proposed replacement you confirm by a click: the entry may have been raised again
  // after the proposal's line, so the confirm has to keep words of its own first (a board quote),
  // or this refuses it.
  {
    name: "requirements_superseded_by_later",
    sql: `CREATE TRIGGER requirements_superseded_by_later BEFORE UPDATE OF status ON requirements
      WHEN NEW.status = 'superseded' AND OLD.status <> 'superseded' AND NOT EXISTS (
        SELECT 1 FROM requirements r JOIN user_quotes q ON q.id = r.source_quote_id
        WHERE r.id = NEW.superseded_by AND q.created_at > COALESCE(
          (SELECT MAX(created_at) FROM user_quotes
           WHERE id IN (SELECT quote_id FROM requirement_mentions WHERE requirement_id = OLD.id) OR id = OLD.source_quote_id),
          OLD.created_at)
      )
      BEGIN SELECT RAISE(ABORT, '${REQUIREMENT_SUPERSEDE_ABORT}'); END`,
  },
];
