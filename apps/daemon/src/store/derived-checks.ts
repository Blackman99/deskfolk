/**
 * Checks from your words (ADR 0040 P3), kept: per dimension, at most one gate (`active`: a check you
 * confirmed) and at most one offer (`proposed`), brought in line with what you said whenever that
 * may have changed.
 *
 * - A number you state (`derivedStatements`) only ever makes or refreshes an offer: nothing becomes
 *   a gate but your click (`confirmDerivedCheck`: a card's 确认, or the board). The offer follows your
 *   latest target statement, or failing any, your latest reading; said again from another line, its
 *   card comes back with how many times you have said it (`counts`; the board's fields count once).
 * - A gate never changes by itself: a later, different target is offered as its replacement and the
 *   gate stays in force until you choose. Erasing the words you confirmed it on turns it back into
 *   an offer, which stays until you act on it; nothing else takes it away.
 * - What you chose against — a number you removed or turned down, every other number said before
 *   one you confirmed — does not count from the words you had said by then; words said later do.
 *   When the latest is one you turned down, nothing is offered: an older number does not come back.
 * - An offer goes with its words (erased, or filed under another plan).
 *
 * Each check is bound, by name, to the plan's final deliverable once a Bot delivers one (see
 * `bindRuleOf`), and follows a newer one when it comes. Offers are measured too, so you and the
 * reviewing Bots see what the cut does against them, but only a gate with a file holds a plan open or
 * proves anything (`derivedNotGate`): a misread number costs a card.
 *
 * `source` is `user` on every one of these (the CHECK stays as it is until the last phase) and the
 * organizer never touches them; `origin` says they were derived.
 */
import type { CheckMeasure } from "@real-bot/protocol";
import { bindRuleOf, DERIVED_DIMENSIONS, derivedStatements, filmTicket, measureOf, partTicket, readingLabel, sameAsk, type QuoteForChecks, type Statement } from "../derived-checks";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import type { Dimension } from "../quote-dimensions";
import { takeCodePoints } from "../text";
import { CHECK_ITEM_MAX, type AcceptanceCheckRow } from "./acceptance-checks";
import { citedPathExists } from "./messages";
import type { QuoteVia } from "./quotes";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { getTask, isReservedTaskPath, namedAfterJob, type Task } from "./tasks";
import { recordWorkEvent } from "./work-events";

/** What one sync did, by check id, for the engine to tell you about and to run. */
export type DerivedChecksChange = {
  /** Offered to you: a number of yours no check stood on yet, or the replacement for a gate. */
  proposed: string[];
  /** Offers you have just said again, from a line that had not said it: their card comes back. */
  repeated: string[];
  /** Gates whose confirm-time words were erased: offers again, told to you. */
  demoted: string[];
  /** Pointed at the plan's final deliverable, a first one or a newer one; each wants a measure. */
  bound: string[];
  /** Of `bound`, those that had a file already and moved to a newer one. */
  rebound: string[];
  /** Taken away because the words they stood on went, or a later number replaced the offer. */
  dropped: string[];
  /** For each offer in `proposed` / `repeated`, how many separate lines of yours have said it. */
  counts: Record<string, number>;
};

function noChange(): DerivedChecksChange {
  return { proposed: [], repeated: [], demoted: [], bound: [], rebound: [], dropped: [], counts: {} };
}

type QuoteRow = { id: string; body: string; via: QuoteVia; created_at: string; ticket_id: string | null; ticket_title: string | null };

/**
 * Your words about the plan still readable, oldest first, with whether each was filed under a part
 * (a ticket named after the job itself never is: `namedAfterJob`) and what counts as one line of
 * it: words typed on the board count once per field group (the plan's fields, or one ticket's
 * description), however often you save it.
 */
function planQuotes(ctx: StoreContext, task: Task): QuoteForChecks[] {
  return ctx.db
    .query<QuoteRow, [string]>(
      `SELECT q.id, q.body, q.via, q.created_at, q.ticket_id, t.title AS ticket_title
       FROM user_quotes q LEFT JOIN tickets t ON t.id = q.ticket_id
       WHERE q.task_id = ? AND q.redacted_at IS NULL
       ORDER BY q.created_at ASC, q.rowid ASC`,
    )
    .all(task.id)
    .map((row) => ({
      id: row.id,
      body: row.body,
      via: row.via,
      source: row.via === "board" ? `board:${row.ticket_id ?? "plan"}` : row.id,
      at: row.created_at,
      aboutPart: row.ticket_title !== null && !namedAfterJob(ctx, task, row.ticket_title) && partTicket(row.ticket_title),
    }));
}

function measureOfRow(row: AcceptanceCheckRow): CheckMeasure | null {
  return row.measure ? (JSON.parse(row.measure) as CheckMeasure) : null;
}

