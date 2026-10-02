/**
 * External jobs (ADR 0047, engine level 6): a render a Bot started on a media server, registered when
 * the server accepts it and polled by the daemon for everyone waiting on it. A Bot's own check reads
 * the job's last known state instead of reaching the server; the same arguments within half an hour
 * get the first job back; a part with a job pending, or a result not handed over yet, is not
 * submitted again without a reason. When it finishes, whoever waits on it is woken with the result.
 */
import { createHash } from "node:crypto";
import { isoNow, ulid } from "../ids";
import { filenamePartNumbers, partNumbers } from "./filing";
import { refreshHeldInbox } from "./inbox";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";
import { queueWork } from "./work-items";

/** The same arguments to the same submit tool within this long are the job already started. */
export const JOB_DEDUPE_MS = 30 * 60_000;
/** A job still pending this long after it started is given up on: the server lost it, or never says. */
export const JOB_LOST_AFTER_MS = 3 * 60 * 60_000;
/** How long the daemon waits between asks, by how many it has made: 30 s, 1, 2, 4, then every 5 minutes. */
const POLL_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
const RESULT_MAX = 4000;

export type JobState = "pending" | "completed" | "failed" | "lost";
export type JobWaiter = { bot_id: string; work_item_id: string | null; session_id: string | null };
export type ExternalJob = {
  id: string; server: string; submit_tool: string; check_tool: string; id_param: string; request_id: string; args_digest: string;
  task_id: string | null; ticket_id: string | null; part_no: number | null; bot_id: string; work_item_id: string | null;
  turn_id: string | null; session_id: string | null; state: JobState; status_text: string | null; result: string | null;
  resubmit_reason: string | null; waiters: JobWaiter[]; polls: number; next_poll_at: string; last_polled_at: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
};
type JobRow = Omit<ExternalJob, "waiters"> & { waiters: string };

function toJob(row: JobRow): ExternalJob {
  let waiters: JobWaiter[] = [];
  try {
    waiters = JSON.parse(row.waiters) as JobWaiter[];
  } catch {
    waiters = [];
  }
  return { ...row, waiters };
}

