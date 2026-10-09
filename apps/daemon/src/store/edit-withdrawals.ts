/**
 * Words you took out of your own line (ADR 0063, 2026-10-10 addendum). An edit that removes words
 * left every ledger entry standing on them in force: on the IG MV job (2026-10-09 00:54) you edited
 * 「如果自己整不了模型就改成 2D 动画风格…也可以」 out of a line a minute after sending it, and R275 stayed
 * open beside the 3D direction that replaced it. The scribe now reads each edit against the entries
 * the line's earlier words stand on and names those the edit took back; each is marked on the board
 * (`withdraw_edit_id`) for you to retire or keep. Nothing leaves force without you (I9).
 *
 * Which entries the scribe is shown is structure only, never a comparison of words: entries whose
 * own words are a quote of this line, still open or proposed, not said again in another line, and
 * not already waiting on you for an edit.
 */
import { isoNow } from "../ids";
import type { MessageEdit } from "./message-edits";
import { getRequirement, type Requirement } from "./requirements";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** Who marked an entry for you to retire, in the work log. */
const SCRIBE_WRITER = "scribe";

/** The edit by its id; null once its line went with a cleared transcript. */
export function getMessageEdit(ctx: StoreContext, editId: string): MessageEdit | null {
  return ctx.db.query<MessageEdit, [string]>("SELECT * FROM message_edits WHERE id = ?").get(editId) ?? null;
}

/** Whether the scribe has read this edit (its answer is in the work log, which a restart keeps). */
export function editScribed(ctx: StoreContext, editId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'scribe.answer' AND json_extract(payload, '$.edit') = ? LIMIT 1`).get(editId));
}

/** The entries an edit of this line can have taken back (see the module note). */
export function editEarlierEntries(ctx: StoreContext, messageId: string): Requirement[] {
  return ctx.db
    .query<{ id: string }, [string]>(
      `SELECT r.id FROM requirements r
       WHERE r.source_quote_id IN (SELECT id FROM user_quotes WHERE message_id = ?1)
         AND r.status IN ('open', 'proposed') AND r.withdraw_edit_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM requirement_mentions m JOIN user_quotes q ON q.id = m.quote_id
           WHERE m.requirement_id = r.id AND (q.message_id IS NULL OR q.message_id <> ?1))
       ORDER BY r.seq ASC`,
    )
    .all(messageId)
    .map((row) => getRequirement(ctx, row.id));
}

/**
 * The scribe's `withdraws` for one edit: each entry it names that it was shown and is still open or
 * proposed is marked for you to answer on the board; anything else is dropped and logged. Returns
 * the entries marked.
 */
export function proposeEditWithdrawals(
  ctx: StoreContext,
  input: { edit: MessageEdit; taskId: string; sessionId: string | null; offered: readonly string[]; withdraws: readonly unknown[]; now?: string },
): string[] {
  const offered = new Set(input.offered);
  const marked: string[] = [];
  return ctx.db.transaction(() => {
    input.withdraws.forEach((raw, index) => {
      const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).requirement_id : undefined;
      const reject = (reason: string): void => {
        recordWorkEvent(ctx, { kind: "scribe.rejected", actor: SCRIBE_WRITER, taskId: input.taskId, sessionId: input.sessionId,
          payload: { edit: input.edit.id, item: "withdraw", index, reason, ...(typeof id === "string" ? { requirement: id } : {}) } });
      };
      if (typeof id !== "string") return reject("malformed");
      if (!offered.has(id) || marked.includes(id)) return reject(marked.includes(id) ? "duplicate" : "not_offered");
      const entry = ctx.db.query<{ status: string; withdraw_edit_id: string | null }, [string]>(
        "SELECT status, withdraw_edit_id FROM requirements WHERE id = ?").get(id);
      if (!entry || (entry.status !== "open" && entry.status !== "proposed") || entry.withdraw_edit_id) return reject("not_open");
      ctx.db.run("UPDATE requirements SET withdraw_edit_id = ?, updated_at = ? WHERE id = ?", [input.edit.id, input.now ?? input.edit.created_at, id]);
      recordWorkEvent(ctx, { kind: "requirement.withdraw_proposed", actor: SCRIBE_WRITER, taskId: input.taskId, sessionId: input.sessionId,
        payload: { requirement: id, edit: input.edit.id, message: input.edit.message_id } });
      marked.push(id);
    });
    return marked;
  })();
}

/** Yours on the board: the entry an edit marked stays in force, and is not asked about again. */
export function keepAfterEdit(ctx: StoreContext, id: string, input: { taskId: string | null; now?: string }): Requirement {
  return ctx.db.transaction(() => {
    const entry = getRequirement(ctx, id);
    if (!entry.withdraw_edit_id) return entry;
    ctx.db.run("UPDATE requirements SET withdraw_edit_id = NULL, updated_at = ? WHERE id = ?", [input.now ?? isoNow(), id]);
    recordWorkEvent(ctx, { kind: "requirement.withdraw_dismissed", actor: "user", taskId: input.taskId,
      payload: { requirement: id, edit: entry.withdraw_edit_id } });
    return getRequirement(ctx, id);
  })();
}