/**
 * The plan's final deliverable: of the files its Bots delivered (attached to a Bot's line filed
 * under it, not on a part's or another version's ticket; a ticket named after the job is neither)
 * that are still there and `bindRuleOf`
 * accepts, the best named, newest first within a name — but a name outranks another only in the same
 * kind of place: a file in a `deliverables/` folder or the plan's own folder (its tickets' included)
 * beats one elsewhere whatever its name, so a MASTER a Bot keeps somewhere else never takes the check
 * from the plan's final cut. Newest by when a file was first delivered, not last cited: a reviewing
 * Bot comparing the new master with `EP01_MASTER_v1.mp4` does not hand v1 back.
 */
export function finalDeliverable(ctx: StoreContext, task: Task): { path: string; glob: string } | null {
  const delivered = ctx.db
    .query<{ path: string; titles: string | null }, [string]>(
      `SELECT a.workspace_relpath AS path, GROUP_CONCAT(t.title, char(10)) AS titles
       FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN tickets t ON t.id = m.ticket_id
       WHERE m.task_id = ? AND m.kind = 'bot'
       GROUP BY a.workspace_relpath
       ORDER BY MIN(m.created_at) DESC, MIN(a.rowid) DESC`,
    )
    .all(task.id);
  let best: { path: string; glob: string; rank: number } | null = null;
  for (const { path, titles } of delivered) {
    const rule = bindRuleOf(path);
    if (!rule) continue;
    const inPlace = path.split("/").slice(0, -1).includes("deliverables") || path.startsWith(`${task.dir}/`);
    const rank = (inPlace ? 0 : 3) + rule.rank;
    if (best && best.rank <= rank) continue;
    if ((titles ?? "").split("\n").some((title) => title && !namedAfterJob(ctx, task, title) && !filmTicket(title))) continue;
    if (isReservedTaskPath(task.dir, path) || !citedPathExists(ctx, path)) continue;
    best = { path, glob: rule.glob, rank };
    if (rank === 0) break;
  }
  return best ? { path: best.path, glob: best.glob } : null;
}

/** Checks the app took away (their words went, or a later number replaced the offer), as opposed to you. */
function removedByApp(ctx: StoreContext, taskId: string): Set<string> {
  return new Set(
    ctx.db
      .query<{ id: string }, [string]>(
        `SELECT json_extract(payload, '$.check') AS id FROM work_events WHERE kind = 'check.dropped' AND task_id = ?`,
      )
      .all(taskId)
      .map((row) => row.id),
  );
}

/**
 * Brings the plan's checks from your words in line with your words and its deliveries (see the
 * top of this file). Called wherever either may have changed: once a line or an answer of yours
 * is filed, when a turn of the plan ends, after you edit the plan on the board, after you confirm
 * or remove one. Does nothing for a plan that is gone.
 */