/** Whether external jobs are on: engine level 6. */
export function jobsOn(ctx: StoreContext): boolean {
  try {
    return readEngineLevel(ctx.db) >= ENGINE_LEVELS.jobs;
  } catch {
    return false;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** What makes two submits the same job: the server, the tool and the arguments, key order aside. */
export function jobArgsDigest(server: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([server, tool, canonical(args)])).digest("hex");
}

export function getJob(ctx: StoreContext, id: string): ExternalJob | null {
  const row = ctx.db.query<JobRow, [string]>("SELECT * FROM external_jobs WHERE id = ?").get(id);
  return row ? toJob(row) : null;
}

/** The job these arguments started within {@link JOB_DEDUPE_MS}, still pending or done; null otherwise. */
export function recentJob(ctx: StoreContext, digest: string, now: string = isoNow()): ExternalJob | null {
  const since = new Date(Date.parse(now) - JOB_DEDUPE_MS).toISOString();
  const row = ctx.db.query<JobRow, [string, string]>(`SELECT * FROM external_jobs WHERE args_digest = ? AND created_at > ?
    AND state IN ('pending', 'completed') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(digest, since);
  return row ? toJob(row) : null;
}

/** The one part (shot) number a submit's prompt names, read the way a line of yours is; null for none or several. */
export function promptPartNumber(prompt: string): number | null {
  const numbers = partNumbers(prompt);
  return numbers.length === 1 ? numbers[0]! : null;
}

/**
 * The job that holds a part: one still pending on it, or one done whose result was not handed over
 * since (no submission of a file of that part number after it finished). Null when the part is free.
 */
export function partJob(ctx: StoreContext, ticketId: string, partNo: number): ExternalJob | null {
  const rows = ctx.db.query<JobRow, [string, number]>(`SELECT * FROM external_jobs WHERE ticket_id = ? AND part_no = ?
    AND state IN ('pending', 'completed') ORDER BY created_at DESC, rowid DESC`).all(ticketId, partNo).map(toJob);
  for (const job of rows) {
    if (job.state === "pending") return job;
    const handedOver = ctx.db.query<{ part_keys: string; artifacts: string }, [string, string]>(`SELECT part_keys, artifacts FROM submissions
      WHERE ticket_id = ? AND created_at >= ?`).all(ticketId, job.finished_at ?? job.created_at)
      .some((row) => {
        try {
          const keys = JSON.parse(row.part_keys) as string[];
          const paths = (JSON.parse(row.artifacts) as Array<{ path: string }>).map((artifact) => artifact.path);
          return [...keys, ...paths].some((name) => filenamePartNumbers(name).includes(partNo));
        } catch {
          return false;
        }
      });
    if (!handedOver) return job;
  }
  return null;
}

/** A job the server accepted, registered so the daemon polls it and a second identical submit finds it. */
export function registerJob(ctx: StoreContext, input: {
  server: string; submitTool: string; checkTool: string; idParam: string; requestId: string; digest: string;
  taskId: string | null; ticketId: string | null; partNo: number | null; botId: string; workItemId: string | null;
  turnId: string | null; sessionId: string | null; statusText?: string | null; resubmitReason?: string | null; now?: string;
}): ExternalJob {
  return ctx.commit(() => {
    const now = input.now ?? isoNow();
    const existing = ctx.db.query<{ id: string }, [string, string]>("SELECT id FROM external_jobs WHERE server = ? AND request_id = ?").get(input.server, input.requestId);
    if (existing) return getJob(ctx, existing.id)!;
    const id = ulid(Date.parse(now));
    const waiters: JobWaiter[] = [{ bot_id: input.botId, work_item_id: input.workItemId, session_id: input.sessionId }];
    ctx.db.run(`INSERT INTO external_jobs (id, server, submit_tool, check_tool, id_param, request_id, args_digest, task_id, ticket_id, part_no,
        bot_id, work_item_id, turn_id, session_id, state, status_text, result, resubmit_reason, waiters, polls, next_poll_at, last_polled_at,
        created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 0, ?, NULL, ?, ?, NULL)`,
      [id, input.server, input.submitTool, input.checkTool, input.idParam, input.requestId, input.digest, input.taskId, input.ticketId, input.partNo,
        input.botId, input.workItemId, input.turnId, input.sessionId, input.statusText ?? null, input.resubmitReason ?? null, JSON.stringify(waiters),
        new Date(Date.parse(now) + POLL_BACKOFF_MS[0]!).toISOString(), now, now]);
    recordWorkEvent(ctx, { kind: "job.registered", actor: input.botId, botId: input.botId, taskId: input.taskId, ticketId: input.ticketId, turnId: input.turnId,
      payload: { job_id: id, server: input.server, tool: input.submitTool, request_id: input.requestId, part_no: input.partNo, resubmit_reason: input.resubmitReason ?? null } });
    return getJob(ctx, id)!;
  });
}

/** The registered job a check names, on that server. */
export function jobForRequest(ctx: StoreContext, server: string, requestId: string): ExternalJob | null {
  const row = ctx.db.query<JobRow, [string, string]>("SELECT * FROM external_jobs WHERE server = ? AND request_id = ?").get(server, requestId);
  return row ? toJob(row) : null;
}

/** Someone else waiting on a job (a check from another conversation): woken with the result there too. Once per Bot and conversation. */
export function addJobWaiter(ctx: StoreContext, jobId: string, waiter: JobWaiter): void {
  ctx.commit(() => {
    const job = getJob(ctx, jobId);
    if (!job || job.state !== "pending") return;
    if (job.waiters.some((known) => known.bot_id === waiter.bot_id && known.session_id === waiter.session_id)) return;
    ctx.db.run("UPDATE external_jobs SET waiters = ?, updated_at = ? WHERE id = ?", [JSON.stringify([...job.waiters, waiter]), isoNow(), jobId]);
  });
}

/** Pending jobs due to be asked about now; marked as asked, so a slow answer is not asked for twice. */
export function claimDueJobs(ctx: StoreContext, now: string = isoNow()): ExternalJob[] {
  return ctx.commit(() => {
    const due = ctx.db.query<JobRow, [string]>("SELECT * FROM external_jobs WHERE state = 'pending' AND next_poll_at <= ? ORDER BY next_poll_at, rowid").all(now).map(toJob);
    for (const job of due) {
      const backoff = POLL_BACKOFF_MS[Math.min(job.polls + 1, POLL_BACKOFF_MS.length - 1)]!;
      ctx.db.run("UPDATE external_jobs SET polls = polls + 1, last_polled_at = ?, next_poll_at = ?, updated_at = ? WHERE id = ?",
        [now, new Date(Date.parse(now) + backoff).toISOString(), now, job.id]);
    }
    return due;
  });
}

/** Whether a Bot's own check-back would only poll a job the daemon already polls: its note names one still pending. */
export function pendingJobNamed(ctx: StoreContext, note: string): ExternalJob | null {
  const rows = ctx.db.query<JobRow, []>("SELECT * FROM external_jobs WHERE state = 'pending' ORDER BY created_at DESC LIMIT 200").all().map(toJob);
  return rows.find((job) => job.request_id.length >= 4 && note.includes(job.request_id)) ?? null;
}

/**
 * What the daemon's ask came back with. Still pending: kept, asked again after the backoff — or given
 * up as lost after {@link JOB_LOST_AFTER_MS}. Done or failed: the result is kept, and every waiter is
 * told — woken, unless a stop holds it (the inbox keeps it for when the stop is lifted).
 */
export function recordJobPoll(ctx: StoreContext, jobId: string, outcome: { state: JobState; statusText: string | null; result: string | null }, now: string = isoNow()): ExternalJob | null {
  return ctx.commit(() => {
    const job = getJob(ctx, jobId);
    if (!job || job.state !== "pending") return job;
    let state = outcome.state;
    if (state === "pending" && Date.parse(now) - Date.parse(job.created_at) > JOB_LOST_AFTER_MS) state = "lost";
    const result = outcome.result === null ? null : [...outcome.result].slice(0, RESULT_MAX).join("");
    if (state === "pending") {
      ctx.db.run("UPDATE external_jobs SET status_text = COALESCE(?, status_text), updated_at = ? WHERE id = ?", [outcome.statusText, now, jobId]);
      return getJob(ctx, jobId);
    }
    ctx.db.run("UPDATE external_jobs SET state = ?, status_text = COALESCE(?, status_text), result = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      [state, outcome.statusText, result, now, now, jobId]);
    recordWorkEvent(ctx, { kind: `job.${state}`, actor: "app", botId: job.bot_id, taskId: job.task_id, ticketId: job.ticket_id,
      payload: { job_id: job.id, request_id: job.request_id, status: outcome.statusText, polls: job.polls } });
    const en = settingsCached(ctx).locale === "en";
    const said = state === "completed"
      ? (en ? `(app) Job ${job.request_id} is done: ${result ?? "no details"}` : `（应用）作业 ${job.request_id} 完成了：${result ?? "没有附带细节"}`)
      : state === "failed"
        ? (en ? `(app) Job ${job.request_id} failed: ${result ?? outcome.statusText ?? "no details"}` : `（应用）作业 ${job.request_id} 失败了：${result ?? outcome.statusText ?? "没有附带细节"}`)
        : (en ? `(app) Job ${job.request_id} was still not done after three hours; the app stopped waiting on it.` : `（应用）作业 ${job.request_id} 三个小时还没完成，应用不再等它了。`);
    for (const waiter of job.waiters) {
      if (!waiter.session_id || !ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(waiter.bot_id)) continue;
      if (!ctx.db.query("SELECT 1 FROM sessions WHERE id = ?").get(waiter.session_id)) continue;
      queueWork(ctx, { botId: waiter.bot_id, sessionId: waiter.session_id, taskId: job.task_id, ticketId: job.ticket_id, messageId: null, author: "app",
        body: said, source: "job", kind: "result", priority: 2, notice: false });
      refreshHeldInbox(ctx, { botId: waiter.bot_id });
    }
    return getJob(ctx, jobId);
  });
}
