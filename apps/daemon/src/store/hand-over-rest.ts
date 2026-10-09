/**
 * When a hand-over is put to you on its card (ADR 0058 §16): once the Bot that made it has stopped
 * working on its job, not while it is still at it. On 2026-10-08 视频导演 reworked a sample in one
 * segment after another — each ended to wait for its video jobs — and every ending's files came to
 * you as a 放行 card while it went on; a run of tickets done back to back put a card between each
 * of its progress lines too. What the Bot is still doing is read from the work's own records: a
 * segment running, a job of its own still rendering, something queued that wakes it again. None of
 * them is read from its words.
 */
import { yoursToApprove } from "./large-jobs";
import { recordWorkEvent } from "./work-events";
import type { StoreContext } from "./shared";
import type { Submission } from "./submission-rows";

/**
 * How long the Bot must have been still on the job before its hand-over is put to you: one scheduler
 * tick (`scheduler.ts`). Whatever moves a Bot on by itself — its queue the moment a segment ends,
 * the supervisor's call to the next ticket or its pick-up of cut-off work at the next tick — has
 * started it again by then.
 */
export const REST_SETTLE_MS = 15_000;

/**
 * Whether the Bot that handed this over is still at work on its job: a segment of its running there
 * (one waiting on your answer or approval is waiting on you, and one that only reads makes nothing),
 * a job of its own still rendering, something queued for it there less than {@link REST_SETTLE_MS}
 * ago that is about to wake it, or a segment of its ended there less than that ago. What has sat in
 * its queue longer is not about to start anything: on 2026-10-08 a send-back of 视频导演's second
 * part stayed queued for over an hour behind work that needed attention. A large job's sample is put
 * to you once its own ticket is still: the rest of the job waits on it.
 */
export function stillAtWork(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id" | "bot_id">, now: string): boolean {
  const sample = yoursToApprove(ctx, submission.ticket_id) === "sample";
  const since = new Date(Date.parse(now) - REST_SETTLE_MS).toISOString();
  // ?3 is the sample's ticket, or nothing at all: the whole job counts.
  const scope = "AND (?3 IS NULL OR ticket_id = ?3 OR ticket_id IS NULL)";
  const args = [submission.bot_id, submission.task_id, sample ? submission.ticket_id : null, since] as const;
  const found = ctx.db.query<{ n: number }, [string, string, string | null, string]>(`SELECT
      EXISTS (SELECT 1 FROM turns WHERE bot_id = ?1 AND task_id = ?2 AND status = 'running' AND IFNULL(mode, 'work') <> 'readonly' ${scope})
      + EXISTS (SELECT 1 FROM external_jobs WHERE bot_id = ?1 AND task_id = ?2 AND state = 'pending' ${scope})
      + EXISTS (SELECT 1 FROM inbox_items WHERE bot_id = ?1 AND task_id = ?2 AND state = 'queued' AND wakes = 1 AND created_at > ?4 ${scope})
      + EXISTS (SELECT 1 FROM turns WHERE bot_id = ?1 AND task_id = ?2 AND IFNULL(mode, 'work') <> 'readonly' AND updated_at > ?4 ${scope}) AS n`)
    .get(...args)!.n;
  return found > 0;
}

/** The work log's note, once per hand-over, that its card waits for its Bot to stop. */
export function noteCardDeferred(ctx: StoreContext, submission: Pick<Submission, "id" | "task_id" | "ticket_id" | "bot_id" | "work_item_id">): void {
  if (ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'submission.card_deferred' AND task_id = ? AND json_extract(payload, '$.submission_id') = ?`)
    .get(submission.task_id, submission.id)) return;
  recordWorkEvent(ctx, { kind: "submission.card_deferred", actor: "app", botId: submission.bot_id, taskId: submission.task_id,
    ticketId: submission.ticket_id, payload: { submission_id: submission.id, work_item_id: submission.work_item_id, reason: "at_work" } });
}