export function syncDerivedChecks(ctx: StoreContext, taskId: string): DerivedChecksChange {
  const change = noChange();
  let task: Task;
  try {
    task = getTask(ctx, taskId);
  } catch {
    return change;
  }
  const locale = settingsCached(ctx).locale;
  const statements = derivedStatements(planQuotes(ctx, task));
  const rows = ctx.db.query<AcceptanceCheckRow, [string]>(`SELECT * FROM acceptance_checks WHERE task_id = ? AND origin = 'derived' ORDER BY created_at ASC, id ASC`).all(taskId);
  const byApp = removedByApp(ctx, taskId);

  // Each write on the store's own clock, which never repeats: checks made in one step list in the
  // order your words gave them.
  const insert = (statement: Statement): string => {
    const at = isoNow();
    const id = ulid(Date.parse(at));
    const item = takeCodePoints(readingLabel(statement.reading, locale), CHECK_ITEM_MAX).text;
    ctx.db.run(
      `INSERT INTO acceptance_checks
         (id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd, expect_exit, expect_stdout, timeout_sec, source,
          created_at, updated_at, defined_at, first_passed_at, removed_at, origin, measure, quote_id, bind_kind, bind_glob, derived_state)
       VALUES (?, ?, NULL, ?, 'exists', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 'user', ?, ?, ?, NULL, NULL, 'derived', ?, ?, NULL, NULL, 'proposed')`,
      [id, taskId, item, at, at, at, JSON.stringify(statement.measure), statement.quoteId],
    );
    recordWorkEvent(ctx, {
      kind: "check.derived",
      actor: "app",
      taskId,
      payload: { check: id, quote: statement.quoteId, dimension: statement.reading.dimension, measure: statement.measure, change: "proposed" },
    });
    return id;
  };
  const standOn = (row: AcceptanceCheckRow, quoteId: string): void => {
    if (row.quote_id !== quoteId) ctx.db.run(`UPDATE acceptance_checks SET quote_id = ? WHERE id = ?`, [quoteId, row.id]);
  };
  const drop = (row: AcceptanceCheckRow): void => {
    const at = isoNow();
    ctx.db.run(`UPDATE acceptance_checks SET removed_at = ?, updated_at = ? WHERE id = ?`, [at, at, row.id]);
    recordWorkEvent(ctx, { kind: "check.dropped", actor: "app", taskId, payload: { check: row.id, quote: row.quote_id } });
    change.dropped.push(row.id);
  };

  // Your confirms, and when, and the words each stood on then: every other number you had said by
  // then is one you chose against, and a gate stands on those words.
  const confirms = ctx.db
    .query<{ id: string; at: string; quote: string | null }, [string]>(
      `SELECT json_extract(payload, '$.check') AS id, at, json_extract(payload, '$.quote') AS quote FROM work_events
       WHERE kind = 'check.confirmed' AND task_id = ? ORDER BY seq ASC`,
    )
    .all(taskId);
  const confirmed = new Set(confirms.map((row) => row.id));
  const readable = (quoteId: string | null): boolean =>
    !!quoteId && !!ctx.db.query(`SELECT 1 FROM user_quotes WHERE id = ? AND redacted_at IS NULL`).get(quoteId);
  // Lines of yours that count as one each: one quote, or the board's field group.
  const sources = (said: readonly Statement[]): number => new Set(said.map((statement) => statement.source)).size;

  for (const dimension of DERIVED_DIMENSIONS) {
    const mine = rows.filter((row) => measureOfRow(row)?.dimension === dimension);
    const live = mine.filter((row) => row.removed_at === null);
    let gate = live.find((row) => row.derived_state === "active") ?? null;
    let offer = live.find((row) => row.derived_state !== "active") ?? null;
    // What you chose against, and when: a number you removed or turned down, and every other number
    // said before a confirm of yours. Words said by then do not bring it back; words said later do.
    const removals = mine.flatMap((row) => (row.removed_at !== null && !byApp.has(row.id) ? [{ measure: measureOfRow(row)!, at: row.removed_at }] : []));
    const choices = confirms.flatMap((confirm) => {
      const row = mine.find((candidate) => candidate.id === confirm.id);
      return row ? [{ measure: measureOfRow(row)!, at: confirm.at }] : [];
    });
    const refused = (statement: Statement): boolean =>
      removals.some((no) => sameAsk(no.measure, statement.measure) && statement.at <= no.at) ||
      choices.some((yes) => !sameAsk(yes.measure, statement.measure) && statement.at <= yes.at);
    const said = statements.get(dimension) ?? [];
    const targets = said.filter((statement) => statement.target);

    // A gate stands on the words you confirmed it on. Erased, it is an offer again — told to you,
    // never quietly deleted — and whatever offer stood beside it gives way.
    if (gate) {
      const at = confirms.filter((confirm) => confirm.id === gate!.id).at(-1);
      if (!readable(at?.quote ?? gate.quote_id)) {
        if (offer) drop(offer);
        ctx.db.run(`UPDATE acceptance_checks SET derived_state = 'proposed', updated_at = ? WHERE id = ?`, [isoNow(), gate.id]);
        recordWorkEvent(ctx, { kind: "check.derived", actor: "app", taskId, payload: { check: gate.id, quote: gate.quote_id, dimension, measure: measureOfRow(gate), change: "demoted" } });
        change.demoted.push(gate.id);
        offer = { ...gate, derived_state: "proposed" };
        gate = null;
      }
    }

    // The offer for `last`: the one standing if it asks the same (its card comes back when a line of
    // yours that had not said it says it now), else a new one.
    const offerFor = (last: Statement): void => {
      const same = said.filter((statement) => sameAsk(statement.measure, last.measure) && !refused(statement));
      const newest = same.at(-1) ?? last;
      const times = sources(same.length > 0 ? same : [last]);
      if (offer && sameAsk(measureOfRow(offer)!, last.measure)) {
        if (offer.quote_id !== newest.quoteId) {
          if (times > sources(same.filter((statement) => statement.quoteId !== newest.quoteId)) && times >= 2) {
            change.repeated.push(offer.id);
            change.counts[offer.id] = times;
          }
          standOn(offer, newest.quoteId);
        }
        return;
      }
      if (offer) drop(offer);
      const id = insert({ ...last, quoteId: newest.quoteId });
      change.proposed.push(id);
      change.counts[id] = times;
    };

    if (gate) {
      // Only a target of yours is offered in a gate's place, and the gate stays in force meanwhile.
      const last = targets.at(-1);
      if (!last || refused(last) || sameAsk(measureOfRow(gate)!, last.measure)) {
        if (offer) drop(offer);
        continue;
      }
      offerFor(last);
      continue;
    }

    // No gate: an offer for the latest target you gave, or failing any, the latest reading. If you
    // turned that one down, nothing: an older number does not come back in its place. An offer you
    // once confirmed is kept even when no words of yours stand for it any more.
    const last = targets.at(-1) ?? said.at(-1);
    if (!last) {
      if (offer && !confirmed.has(offer.id)) drop(offer);
      continue;
    }
    if (refused(last)) {
      if (offer && !sameAsk(measureOfRow(offer)!, last.measure)) drop(offer);
      continue;
    }
    offerFor(last);
  }

  const live = ctx.db
    .query<AcceptanceCheckRow, [string]>(`SELECT * FROM acceptance_checks WHERE task_id = ? AND origin = 'derived' AND removed_at IS NULL`)
    .all(taskId);
  // Looked for only when there is something to bind: this runs at the end of every turn. An offer
  // is bound too, so a confirm has a file to measure at once.
  const deliverable = live.length > 0 ? finalDeliverable(ctx, task) : null;
  if (deliverable) {
    for (const row of live) {
      if (row.path === deliverable.path && row.bind_kind === "glob") continue;
      // A new file is a new thing to prove: what the check said about the last one does not carry over.
      const at = isoNow();
      ctx.db.run(
        `UPDATE acceptance_checks SET path = ?, bind_kind = 'glob', bind_glob = ?, updated_at = ?, defined_at = ?, first_passed_at = NULL WHERE id = ?`,
        [deliverable.path, deliverable.glob, at, at, row.id],
      );
      ctx.db.run(`DELETE FROM acceptance_check_runs WHERE check_id = ?`, [row.id]);
      recordWorkEvent(ctx, { kind: "check.bound", actor: "app", taskId, payload: { check: row.id, path: deliverable.path, glob: deliverable.glob } });
      change.bound.push(row.id);
      if (row.bind_kind) change.rebound.push(row.id);
    }
  }
  return change;
}

