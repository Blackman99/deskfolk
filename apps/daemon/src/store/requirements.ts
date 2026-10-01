/**
 * The requirements ledger (需求台账, ADR 0040): what you asked of the work, each entry standing on
 * words of yours kept in `user_quotes`, which the store checks it quotes. Writers only add entries
 * and raise them again; a change of yours, a new number included, arrives as a proposed
 * replacement beside the entry, which stays open until you choose (I9). What takes an entry out of
 * force, or puts one in, is yours alone: a confirm, a rejection, a waiver, an entry set not to hold
 * for one plan, each a click on the board or a card, or a line you took off the board — and, for
 * an entry you set aside for a plan, your own words saying it again there. Every change is written
 * to the work log in the same write. The one way an entry is deleted is your purge, and the
 * database holds to that itself (I4): the triggers below refuse any delete the log has no purge
 * for, and any replacement that does not stand on later words of yours or your confirm.
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
  /** The ledger's own number, R-N. */
  seq: number;
  /** The plan the words were said about; null only when nothing says which. */
  origin_task_id: string | null;
};

type RequirementRow = Omit<Requirement, "value"> & { value: string | null };

/** As much of your words as one entry carries. */
export const REQUIREMENT_QUOTE_MAX = 300;

/** What the database raises when a requirement is deleted without your purge (I4). */
export const REQUIREMENT_PURGE_ABORT = "requirement_purge_only";

/** What the database raises when an entry is marked superseded without later words of yours replacing it (I4). */
export const REQUIREMENT_SUPERSEDE_ABORT = "requirement_supersede_needs_later_words";

/** Who took an old rule into the ledger, in `added_by`. */
export const IMPORT_WRITER = "import";

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
    /** The plan the words were said about; by default the plan of the quote it stands on, else the one it holds for. */
    originTaskId?: string | null;
    /** What you did that wrote it (the plan's version your board edit made), named in the work log. */
    action?: string | null;
    now?: string;
  },
): Requirement {
  const quote = takeCodePoints(input.quote.trim(), REQUIREMENT_QUOTE_MAX).text;
  if (!quote) throw new HttpError(422, "invalid_args", "a requirement needs your words");
  if ((input.scopeId === null) !== (input.scope === "standing")) {
    throw new HttpError(422, "invalid_args", "every scope but standing names what it holds for");
  }
  let origin = input.originTaskId ?? null;
  if (input.sourceQuoteId) {
    const source = ctx.db
      .query<{ body: string; redacted_at: string | null; task_id: string | null }, [string]>(
        `SELECT body, redacted_at, task_id FROM user_quotes WHERE id = ?`,
      )
      .get(input.sourceQuoteId);
    if (!source) throw new HttpError(404, "not_found", "quote not found");
    const words = quoteWords(quote);
    if (source.redacted_at || !words || !quoteWords(source.body).includes(words)) {
      throw new HttpError(422, "invalid_args", "a requirement's words must be words of the quote it names");
    }
    if (input.originTaskId === undefined) origin = source.task_id;
  }
  if (!origin && input.originTaskId === undefined) {
    if (input.scope === "plan") origin = input.scopeId;
    if (input.scope === "ticket") {
      origin = ctx.db.query<{ task_id: string }, [string]>(`SELECT task_id FROM tickets WHERE id = ?`).get(input.scopeId!)?.task_id ?? null;
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
          status, supersedes, times_raised, last_raised_at, added_by, created_at, updated_at, origin_task_id, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requirements))`,
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
        origin,
      ],
    );
    if (input.sourceQuoteId) addMention(ctx, id, input.sourceQuoteId, now);
    recordWorkEvent(ctx, {
      kind: "requirement.add",
      actor: input.addedBy,
      taskId: origin,
      payload: {
        requirement: id,
        scope: input.scope,
        scope_id: input.scopeId,
        source_kind: input.sourceKind,
        status,
        ...(input.action ? { action: input.action } : {}),
      },
    });
    return getRequirement(ctx, id);
  })();
}

/**
 * Words of yours saying it again: one more time raised, and the quote kept as a mention. `actor` is
 * who read the words as this entry, for the work log, as `addedBy` is for a new one; `action` what
 * you did that said it (the plan's version your board edit made).
 */
export function raiseRequirement(
  ctx: StoreContext,
  id: string,
  input: { quoteId: string; actor: string; action?: string | null; now?: string },
): Requirement {
  getRequirement(ctx, id);
  const quote = ctx.db.query<{ task_id: string | null }, [string]>(`SELECT task_id FROM user_quotes WHERE id = ?`).get(input.quoteId);
  if (!quote) throw new HttpError(404, "not_found", "quote not found");
  const now = input.now ?? isoNow();
  return ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE requirements SET times_raised = times_raised + 1, last_raised_at = ?1, updated_at = ?1 WHERE id = ?2`,
      [now, id],
    );
    addMention(ctx, id, input.quoteId, now);
    recordWorkEvent(ctx, {
      kind: "requirement.raise",
      actor: input.actor,
      taskId: quote.task_id,
      payload: { requirement: id, quote: input.quoteId, ...(input.action ? { action: input.action } : {}) },
    });
    return getRequirement(ctx, id);
  })();
}