/** Whether anything in a sync is worth telling you about or running. */
export function derivedChanged(change: DerivedChecksChange): boolean {
  return [change.proposed, change.repeated, change.demoted, change.bound, change.dropped].some((ids) => ids.length > 0);
}

/**
 * You put a check from your words in force (a card's 确认, or the board). An offer that would
 * replace a gate takes its place, the gate removed as by you; the numbers your choice turned down
 * (the gate's, and every other you had said by then) are not offered again from what you had said.
 * The words the check stands on now are kept with the confirm: it stays in force until you remove it
 * or those words are erased. Returns the plan's id; the caller syncs it afterwards.
 */
export function confirmDerivedCheck(ctx: StoreContext, checkId: string): { taskId: string; changed: boolean } {
  const row = ctx.db.query<AcceptanceCheckRow, [string]>(`SELECT * FROM acceptance_checks WHERE id = ?`).get(checkId);
  if (!row) throw new HttpError(404, "not_found", "check not found");
  if (row.origin !== "derived") throw new HttpError(422, "invalid_args", "only a check from your words is confirmed");
  if (row.removed_at !== null) throw new HttpError(409, "check_gone", "this check was removed");
  if (row.derived_state === "active") return { taskId: row.task_id, changed: false };
  const dimension = measureOfRow(row)?.dimension as Dimension | undefined;
  return ctx.db.transaction(() => {
    const at = isoNow();
    const other = ctx.db
      .query<AcceptanceCheckRow, [string, string]>(`SELECT * FROM acceptance_checks WHERE task_id = ? AND origin = 'derived' AND removed_at IS NULL AND id <> ?`)
      .all(row.task_id, row.id)
      .find((candidate) => measureOfRow(candidate)?.dimension === dimension);
    if (other) ctx.db.run(`UPDATE acceptance_checks SET removed_at = ?, updated_at = ? WHERE id = ?`, [at, at, other.id]);
    // A gate from now: a new definition, measured again at once.
    ctx.db.run(`UPDATE acceptance_checks SET derived_state = 'active', updated_at = ?, defined_at = ?, first_passed_at = NULL WHERE id = ?`, [at, at, row.id]);
    ctx.db.run(`DELETE FROM acceptance_check_runs WHERE check_id = ?`, [row.id]);
    recordWorkEvent(ctx, {
      kind: "check.confirmed",
      actor: "user",
      taskId: row.task_id,
      payload: { check: row.id, dimension: dimension ?? null, removed: other?.id ?? null, quote: row.quote_id },
    });
    return { taskId: row.task_id, changed: true };
  })();
}