// A video file a Bot handed over, or a video tool it called: the evidence that a plan is video work.
const VIDEO_FILE = /\.(?:mp4|mov|m4v|webm|mkv|avi)$/i;
const VIDEO_TOOL = /video/i;

/**
 * The kinds of work a plan is, by what was done in it, never by a label a model wrote: `video` once
 * a Bot's line filed under it carried a video file, or a turn in it called a video tool. Standing
 * entries of a kind hold for the plans of that kind.
 */
export function planDomains(ctx: StoreContext, taskId: string): string[] {
  const files = ctx.db
    .query<{ path: string }, [string]>(
      `SELECT a.workspace_relpath AS path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.task_id = ? AND m.kind = 'bot'`,
    )
    .all(taskId);
  if (files.some((row) => VIDEO_FILE.test(row.path))) return ["video"];
  const tools = ctx.db.query<{ tool: string }, [string]>(`SELECT DISTINCT tool FROM turn_runs WHERE task_id = ?`).all(taskId);
  return tools.some((row) => VIDEO_TOOL.test(row.tool)) ? ["video"] : [];
}

/** An entry as it bears on one plan: `excluded` when you said it does not hold for that plan. */
export type BearingRequirement = Requirement & { excluded: boolean };

/**
 * The entries bearing on a plan, in the given statuses: its own, its tickets', those of the
 * conversation it lives in (project) and the standing ones of its kinds of work ({@link planDomains};
 * a standing entry with no kind holds everywhere), each marked when you said it does not hold here.
 * Oldest first.
 */
export function requirementsBearingOn(ctx: StoreContext, taskId: string, statuses: readonly RequirementStatus[]): BearingRequirement[] {
  // What kinds of work the plan is only matters once some entry holds for a kind.
  const domains = ctx.db.query(`SELECT 1 FROM requirements WHERE scope = 'standing' LIMIT 1`).get() ? planDomains(ctx, taskId) : [];
  return ctx.db
    .query<RequirementRow & { excluded: number }, [string, string, string]>(
      `SELECT r.*, EXISTS (SELECT 1 FROM requirement_exclusions x WHERE x.requirement_id = r.id AND x.task_id = ?1) AS excluded
       FROM requirements r
       WHERE r.status IN (SELECT value FROM json_each(?2)) AND (
         (r.scope = 'plan' AND r.scope_id = ?1)
         OR (r.scope = 'ticket' AND r.scope_id IN (SELECT id FROM tickets WHERE task_id = ?1))
         OR (r.scope = 'project' AND r.scope_id = (SELECT session_id FROM tasks WHERE id = ?1))
         OR (r.scope = 'standing' AND (r.domain IS NULL OR r.domain IN (SELECT value FROM json_each(?3))))
       )
       ORDER BY r.created_at ASC, r.rowid ASC`,
    )
    .all(taskId, JSON.stringify(statuses), JSON.stringify(domains))
    .map(({ excluded, ...row }) => ({ ...toRequirement(row), excluded: excluded === 1 }));
}

/**
 * The open entries a line filed under this plan is weighed against: those bearing on it
 * ({@link requirementsBearingOn}) and not set aside for it. The most often raised first, then the
 * most recently raised, at most `limit`.
 */
export function openRequirementsFor(ctx: StoreContext, taskId: string, limit: number): Requirement[] {
  // Newest first before the sort, which keeps that order among equals.
  return requirementsBearingOn(ctx, taskId, ["open"])
    .filter((entry) => !entry.excluded)
    .reverse()
    .sort((a, b) => b.times_raised - a.times_raised || (a.last_raised_at < b.last_raised_at ? 1 : a.last_raised_at > b.last_raised_at ? -1 : 0))
    .slice(0, limit)
    .map(({ excluded: _excluded, ...entry }) => entry);
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

/** An entry that must be in one of `statuses` for what you are doing to it; 409 when it has moved on. */
function entryIn(ctx: StoreContext, id: string, statuses: readonly RequirementStatus[]): Requirement {
  const entry = getRequirement(ctx, id);
  if (!statuses.includes(entry.status)) throw new HttpError(409, "conflict", `this requirement is ${entry.status} now`);
  return entry;
}

/**
 * You took up a proposed entry, or said an old rule nobody found your words for is yours: it is in
 * force from now. A proposed replacement takes the place of the entry it names, which is marked
 * superseded by it — your click is what lets it (the work log's `requirement.confirm`, written
 * first, is what the trigger below accepts in place of later words of yours: the entry may have
 * been said again after the line the replacement stands on).
 */
export function confirmRequirement(
  ctx: StoreContext,
  id: string,
  input: { taskId: string | null; action?: string | null; now?: string },
): Requirement {
  const now = input.now ?? isoNow();
  return ctx.db.transaction(() => {
    const entry = entryIn(ctx, id, ["proposed", "unverified"]);
    const replaced = entry.supersedes && getRequirementOrNull(ctx, entry.supersedes)?.status === "open" ? entry.supersedes : null;
    recordWorkEvent(ctx, {
      kind: "requirement.confirm",
      actor: "user",
      taskId: input.taskId,
      payload: { requirement: id, task: input.taskId, replaced, ...(input.action ? { action: input.action } : {}) },
    });
    ctx.db.run(`UPDATE requirements SET status = 'open', updated_at = ? WHERE id = ?`, [now, id]);
    if (replaced) ctx.db.run(`UPDATE requirements SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`, [id, now, replaced]);
    return getRequirement(ctx, id);
  })();
}

/**
 * You said a proposed entry, or an old rule, is no requirement of yours: on the board, or by taking
 * its line off the plan. It stays in the ledger, out of force.
 */
export function rejectRequirement(
  ctx: StoreContext,
  id: string,
  input: { taskId: string | null; action?: string | null; now?: string },
): Requirement {
  return ctx.db.transaction(() => {
    entryIn(ctx, id, ["proposed", "unverified"]);
    ctx.db.run(`UPDATE requirements SET status = 'not_requirement', updated_at = ? WHERE id = ?`, [input.now ?? isoNow(), id]);
    recordWorkEvent(ctx, {
      kind: "requirement.reject",
      actor: "user",
      taskId: input.taskId,
      payload: { requirement: id, task: input.taskId, action: input.action ?? null },
    });
    return getRequirement(ctx, id);
  })();
}

/**
 * You let an entry in force go: on the board, or by taking its line off the plan's rules or Done
 * when. `action` names what you did, for the work log (the plan's version your edit made).
 */
export function waiveRequirement(
  ctx: StoreContext,
  id: string,
  input: { taskId: string | null; action?: string | null; now?: string },
): Requirement {
  return ctx.db.transaction(() => {
    entryIn(ctx, id, ["open"]);
    ctx.db.run(`UPDATE requirements SET status = 'waived', updated_at = ? WHERE id = ?`, [input.now ?? isoNow(), id]);
    recordWorkEvent(ctx, {
      kind: "requirement.waive",
      actor: "user",
      taskId: input.taskId,
      payload: { requirement: id, task: input.taskId, action: input.action ?? null },
    });
    return getRequirement(ctx, id);
  })();
}

/**
 * Yours, on the board or a card: an entry of a plan holds for every plan of its conversation from
 * now (`project`), or an entry holds for every plan of a kind of work (`standing`, `domain` saying
 * which). Only ever widens: nothing here narrows where an entry holds.
 */
export function widenRequirement(
  ctx: StoreContext,
  id: string,
  input: { to: "project" | "standing"; taskId: string | null; domain?: string | null; now?: string },
): Requirement {
  return ctx.db.transaction(() => {
    const entry = entryIn(ctx, id, ["open", "proposed", "unverified"]);
    let scopeId: string | null = null;
    if (input.to === "project") {
      if (entry.scope !== "plan") throw new HttpError(422, "invalid_args", "only a plan's own entry holds for its whole conversation");
      scopeId = ctx.db.query<{ session_id: string | null }, [string]>(`SELECT session_id FROM tasks WHERE id = ?`).get(entry.scope_id!)?.session_id ?? null;
      if (!scopeId) throw new HttpError(422, "invalid_args", "this plan belongs to no conversation any more");
    } else if (entry.scope === "standing") {
      return entry;
    }
    const domain = input.to === "standing" ? (input.domain ?? null) : entry.domain;
    ctx.db.run(`UPDATE requirements SET scope = ?, scope_id = ?, domain = ?, updated_at = ? WHERE id = ?`, [
      input.to,
      scopeId,
      domain,
      input.now ?? isoNow(),
      id,
    ]);
    recordWorkEvent(ctx, {
      kind: "requirement.rescope",
      actor: "user",
      taskId: input.taskId,
      payload: { requirements: [id], scope: input.to, scope_id: scopeId, domain, cause: input.to === "project" ? "whole_project" : "standing" },
    });
    return getRequirement(ctx, id);
  })();
}

/**
 * An entry a plan inherits does not hold for it (不适用这件事), or holds again. The entry is not
 * touched: every other plan still has it. Only for an entry the plan inherits — one of its
 * conversation, or a standing one — since the plan's own are let go with {@link waiveRequirement}.
 * Yours, on the board, or by taking its line off the plan's rules (`action`, the plan's version
 * your edit made); the one other way back is your own words saying it again in the plan (`quoteId`,
 * read as that entry by the scribe, `actor`): what you set aside you have just asked for here.
 */
export function setRequirementHere(
  ctx: StoreContext,
  id: string,
  input: { taskId: string; holds: boolean; action?: string | null; actor?: string; quoteId?: string; now?: string },
): Requirement {
  return ctx.db.transaction(() => {
    const entry = getRequirement(ctx, id);
    if (entry.scope !== "project" && entry.scope !== "standing") {
      throw new HttpError(422, "invalid_args", "only an entry this plan inherits can be set not to hold for it");
    }
    const changed = input.holds
      ? ctx.db.run(`DELETE FROM requirement_exclusions WHERE requirement_id = ? AND task_id = ?`, [id, input.taskId]).changes
      : ctx.db.run(`INSERT OR IGNORE INTO requirement_exclusions (requirement_id, task_id, created_at) VALUES (?, ?, ?)`, [
          id,
          input.taskId,
          input.now ?? isoNow(),
        ]).changes;
    if (changed > 0) {
      recordWorkEvent(ctx, {
        kind: input.holds ? "requirement.here_again" : "requirement.not_here",
        actor: input.actor ?? "user",
        taskId: input.taskId,
        payload: {
          requirement: id,
          task: input.taskId,
          ...(input.action ? { action: input.action } : {}),
          ...(input.quoteId ? { quote: input.quoteId } : {}),
        },
      });
    }
    return entry;
  })();
}

/** An entry, or null when there is none by that id (purged, say). */
export function getRequirementOrNull(ctx: StoreContext, id: string): Requirement | null {
  const row = ctx.db.query<RequirementRow, [string]>(`SELECT * FROM requirements WHERE id = ?`).get(id);
  return row ? toRequirement(row) : null;
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
  // every word the old one stands on, or by one you confirmed as its replacement with a click (the
  // work log's `requirement.confirm` naming both, which `confirmRequirement` writes first: the entry
  // may have been said again after the line the replacement stands on). The scribe never
  // supersedes anything (it only proposes, I9); this holds whatever does, an older or newer build
  // included.
  {
    name: "requirements_superseded_by_later",
    sql: `CREATE TRIGGER requirements_superseded_by_later BEFORE UPDATE OF status ON requirements
      WHEN NEW.status = 'superseded' AND OLD.status <> 'superseded' AND NOT EXISTS (
        SELECT 1 FROM requirements r JOIN user_quotes q ON q.id = r.source_quote_id
        WHERE r.id = NEW.superseded_by AND q.created_at > COALESCE(
          (SELECT MAX(created_at) FROM user_quotes
           WHERE id IN (SELECT quote_id FROM requirement_mentions WHERE requirement_id = OLD.id) OR id = OLD.source_quote_id),
          OLD.created_at)
      ) AND NOT EXISTS (
        SELECT 1 FROM work_events w
        WHERE w.kind = 'requirement.confirm' AND w.actor = 'user'
          AND json_extract(w.payload, '$.requirement') = NEW.superseded_by AND json_extract(w.payload, '$.replaced') = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, '${REQUIREMENT_SUPERSEDE_ABORT}'); END`,
  },
];
