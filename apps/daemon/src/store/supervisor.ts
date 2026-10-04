/**
 * The supervisor (ADR 0040 §5.1, §5.3, §5.6; ADR 0045): who holds the ball on an open ticket, and
 * what moves work nobody is moving. Every decision is a row: a fired `check_backs` row of kind
 * `supervisor` for each call-back or pick-up (its `wait_spec` says why, and the budgets count
 * them), `work_events` `supervisor.*` for repairs, restarts and notices. The clock is a parameter,
 * so a restart of the daemon loses no deadline and repeats no wake. Nothing here calls a model,
 * keeps a timer or starts a turn: the engine runs {@link supervisorTick} on the scheduler's tick,
 * publishes the lines it wrote, continues the segments it names and dispatches what it queued.
 */
import { isContinuableNote, USER_MEMBER, type Message, type SupervisorControl, type SupervisorNoticeCode } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { supervisorNoticeBody, type RestartArrangement } from "../prompts/control-copy";
import { supervisorJobLabel, supervisorWakeNote } from "../prompts/transcript-copy";
import { PROGRESS_KINDS } from "./end-contract";
import { holdsCovering } from "./holds";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import { requireNonEmpty, type StoreContext } from "./shared";
import { isReservedTaskPath } from "./tasks";
import { ticketDependencies } from "./tickets";
import { executionRecoveryFacts } from "./tool-executions";
import { ceilingCardOf, STAGE_SQL, superviseSubmissions, ticketReviewer, type Submission } from "./submissions";
import { confirmedLeadsOf, conversationFor, eligibleInJob, jobConversations, spokenFor } from "./job-conversations";
import { projectInsertedWorkEvent, recordWorkEvent } from "./work-events";
import { queueWork } from "./work-items";

/** A ticket left with no live segment, wait or queued line this long is called back to. */
export const ORPHAN_QUIET_MS = 2 * 60_000;
/** …this long when a Bot had the last word, after yours, in a conversation you are in (ADR 0039's ten minutes, generalized). */
export const ORPHAN_QUIET_AFTER_BOT_MS = 10 * 60_000;
/** Call-backs to one ticket between two of its progress events. */
export const ORPHAN_WAKES_PER_PROGRESS = 2;
/** Automatic pick-ups of one work item within an hour (interruptions, failures, broken waits, restarts). */
export const PICKUPS_PER_HOUR = 3;
/** How long a crashed or development daemon must run before work a restart cut off picks up. */
export const RESTART_STABLE_MS = 60_000;
/** A development restart this soon after the one before waits for your 继续. */
export const DEV_RESTART_WINDOW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
/** What the supervisor cannot do yet, said with every tick rather than guessed at (ADR 0045); reviewers come with level 5 (ADR 0046). */
export const SUPERVISOR_UNSUPPORTED = ["external_jobs", "reviewer_assignment"] as const;
const SUPERVISOR_UNSUPPORTED_AT_SUBMISSIONS = ["external_jobs"] as const;

export type BallHolder =
  | { kind: "closed" }
  | { kind: "delegation"; botId: string; workItemId: string; delegationId: string; since: string }
  | { kind: "owner" | "lead"; botId: string; workItemId: string | null }
  /** From level 5: the ticket's reviewer, on the submission it has to review. */
  | { kind: "reviewer"; botId: string; workItemId: string | null; submissionId: string }
  /** From level 5: a checked submission with no reviewer, which the supervisor approves at its next tick. */
  | { kind: "app"; reason: "approval"; ref: string }
  /** From level 6: a render the daemon polls; its result wakes whoever waits on it (ADR 0047). */
  | { kind: "app"; reason: "job"; ref: string }
  | { kind: "user"; reason: "ask" | "blocked" | "held" | "held_dependency" | "review" | "ceiling" | "unclaimed"; ref?: string };

export type SupervisorWake = {
  workItemId: string;
  botId: string;
  taskId: string;
  ticketId: string | null;
  checkBackId: string;
  /** The queued wake, or null when the engine continues `noteId`. */
  inboxSeq: number | null;
  /** The 「中断」 or failure line the engine continues, the way its own Continue would. */
  noteId: string | null;
  cause: "orphan" | "needs_attention" | "wait_invalid" | "restart";
};

export type SupervisorTickResult = {
  wakes: SupervisorWake[];
  /** Lines the tick wrote (its notices), for the engine to publish. */
  messages: Message[];
  repaired: Array<{ workItemId: string; from: "waiting" | "running" | "idle"; reason: "wait_invalid" | "lost_segment" | "segment_ended" | "mail_in_line" }>;
  deferred: Array<{ workItemId: string; reason: string }>;
  unsupported: readonly string[];
  /** From level 5: submissions the tick took on (§5.3.7) — to their reviewer, approved, back to their producer, or waiting on you. */
  approved: Submission[];
  /** From level 5: gates a waiting submission needs run before it can be decided (the engine runs them; the next tick reads them). */
  checksToRun: Array<{ taskId: string; checkIds: string[] }>;
};

type TicketRow = {
  id: string; task_id: string; seq: number; title: string; status: string; worker: string | null;
  owner_bot_id: string | null; depends_on: string; created_at: string; dir: string;
};
type PlanRow = { id: string; title: string; session_id: string | null; lead_bot_id: string | null };
type Work = {
  id: string; bot_id: string; task_id: string | null; ticket_id: string | null; home_session_id: string;
  thread_session_id: string | null; state: string; waiting_on: string | null; updated_at: string;
};
type Segment = { id: string; status: string; session_id: string; end_reason: string | null; created_at: string };
type RestartRecord = { seq: number; at: string; boot_id: string; cause: "clean" | "crash" | "dev"; turn_id: string; note_id: string | null };
type Boot = { seq: number; at: string; boot_id: string | null; cause: RestartRecord["cause"] | null };

/** A plan the supervisor works in: active, not dormant, not a routine's. */
const ACTIVE_PLAN = (alias: string) => `${alias}.dormant_since IS NULL AND ${alias}.routine_id IS NULL AND ${alias}.session_id IS NOT NULL
  AND COALESCE(${alias}.stage, CASE WHEN ${alias}.status = 'done' THEN 'delivered' ELSE 'active' END) = 'active'`;
const LIVE = "('running', 'waiting_ask', 'waiting_approval')";

function clock(now?: string): string {
  if (now === undefined) return isoNow();
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) throw new HttpError(422, "invalid_args", "now must be a valid timestamp");
  return new Date(now).toISOString();
}

function emptyResult(): SupervisorTickResult {
  return { wakes: [], messages: [], repaired: [], deferred: [], unsupported: SUPERVISOR_UNSUPPORTED, approved: [], checksToRun: [] };
}

function plan(ctx: StoreContext, id: string): PlanRow | null {
  return ctx.db.query<PlanRow, [string]>("SELECT id, title, session_id, lead_bot_id FROM tasks WHERE id = ?").get(id) ?? null;
}

function ticketRow(ctx: StoreContext, id: string): TicketRow | null {
  return ctx.db.query<TicketRow, [string]>(`SELECT id, task_id, seq, title, status, worker, owner_bot_id, depends_on, created_at, dir
    FROM tickets WHERE id = ?`).get(id) ?? null;
}

function workRow(ctx: StoreContext, id: string): Work | null {
  return ctx.db.query<Work, [string]>("SELECT * FROM work_items WHERE id = ?").get(id) ?? null;
}

function botName(ctx: StoreContext, id: string): string {
  return ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(id)?.name ?? id;
}

function locale(ctx: StoreContext): "zh" | "en" {
  return settingsCached(ctx).locale === "en" ? "en" : "zh";
}

function jobLabel(ctx: StoreContext, taskId: string, ticketId: string | null): string {
  const ticket = ticketId ? ticketRow(ctx, ticketId) : null;
  return supervisorJobLabel(locale(ctx), { plan: plan(ctx, taskId)?.title ?? taskId, ticket: ticket ? { seq: ticket.seq, title: ticket.title } : null });
}

/**
 * When the database reached the supervisor's level, from the work log (`engine.level_raised`), or
 * null when no raise is recorded (a database set to it some other way). Work that went quiet, or
 * needed attention, before then is not swept up at once: the supervisor takes it on once anything
 * happens in it, so turning the level on does not wake every plan left open for weeks.
 */
function supervisingSince(ctx: StoreContext): number | null {
  const at = ctx.db.query<{ at: string | null }, [number]>(`SELECT MIN(at) AS at FROM work_events WHERE kind = 'engine.level_raised'
    AND json_valid(payload) AND json_extract(payload, '$.from') < ?1 AND json_extract(payload, '$.to') >= ?1`).get(ENGINE_LEVELS.supervision)?.at;
  return at ? Date.parse(at) : null;
}

/** Whether this work's last change predates the supervisor (see {@link supervisingSince}). */
function beforeSupervision(since: number | null, updatedAt: string): boolean {
  return since !== null && Date.parse(updatedAt) < since;
}

function botAlive(ctx: StoreContext, botId: string): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL").get(botId));
}

/**
 * The plan's lead (§5.3 「迁移时的持球者」), read rather than written so that your lines' routing
 * (which follows a stored lead) does not change under you: the stored lead; else the Bot that
 * opened the plan; else a lead you confirmed in one of its groups (its home's first, then where you
 * spoke about it last); else the Bot with the most turns in the plan. Each only while it can still
 * take work in one of the job's conversations (see `job-conversations.ts`).
 */
export function planLead(ctx: StoreContext, taskId: string): string | null {
  const row = plan(ctx, taskId);
  if (!row?.session_id) return null;
  const conversations = jobConversations(ctx, taskId);
  const candidates = [
    row.lead_bot_id,
    ctx.db.query<{ actor: string }, [string]>(`SELECT actor FROM work_events WHERE task_id = ? AND kind = 'plan.opened'
      ORDER BY seq LIMIT 1`).get(taskId)?.actor ?? null,
    ...confirmedLeadsOf(ctx, conversations),
    ctx.db.query<{ bot_id: string }, [string]>(`SELECT bot_id FROM turns WHERE task_id = ? AND IFNULL(mode, 'work') <> 'readonly'
      GROUP BY bot_id ORDER BY COUNT(*) DESC, MIN(created_at), bot_id LIMIT 1`).get(taskId)?.bot_id ?? null,
  ];
  for (const candidate of candidates) {
    const eligible = eligibleInJob(ctx, candidate, taskId, conversations);
    if (eligible) return eligible;
  }
  return null;
}

/** A gate check bound to this ticket that failed last time it ran: the ticket is back with its owner (§2.6 「检查不通过 → rework」). */
function failingCheck(ctx: StoreContext, ticket: TicketRow): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM acceptance_checks c
    WHERE c.task_id = ?1 AND c.removed_at IS NULL
      AND (c.ticket_id = ?2 OR (c.ticket_id IS NULL AND (c.path = ?3 OR c.path LIKE ?3 || '/%' OR c.cwd = ?3 OR c.cwd LIKE ?3 || '/%')))
      AND NOT (IFNULL(c.origin, '') = 'derived' AND (IFNULL(c.derived_state, '') <> 'active' OR c.bind_kind IS NULL))
      AND (SELECT r.outcome FROM acceptance_check_runs r WHERE r.check_id = c.id AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at DESC, r.rowid DESC LIMIT 1) = 'fail'`).get(ticket.task_id, ticket.id, ticket.dir));
}

/**
 * Who holds the ball on a ticket (§5.1), in order: the recipient of an open request on it; your
 * answer, to a question of a turn or of a blocked job; you, when it is blocked; you, when a stop of
 * yours covers it or a ticket it waits for; you, when it awaits your review (a reviewer is P4e's);
 * else its owner, else the plan's lead, else nobody (`unclaimed`, yours). From level 6 a render still
 * running on it is the job poller's (ADR 0047): nobody is called back to poll it.
 */
export function ballHolder(ctx: StoreContext, input: { ticketId: string }): BallHolder {
  const ticket = ticketRow(ctx, requireNonEmpty("ticketId", input.ticketId));
  if (!ticket) throw new HttpError(404, "not_found", "ticket not found");
  if (ticket.status === "done" || ticket.status === "parked") return { kind: "closed" };
  const home = plan(ctx, ticket.task_id);
  // A request for a deliverable whose hand-over waits on its checks or a review is not the delegate's
  // to answer any more: the ball is the reviewer's, or yours on a card, and approval answers it. It
  // held the ball here, so while an approval card waited on you the delegate was called back every
  // few minutes to "answer" it and handed the same work in again each time (2026-10-04).
  const delegation = ctx.db.query<{ botId: string; workItemId: string; delegationId: string; since: string }, [string, string]>(`SELECT
    d.to_bot_id AS botId, d.to_work_item_id AS workItemId, d.id AS delegationId, d.created_at AS since
    FROM delegations d JOIN work_items w ON w.id = d.to_work_item_id AND w.bot_id = d.to_bot_id
      AND w.task_id = d.task_id AND w.ticket_id IS d.ticket_id AND w.state <> 'closed'
    JOIN bots b ON b.id = w.bot_id AND b.deleted_at IS NULL AND b.archived_at IS NULL
    WHERE d.task_id = ? AND d.ticket_id = ? AND d.status = 'open'
      AND NOT (d.expects = 'deliverable' AND EXISTS (SELECT 1 FROM submissions s WHERE s.work_item_id = d.to_work_item_id
        AND s.task_id = d.task_id AND s.ticket_id = d.ticket_id AND s.state IN ('checking', 'submitted', 'in_review')))
    ORDER BY d.created_at, d.rowid LIMIT 1`).get(ticket.task_id, ticket.id);
  if (delegation) return { kind: "delegation", ...delegation };
  const ask = ctx.db.query<{ id: string }, [string, string]>(`SELECT m.id FROM turns t JOIN messages m ON m.id = t.pending_ask_id
    WHERE t.task_id = ?1 AND t.ticket_id = ?2 AND t.status = 'waiting_ask' AND m.kind = 'ask' AND m.ask_answer IS NULL
    UNION ALL SELECT json_extract(w.waiting_on, '$.ref') FROM work_items w
    WHERE w.task_id = ?1 AND w.ticket_id = ?2 AND w.state = 'blocked' AND json_valid(w.waiting_on)
      AND json_extract(w.waiting_on, '$.kind') = 'user' LIMIT 1`).get(ticket.task_id, ticket.id);
  if (ask) return { kind: "user", reason: "ask", ref: ask.id };
  const blocked = ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM work_items WHERE task_id = ? AND ticket_id = ?
    AND state = 'blocked' ORDER BY created_at, id LIMIT 1`).get(ticket.task_id, ticket.id);
  if (blocked) return { kind: "user", reason: "blocked", ref: blocked.id };
  const owner = eligibleInJob(ctx, ticket.owner_bot_id ?? ticket.worker, ticket.task_id);
  const botId = owner ?? planLead(ctx, ticket.task_id);
  if (holdsCovering(ctx, { botId, sessionId: home?.session_id ?? null, taskId: ticket.task_id, ticketId: ticket.id }).length) {
    return { kind: "user", reason: "held", ref: ticket.id };
  }
  for (const id of ticketDependencies(ticket.depends_on)) {
    if (holdsCovering(ctx, { sessionId: home?.session_id ?? null, taskId: ticket.task_id, ticketId: id }).length) {
      return { kind: "user", reason: "held_dependency", ref: id };
    }
  }
  if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions) {
    // It hit the capability ceiling: a card asks you how to go on, and nobody is woken for it meanwhile.
    const ceiling = ceilingCardOf(ctx, ticket.id);
    if (ceiling) return { kind: "user", reason: "ceiling", ref: ceiling };
    const handed = submissionHolder(ctx, ticket);
    if (handed) return handed;
    // A render still running on it: the daemon's to poll, and its result wakes the Bot (ADR 0047).
    if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.jobs) {
      const job = ctx.db.query<{ id: string }, [string]>("SELECT id FROM external_jobs WHERE ticket_id = ? AND state = 'pending' ORDER BY created_at LIMIT 1").get(ticket.id);
      if (job) return { kind: "app", reason: "job", ref: job.id };
    }
  } else if (ticket.status === "review" && !failingCheck(ctx, ticket)) return { kind: "user", reason: "review", ref: ticket.id };
  if (!botId) return { kind: "user", reason: "unclaimed" };
  const work = ctx.db.query<{ id: string }, [string, string, string]>(`SELECT id FROM work_items WHERE bot_id = ? AND task_id = ?
    AND ticket_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(botId, ticket.task_id, ticket.id);
  return { kind: owner ? "owner" : "lead", botId, workItemId: work?.id ?? null };
}

/**
 * From level 5, who holds a handed-over ticket (ADR 0046): you, when its approval waits on your
 * answer to a card; in review, its reviewer; handed over with no reviewer, the app, until its next
 * tick takes it on. A ticket in review from before level 5, with no submission, still awaits your
 * review. Null when the ball is the owner's as usual (todo, doing, rework).
 */
function submissionHolder(ctx: StoreContext, ticket: TicketRow): BallHolder | null {
  const stage = ctx.db.query<{ stage: string }, [string]>(`SELECT ${STAGE_SQL("t")} AS stage FROM tickets t WHERE t.id = ?`).get(ticket.id)?.stage;
  if (stage !== "submitted" && stage !== "in_review") return null;
  const open = ctx.db.query<{ id: string; state: string; bot_id: string; awaiting: string | null }, [string]>(`SELECT id, state, bot_id, awaiting FROM submissions
    WHERE ticket_id = ? AND state IN ('submitted', 'in_review') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(ticket.id);
  if (!open) return { kind: "user", reason: "review", ref: ticket.id };
  // Its approval waits on your answer to a card: yours.
  if (open.awaiting) return { kind: "user", reason: "review", ref: (JSON.parse(open.awaiting) as { message_id: string | null }).message_id ?? ticket.id };
  const reviewer = ticketReviewer(ctx, ticket.id, open.bot_id);
  if (reviewer && open.state === "in_review") {
    const work = ctx.db.query<{ id: string }, [string, string, string]>(`SELECT id FROM work_items WHERE bot_id = ? AND task_id = ?
      AND ticket_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(reviewer, ticket.task_id, ticket.id);
    return { kind: "reviewer", botId: reviewer, workItemId: work?.id ?? null, submissionId: open.id };
  }
  return { kind: "app", reason: "approval", ref: open.id };
}

/**
 * Tickets it waits for that are not done yet; a list that does not read counts as waiting. A parked
 * one does not hold it: set aside, it will never be done, and waiting for it would never end.
 */
function dependenciesPending(ctx: StoreContext, ticket: TicketRow): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(ticket.depends_on); } catch { return true; }
  if (!Array.isArray(parsed)) return true;
  return parsed.some((id) => typeof id !== "string"
    || !ctx.db.query("SELECT 1 FROM tickets WHERE id = ? AND task_id = ? AND status IN ('done', 'parked')").get(id, ticket.task_id));
}

/** A stop of yours over the work: its Bot, its plan, ticket and conversations, or any of its recent turns. */
function heldWork(ctx: StoreContext, work: Work): boolean {
  const sessions = [...new Set([work.home_session_id, work.thread_session_id].filter((id): id is string => Boolean(id)))];
  const turns = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM turns WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`)
    .all(work.id).map((row) => row.id);
  for (const sessionId of sessions) {
    for (const turnId of [null, ...turns]) {
      if (holdsCovering(ctx, { botId: work.bot_id, sessionId, taskId: work.task_id, ticketId: work.ticket_id, turnId }).length) return true;
    }
  }
  return false;
}

function latestSegment(ctx: StoreContext, workItemId: string): Segment | null {
  return ctx.db.query<Segment, [string]>(`SELECT id, status, session_id, end_reason, created_at FROM turns
    WHERE work_item_id = ? AND IFNULL(mode, 'work') <> 'readonly' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workItemId) ?? null;
}

/** The segment's own 「中断」 or failure line, not yet continued: what its Continue goes from. */
function continuableNote(ctx: StoreContext, segment: Segment | null): string | null {
  if (!segment) return null;
  const rows = ctx.db.query<{ id: string; kind: Message["kind"]; body: string }, [string]>(`SELECT id, kind, body FROM messages
    WHERE turn_id = ? AND kind = 'system' AND source_turn_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 5`).all(segment.id);
  return rows.find((row) => isContinuableNote(row))?.id ?? null;
}

/** The last step a segment recorded, as a line: its last command or call. */
function lastStep(ctx: StoreContext, segment: Segment | null): string | null {
  if (!segment) return null;
  const command = ctx.db.query<{ command: string }, [string]>(`SELECT command FROM turn_runs WHERE turn_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(segment.id)?.command;
  if (!command) return null;
  const chars = [...command.replace(/\s+/g, " ").trim()];
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
}

/**
 * The segment's external effects with no known outcome (§5.6 「通用限制」): calls the effect ledger
 * saw start and never saw end, or ended as unknown — shells and MCP calls, not file writes, which a
 * retry repeats harmlessly. `legacy` also counts shell and MCP runs from before the ledger, which
 * cannot say what was in flight when the segment stopped.
 */
function uncertainEffects(ctx: StoreContext, segment: Segment | null, legacy: boolean): string[] {
  if (!segment) return [];
  const facts = executionRecoveryFacts(ctx, { turnId: segment.id });
  const ledger = facts.uncertain.filter((execution) => execution.tool !== "write_file" && execution.tool !== "delete_file");
  return [...ledger.map((execution) => execution.tool), ...(legacy ? facts.legacyAmbiguous.map((run) => run.tool) : [])];
}

/**
 * The restart behind the work's latest segment (§5.6), while it has not been picked up for that
 * boot: the boot's own record of cutting it (`supervisor.restart`), or — for a segment interrupted
 * before this boot that no record names (a crash whose list of live turns was lost) — this boot.
 */
function restartRecord(ctx: StoreContext, work: Work, segment: Segment | null): RestartRecord | null {
  if (!segment) return null;
  const row = ctx.db.query<{ seq: number; at: string; payload: string }, [string]>(`SELECT seq, at, payload FROM work_events
    WHERE kind = 'supervisor.restart' AND work_item_id = ? ORDER BY seq DESC LIMIT 1`).get(work.id);
  const recorded = row ? { seq: row.seq, at: row.at, ...(JSON.parse(row.payload) as Omit<RestartRecord, "seq" | "at">) } : null;
  let record: RestartRecord | null = recorded?.turn_id === segment.id ? recorded : null;
  if (!record && segment.status === "interrupted") {
    const boot = currentBoot(ctx);
    if (boot?.boot_id && boot.cause && segment.created_at < boot.at) {
      record = { seq: boot.seq, at: boot.at, boot_id: boot.boot_id, cause: boot.cause, turn_id: segment.id, note_id: continuableNote(ctx, segment) };
    }
  }
  // Picked up once already for that boot: what follows is ordinary attention.
  if (!record || ctx.db.query(`SELECT 1 FROM check_backs WHERE work_item_id = ? AND kind = 'supervisor' AND voided_at IS NULL
    AND json_extract(wait_spec, '$.boot_id') = ?`).get(work.id, record.boot_id)) return null;
  return record;
}

/** This run's boot (`daemon.restart`, written at every boot), or null when none is recorded. */
function currentBoot(ctx: StoreContext): Boot | null {
  const row = ctx.db.query<{ seq: number; at: string; payload: string }, []>(`SELECT seq, at, payload FROM work_events
    WHERE kind = 'daemon.restart' ORDER BY seq DESC LIMIT 1`).get();
  if (!row) return null;
  const payload = JSON.parse(row.payload) as { boot_id?: unknown; cause?: unknown };
  return { seq: row.seq, at: row.at, boot_id: typeof payload.boot_id === "string" ? payload.boot_id : null,
    cause: payload.cause === "clean" || payload.cause === "crash" || payload.cause === "dev" ? payload.cause : null };
}

/** Whether the daemon also started within {@link DEV_RESTART_WINDOW_MS} before this boot. */
function restartedJustBefore(ctx: StoreContext, boot: Boot): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'daemon.restart' AND seq < ? AND at > ?`)
    .get(boot.seq, new Date(Date.parse(boot.at) - DEV_RESTART_WINDOW_MS).toISOString()));
}

/** Whether you pressed 先放着 on the restart notice that offered this 「中断」 line. */
function leftByYou(ctx: StoreContext, noteId: string | null): boolean {
  if (!noteId) return false;
  return Boolean(ctx.db.query(`SELECT 1 FROM messages m WHERE json_valid(m.control) AND json_extract(m.control, '$.kind') = 'restart'
    AND EXISTS (SELECT 1 FROM json_each(json_extract(m.control, '$.notes')) n WHERE n.value = ?1)
    AND EXISTS (SELECT 1 FROM json_each(json_extract(m.control, '$.acted')) a WHERE a.value = 'leave')`).get(noteId));
}

/** §5.6's policy for work a restart cut off: why it may not pick up now, or null when it may. */
function restartDefers(ctx: StoreContext, record: RestartRecord, now: string): string | null {
  if (leftByYou(ctx, record.note_id)) return "left_by_user";
  if (record.cause === "clean") return null;
  const boot = currentBoot(ctx) ?? { seq: record.seq, at: record.at, boot_id: record.boot_id, cause: record.cause };
  if (Date.parse(now) - Date.parse(boot.at) < RESTART_STABLE_MS) return "restart_stability";
  if (record.cause === "dev" && (boot.boot_id !== record.boot_id || restartedJustBefore(ctx, boot))) return "dev_restart_window";
  return null;
}

/**
 * Where a line about this work goes: the first of these you are in, else your direct with the Bot.
 * Never the direct of a Bot you archived or deleted: that conversation is out of your list, and a
 * notice there about work going on elsewhere is one you would not see (2026-10-03).
 */
function placeToTell(ctx: StoreContext, botId: string, candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const id of candidates) {
    if (id && ctx.db.query(`SELECT 1 FROM sessions s JOIN session_participants p ON p.session_id = s.id AND p.member = ?
      AND p.left_at IS NULL WHERE s.id = ? AND s.archived_at IS NULL AND NOT (s.kind = 'direct' AND EXISTS (SELECT 1
        FROM session_participants q JOIN bots b ON b.id = q.member WHERE q.session_id = s.id
          AND (b.archived_at IS NOT NULL OR b.deleted_at IS NOT NULL)))`).get(USER_MEMBER, id)) return id;
  }
  return ctx.db.query<{ id: string }, [string, string]>(`SELECT s.id FROM sessions s
    JOIN session_participants u ON u.session_id = s.id AND u.member = ? AND u.left_at IS NULL
    JOIN session_participants b ON b.session_id = s.id AND b.member = ? AND b.left_at IS NULL
    WHERE s.kind = 'direct' AND s.archived_at IS NULL ORDER BY s.created_at LIMIT 1`).get(USER_MEMBER, botId)?.id ?? null;
}

/**
 * The supervisor's line and notification about a job it will not move on its own (ADR 0045),
 * once per `key`. With no conversation of yours to put it in, the notice is still recorded, so
 * the next tick does not look for one again.
 */
function notice(ctx: StoreContext, result: SupervisorTickResult, input: {
  key: string; code: SupervisorNoticeCode; taskId: string; ticketId: string | null; workItemId: string | null; botId: string;
  places: ReadonlyArray<string | null | undefined>; body: string; now: string;
}): void {
  if (ctx.db.query("SELECT 1 FROM work_events WHERE kind = 'supervisor.notice' AND json_extract(payload, '$.key') = ?").get(input.key)) return;
  const sessionId = placeToTell(ctx, input.botId, input.places);
  let messageId: string | null = null;
  if (sessionId) {
    const control: SupervisorControl = { kind: "supervisor", code: input.code, task_id: input.taskId, ticket_id: input.ticketId,
      work_item_id: input.workItemId, offer: [] };
    const message = insertMessage(ctx, { sessionId, kind: "system", author: input.botId, body: input.body, hiddenFromBots: true, control });
    messageId = message.id;
    createNotification(ctx, { semantic_key: `supervisor:${input.key}`, kind: "failure", session_id: sessionId, message_id: message.id,
      action_state: "open", fail_kind: "stalled_plan" });
    result.messages.push(message);
  }
  ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, session_id, payload)
    VALUES (?, 'supervisor.notice', 'app', ?, ?, ?, ?, ?, ?)`, [input.now, input.botId, input.taskId, input.ticketId, input.workItemId,
    sessionId, JSON.stringify({ key: input.key, code: input.code, message_id: messageId })]);
  projectInsertedWorkEvent(ctx);
}

/** The fired check-back that records one call-back or pick-up; the budgets count these. */
function recordWake(ctx: StoreContext, input: {
  work: Pick<Work, "id" | "bot_id" | "task_id" | "ticket_id">; sessionId: string; note: string; now: string;
  spec: Record<string, unknown>; dedupeKey: string;
}): string {
  const id = ulid(Date.parse(input.now));
  ctx.db.run(`INSERT INTO check_backs (id, bot_id, session_id, task_id, ticket_id, work_item_id, note, due_at, created_at, fired_at,
      kind, cause, wait_spec, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'supervisor', 'supervisor', ?, ?)`, [id, input.work.bot_id, input.sessionId, input.work.task_id,
    input.work.ticket_id, input.work.id, input.note, input.now, input.now, input.now, JSON.stringify({ kind: "supervisor", ...input.spec }), input.dedupeKey]);
  return id;
}

/** I6: a waiting item needs an open wait. One with none (its request cancelled, the other side closed) needs attention. */
function repairWaits(ctx: StoreContext, result: SupervisorTickResult, now: string): void {
  const waiting = ctx.db.query<Work, []>(`SELECT w.* FROM work_items w JOIN tasks p ON p.id = w.task_id
    WHERE w.state = 'waiting' AND ${ACTIVE_PLAN("p")}`).all();
  const since = supervisingSince(ctx);
  for (const work of waiting) {
    if (beforeSupervision(since, work.updated_at) || heldWork(ctx, work) || openWait(ctx, work)) continue;
    ctx.db.run("UPDATE work_items SET state = 'needs_attention', waiting_on = NULL, updated_at = ? WHERE id = ? AND state = 'waiting'", [now, work.id]);
    ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, session_id, payload)
      VALUES (?, 'supervisor.wait_invalid', 'app', ?, ?, ?, ?, ?, ?)`, [now, work.bot_id, work.task_id, work.ticket_id, work.id,
      work.home_session_id, JSON.stringify({ waiting_on: work.waiting_on })]);
    projectInsertedWorkEvent(ctx);
    result.repaired.push({ workItemId: work.id, from: "waiting", reason: "wait_invalid" });
  }
}

function openWait(ctx: StoreContext, work: Work): boolean {
  let pointer: unknown;
  try { pointer = work.waiting_on ? JSON.parse(work.waiting_on) : null; } catch { return false; }
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return false;
  const { kind, ref } = pointer as Record<string, unknown>;
  if (typeof ref !== "string") return false;
  const waits = ctx.db.query<{ id: string; kind: string | null }, [string, string, string]>(`SELECT c.id, c.kind FROM check_backs c
    WHERE c.bot_id = ?1 AND c.work_item_id = ?2 AND c.fired_at IS NULL AND (c.voided_at IS NULL OR c.suspended_at IS NOT NULL)
      AND (c.id = ?3 OR (json_valid(c.wait_spec) AND json_extract(c.wait_spec, '$.ref') = ?3))`).all(work.bot_id, work.id, ref);
  if (kind === "timer") return waits.some((wait) => wait.id === ref && wait.kind !== "delegation_wait");
  if (kind === "delegation" && waits.some((wait) => wait.kind === "delegation_wait")) {
    return Boolean(ctx.db.query(`SELECT 1 FROM delegations d JOIN work_items target ON target.id = d.to_work_item_id AND target.state <> 'closed'
      WHERE d.id = ? AND d.from_work_item_id = ? AND d.status = 'open'`).get(ref, work.id));
  }
  return false;
}

/**
 * A running item no segment runs any more. Cut off without the engine seeing it end (an older
 * build, a crash between writes), or failed: it needs attention. Ended any other way — a Stop whose
 * hold you lifted with its button, an ending the end contract did not see — it is idle, so the
 * call-backs reach it; while a stop of yours covers it, it is left as it is.
 */
function repairLostSegments(ctx: StoreContext, result: SupervisorTickResult, now: string): void {
  const running = ctx.db.query<Work, []>(`SELECT w.* FROM work_items w JOIN tasks p ON p.id = w.task_id
    WHERE w.state = 'running' AND ${ACTIVE_PLAN("p")}
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = w.id AND t.status IN ${LIVE})`).all();
  const since = supervisingSince(ctx);
  for (const work of running) {
    const segment = latestSegment(ctx, work.id);
    if (beforeSupervision(since, work.updated_at) || !segment) continue;
    if (segment.status === "interrupted" || (segment.status === "completed" && continuableNote(ctx, segment))) {
      ctx.db.run("UPDATE work_items SET state = 'needs_attention', updated_at = ? WHERE id = ? AND state = 'running'", [now, work.id]);
      ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, session_id, payload)
        VALUES (?, 'supervisor.lost_segment', 'app', ?, ?, ?, ?, ?, '{}')`, [now, work.bot_id, work.task_id, work.ticket_id, work.id, work.home_session_id]);
      projectInsertedWorkEvent(ctx);
      result.repaired.push({ workItemId: work.id, from: "running", reason: "lost_segment" });
      continue;
    }
    if (heldWork(ctx, work)) continue;
    ctx.db.run("UPDATE work_items SET state = 'idle', updated_at = ? WHERE id = ? AND state = 'running'", [now, work.id]);
    ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, session_id, payload)
      VALUES (?, 'supervisor.segment_ended', 'app', ?, ?, ?, ?, ?, ?)`, [now, work.bot_id, work.task_id, work.ticket_id, work.id,
      work.home_session_id, JSON.stringify({ turn_id: segment.id, status: segment.status, end_reason: segment.end_reason })]);
    result.repaired.push({ workItemId: work.id, from: "running", reason: "segment_ended" });
  }
}

/**
 * Idle work with mail in line that nothing dispatches: only queued work is dispatched, and the mail
 * in line keeps the supervisor from calling the Bot back, so the two wait on each other for good. A
 * segment that ended idle after a newer review request was queued on its work left the poster
 * unreviewed (2026-10-04, real-model run); the end contract now keeps such work queued, and this
 * catches whatever else leaves it so.
 */
function requeueMailInLine(ctx: StoreContext, result: SupervisorTickResult, now: string): void {
  const stranded = ctx.db.query<Work, []>(`SELECT w.* FROM work_items w JOIN tasks p ON p.id = w.task_id
    WHERE w.state = 'idle' AND ${ACTIVE_PLAN("p")}
      AND EXISTS (SELECT 1 FROM inbox_items i WHERE i.work_item_id = w.id AND i.state = 'queued' AND i.wakes = 1)
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = w.id AND t.status IN ${LIVE})`).all();
  for (const work of stranded) {
    ctx.db.run("UPDATE work_items SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'idle'", [now, work.id]);
    ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, session_id, payload)
      VALUES (?, 'supervisor.requeued', 'app', ?, ?, ?, ?, ?, '{}')`, [now, work.bot_id, work.task_id, work.ticket_id, work.id, work.home_session_id]);
    projectInsertedWorkEvent(ctx);
    result.repaired.push({ workItemId: work.id, from: "idle", reason: "mail_in_line" });
  }
}

/** Pick-ups of this item in the hour before `now`. */
function pickupsInHour(ctx: StoreContext, workItemId: string, now: string): Array<{ id: string }> {
  // A pick-up the engine could not carry out was voided (see {@link refuseSupervisorPickup}) and is no attempt.
  return ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM check_backs WHERE work_item_id = ? AND kind = 'supervisor'
    AND voided_at IS NULL AND json_extract(wait_spec, '$.reason') IN ('needs_attention', 'restart', 'wait_invalid') AND created_at > ? ORDER BY created_at, id`)
    .all(workItemId, new Date(Date.parse(now) - HOUR_MS).toISOString());
}

/**
 * Whether a Bot is engaged on this job some other way: a live segment, mail in line, a pending wait, or other work on it not
 * idle. Its work that needs attention counts anywhere in the job: a Bot has one live segment per job (I1b), so a call to
 * another ticket would take the place of work a restart or a failure cut off — on 2026-10-04 one two minutes after a
 * development restart had the Bot redraw the cut ticket's frames under the next ticket while the notice said it would wait.
 */
function engaged(ctx: StoreContext, botId: string, taskId: string, ticketId: string | null, exceptWork: string | null): boolean {
  if (ctx.db.query(`SELECT 1 FROM turns WHERE bot_id = ? AND task_id = ? AND status IN ${LIVE} AND IFNULL(mode, 'work') <> 'readonly'`)
    .get(botId, taskId)) return true;
  if (ctx.db.query(`SELECT 1 FROM inbox_items WHERE bot_id = ?1 AND task_id = ?2 AND (ticket_id IS ?3 OR ticket_id IS NULL)
    AND state IN ('queued', 'held')`).get(botId, taskId, ticketId)) return true;
  if (ctx.db.query(`SELECT 1 FROM check_backs WHERE bot_id = ?1 AND task_id = ?2 AND (ticket_id IS ?3 OR ticket_id IS NULL)
    AND fired_at IS NULL AND (voided_at IS NULL OR suspended_at IS NOT NULL)`).get(botId, taskId, ticketId)) return true;
  return Boolean(ctx.db.query(`SELECT 1 FROM work_items WHERE bot_id = ?1 AND task_id = ?2 AND id IS NOT ?4 AND (state = 'needs_attention'
    OR ((ticket_id IS ?3 OR ticket_id IS NULL) AND state IN ('queued', 'running', 'waiting', 'blocked')))`).get(botId, taskId, ticketId, exceptWork));
}

/**
 * §5.3.5: work that needs attention — a segment interrupted, failed, past its ending budget, or a
 * wait gone — picks up again with where it stopped, at most {@link PICKUPS_PER_HOUR} times an hour,
 * then you are told. Work a restart cut off follows §5.6 first. Never when a stop of yours covers
 * it, when its last external call has no known outcome, or when someone else holds the ball.
 */
function pickUpAttention(ctx: StoreContext, result: SupervisorTickResult, now: string): void {
  const items = ctx.db.query<Work & { session_id: string }, []>(`SELECT w.*, p.session_id FROM work_items w JOIN tasks p ON p.id = w.task_id
    WHERE w.state = 'needs_attention' AND ${ACTIVE_PLAN("p")} ORDER BY w.updated_at, w.id`).all();
  const since = supervisingSince(ctx);
  for (const work of items) {
    const taskId = work.task_id!;
    if (beforeSupervision(since, work.updated_at) || !botAlive(ctx, work.bot_id)) continue;
    if (heldWork(ctx, work)) { result.deferred.push({ workItemId: work.id, reason: "held" }); continue; }
    if (work.ticket_id) {
      const holder = ballHolder(ctx, { ticketId: work.ticket_id });
      if (holder.kind === "closed" || (holder.kind === "user" && (holder.reason === "held" || holder.reason === "held_dependency"))
        || (holder.kind === "delegation" && holder.workItemId !== work.id)) {
        result.deferred.push({ workItemId: work.id, reason: `ball_${holder.kind === "user" ? holder.reason : holder.kind}` });
        continue;
      }
    }
    if (ctx.db.query(`SELECT 1 FROM turns WHERE bot_id = ? AND task_id = ? AND status IN ${LIVE} AND IFNULL(mode, 'work') <> 'readonly'`).get(work.bot_id, taskId)) continue;
    // Mail held by a stop waits with it. Mail merely in line is no reason to wait: work that needs
    // attention is not dispatched, so a review request queued on work whose segment failed stayed
    // there, and the work was never picked up either (2026-10-04, real-model run). The segment that
    // picks it up reads that mail too.
    if (ctx.db.query(`SELECT 1 FROM inbox_items WHERE work_item_id = ? AND state = 'held'`).get(work.id)) continue;
    const segment = latestSegment(ctx, work.id);
    const restart = restartRecord(ctx, work, segment);
    if (restart) {
      const why = restartDefers(ctx, restart, now);
      if (why) { result.deferred.push({ workItemId: work.id, reason: why }); continue; }
    }
    const unknown = uncertainEffects(ctx, segment, true);
    if (unknown.length > 0) {
      result.deferred.push({ workItemId: work.id, reason: "unknown_effect" });
      // A restart's own notice already says so; anything else is said here, once per segment.
      if (!restart && segment) notice(ctx, result, { key: `unknown_effect:${work.id}:${segment.id}`, code: "unknown_effect", taskId,
        ticketId: work.ticket_id, workItemId: work.id, botId: work.bot_id, places: [...spokenFor(ctx, taskId, work.bot_id), work.session_id, work.home_session_id, segment.session_id],
        body: supervisorNoticeBody(locale(ctx), { code: "unknown_effect", job: jobLabel(ctx, taskId, work.ticket_id), bot: botName(ctx, work.bot_id), tool: unknown.at(-1) ?? null }),
        now });
      continue;
    }
    const recent = pickupsInHour(ctx, work.id, now);
    if (recent.length >= PICKUPS_PER_HOUR) {
      result.deferred.push({ workItemId: work.id, reason: "retry_budget" });
      notice(ctx, result, { key: `retry_budget:${work.id}:${recent[0]!.id}`, code: "retry_budget", taskId, ticketId: work.ticket_id,
        workItemId: work.id, botId: work.bot_id, places: [...spokenFor(ctx, taskId, work.bot_id), work.session_id, work.home_session_id, segment?.session_id],
        body: supervisorNoticeBody(locale(ctx), { code: "retry_budget", job: jobLabel(ctx, taskId, work.ticket_id), bot: botName(ctx, work.bot_id), count: recent.length }),
        now });
      continue;
    }
    const waitGone = Boolean(ctx.db.query(`SELECT 1 FROM work_events WHERE work_item_id = ? AND kind = 'supervisor.wait_invalid'
      AND seq > IFNULL((SELECT MAX(seq) FROM work_events WHERE work_item_id = ?1 AND kind IN ('work.ended')), 0)`).get(work.id));
    const reason: "restart" | "wait_invalid" | "needs_attention" = restart ? "restart" : waitGone ? "wait_invalid" : "needs_attention";
    const detail = segment?.status === "interrupted" ? "interrupted" : segment?.end_reason === "needs_attention" ? "contract_budget"
      : continuableNote(ctx, segment) ? "failed" : "lost_segment";
    // A line the engine could not continue from once is not tried again: the work goes on by a queued wake.
    const note = reason === "wait_invalid" ? null : continuableNote(ctx, segment);
    const noteId = note && !pickupRefused(ctx, work.id, note) ? note : null;
    const job = jobLabel(ctx, taskId, work.ticket_id);
    const body = reason === "wait_invalid"
      ? supervisorWakeNote(locale(ctx), { kind: "wait_invalid", job })
      : supervisorWakeNote(locale(ctx), { kind: "resume", job, reason: detail, lastStep: lastStep(ctx, segment), attempt: recent.length + 1 });
    const sessionId = work.thread_session_id ?? work.home_session_id;
    const spec = { reason, detail, boot_id: restart?.boot_id ?? null, turn_id: segment?.id ?? null, note_id: noteId, attempt: recent.length + 1 };
    if (noteId) {
      // Continued the way its own Continue would (lifecycle.continueFromInterrupt): same line, same place, same stops.
      const checkBackId = recordWake(ctx, { work, sessionId, note: body, now, spec, dedupeKey: `supervisor:pickup:${work.id}:${segment!.id}:${recent.length + 1}` });
      result.wakes.push({ workItemId: work.id, botId: work.bot_id, taskId, ticketId: work.ticket_id, checkBackId, inboxSeq: null, noteId, cause: reason });
      continue;
    }
    const queued = queueWork(ctx, { botId: work.bot_id, sessionId, taskId, ticketId: work.ticket_id, messageId: null, author: "app", body,
      source: "system", kind: "wake", priority: 3, notice: false });
    const checkBackId = recordWake(ctx, { work, sessionId, note: body, now, spec: { ...spec, inbox_seq: queued.inbox.seq },
      dedupeKey: `supervisor:pickup:${work.id}:${segment?.id ?? "none"}:${recent.length + 1}` });
    result.wakes.push({ workItemId: work.id, botId: work.bot_id, taskId, ticketId: work.ticket_id, checkBackId, inboxSeq: queued.inbox.seq, noteId: null, cause: reason });
  }
}

/** Whether a pick-up from this line was refused before (see {@link refuseSupervisorPickup}). */
function pickupRefused(ctx: StoreContext, workItemId: string, noteId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM check_backs WHERE work_item_id = ? AND kind = 'supervisor' AND voided_at IS NOT NULL
    AND json_extract(wait_spec, '$.note_id') = ?`).get(workItemId, noteId));
}

/**
 * The engine could not continue a pick-up from its 「中断」 or failure line (the conversation was
 * archived, the job taken up some other way meanwhile): the pick-up's record is voided, so it is no
 * attempt and counts toward no budget, and the work log says why (`supervisor.pickup_refused`). The
 * next tick picks the work up by a queued wake instead of that line.
 */
export function refuseSupervisorPickup(ctx: StoreContext, input: { checkBackId: string; code: string; now?: string }): void {
  ctx.commit(() => {
    const now = clock(input.now);
    const row = ctx.db.query<{ id: string; bot_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null;
      session_id: string; note_id: string | null }, [string]>(`SELECT id, bot_id, task_id, ticket_id, work_item_id, session_id,
        json_extract(wait_spec, '$.note_id') AS note_id FROM check_backs WHERE id = ? AND kind = 'supervisor'`)
      .get(requireNonEmpty("checkBackId", input.checkBackId));
    if (!row) throw new HttpError(404, "not_found", "no such supervisor pick-up");
    if (!ctx.db.query<{ id: string }, [string, string]>("UPDATE check_backs SET voided_at = ? WHERE id = ? AND voided_at IS NULL RETURNING id")
      .get(now, row.id)) return;
    recordWorkEvent(ctx, { kind: "supervisor.pickup_refused", actor: "app", botId: row.bot_id, taskId: row.task_id, ticketId: row.ticket_id,
      sessionId: row.session_id, payload: { work_item_id: row.work_item_id, note_id: row.note_id, check_back_id: row.id, code: input.code } });
  });
}

/**
 * When a ticket counts as left (§5.3.3): {@link ORPHAN_QUIET_MS} after the job's last activity —
 * or {@link ORPHAN_QUIET_AFTER_BOT_MS} when, among the conversations you are in, its last line is a
 * Bot's and came after your last line in the job, counted from that or from your last line in that
 * conversation, whichever is later. Whether the Bot asked anything is not read.
 */
function quietDeadline(ctx: StoreContext, ticket: TicketRow): { since: number; deadline: number } {
  const filed = `(m.task_id = ?1 OR EXISTS (SELECT 1 FROM message_filings f WHERE f.message_id = m.id AND f.task_id = ?1))`;
  const activity = ctx.db.query<{ at: string | null }, [string]>(`SELECT MAX(at) AS at FROM (
    SELECT m.created_at AS at FROM messages m WHERE m.hidden_from_bots = 0 AND m.bot_only = 0 AND ${filed}
    UNION ALL SELECT t.last_activity_at FROM turns t WHERE t.task_id = ?1
    UNION ALL SELECT w.at FROM work_events w WHERE w.task_id = ?1 AND w.kind NOT LIKE 'supervisor.%' AND w.kind <> 'wake.suppressed')`).get(ticket.task_id)?.at;
  let since = Math.max(Date.parse(ticket.created_at), activity ? Date.parse(activity) : 0);
  let delay = ORPHAN_QUIET_MS;
  const latest = ctx.db.query<{ session_id: string; kind: string; created_at: string }, [string, string]>(`SELECT m.session_id, m.kind, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id AND s.archived_at IS NULL
    JOIN session_participants you ON you.session_id = m.session_id AND you.member = ?2 AND you.left_at IS NULL
    WHERE m.parent_id IS NULL AND m.kind IN ('user', 'bot') AND m.hidden_from_bots = 0 AND m.bot_only = 0 AND ${filed}
    ORDER BY m.created_at DESC, m.message_seq DESC LIMIT 1`).get(ticket.task_id, USER_MEMBER);
  if (latest?.kind === "bot") {
    const yoursInJob = ctx.db.query<{ at: string | null }, [string]>(`SELECT MAX(m.created_at) AS at FROM messages m WHERE m.kind = 'user' AND ${filed}`)
      .get(ticket.task_id)?.at;
    if (!yoursInJob || Date.parse(latest.created_at) > Date.parse(yoursInJob)) {
      delay = ORPHAN_QUIET_AFTER_BOT_MS;
      const yoursThere = ctx.db.query<{ at: string | null }, [string]>("SELECT MAX(created_at) AS at FROM messages WHERE session_id = ? AND kind = 'user'")
        .get(latest.session_id)?.at;
      since = Math.max(since, yoursThere ? Date.parse(yoursThere) : 0);
    }
  }
  return { since, deadline: since + delay };
}

/**
 * The ticket's progress cycle: the work log's last progress event on it (§5.3 「进展」) — a stage
 * that changed, a delivery or review, a check that passed for the first time (a judged one, twice
 * in a row), a new artifact by content hash. Never `updated_at`, never words.
 */
function progressCycle(ctx: StoreContext, ticket: TicketRow): number {
  const rows = ctx.db.query<{ seq: number; kind: string; payload: string }, [string, string, string]>(`SELECT seq, kind, payload FROM work_events
    WHERE task_id = ? AND ticket_id = ? AND kind IN (SELECT value FROM json_each(?)) ORDER BY seq`)
    .all(ticket.task_id, ticket.id, JSON.stringify(PROGRESS_KINDS));
  let seq = 0;
  for (const event of rows) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(event.payload) as Record<string, unknown>; } catch { continue; }
    const progress = event.kind === "ticket.stage_changed" || event.kind === "part.stage_changed"
      ? typeof payload.after === "string" && payload.before !== payload.after
      : event.kind === "artifact.changed"
        ? typeof payload.path === "string" && typeof payload.sha256 === "string"
        : event.kind === "check.first_passed"
          ? typeof payload.check_id === "string" && (payload.source !== "model" || (typeof payload.consecutive_passes === "number" && payload.consecutive_passes >= 2))
          : typeof payload.submission_id === "string";
    if (progress) seq = event.seq;
  }
  return seq;
}

/**
 * §5.3.3: a ticket whose ball is with a Bot (its owner, the plan's lead, or the recipient of an
 * open request on it) that nothing has been moving — no live segment, no wait, no line in its
 * queue — past its quiet deadline. That Bot is called back, at most {@link ORPHAN_WAKES_PER_PROGRESS}
 * times per progress cycle; after that the conversation is told the job stopped, once per cycle.
 */
function callBackOrphans(ctx: StoreContext, result: SupervisorTickResult, now: string): void {
  const tickets = ctx.db.query<TicketRow & { session_id: string }, []>(`SELECT t.id, t.task_id, t.seq, t.title, t.status, t.worker,
      t.owner_bot_id, t.depends_on, t.created_at, t.dir, p.session_id
    FROM tickets t JOIN tasks p ON p.id = t.task_id
    WHERE t.status IN ('todo', 'doing', 'review') AND ${ACTIVE_PLAN("p")} ORDER BY p.created_at, t.seq`).all();
  const since = supervisingSince(ctx);
  for (const ticket of tickets) {
    const holder = ballHolder(ctx, { ticketId: ticket.id });
    if (holder.kind !== "owner" && holder.kind !== "lead" && holder.kind !== "delegation" && holder.kind !== "reviewer") continue;
    if (dependenciesPending(ctx, ticket)) continue;
    const item = holder.workItemId ? workRow(ctx, holder.workItemId) : null;
    if (item && item.state !== "idle") continue;
    if (item && heldWork(ctx, item)) continue;
    if (engaged(ctx, holder.botId, ticket.task_id, ticket.id, item?.id ?? null)) continue;
    const quiet = quietDeadline(ctx, ticket);
    if ((since !== null && quiet.since < since) || Date.parse(now) < quiet.deadline) continue;
    const job = jobLabel(ctx, ticket.task_id, ticket.id);
    const segment = item ? latestSegment(ctx, item.id) : null;
    const unknown = uncertainEffects(ctx, segment, false);
    if (unknown.length > 0 && item && segment) {
      result.deferred.push({ workItemId: item.id, reason: "unknown_effect" });
      notice(ctx, result, { key: `unknown_effect:${item.id}:${segment.id}`, code: "unknown_effect", taskId: ticket.task_id, ticketId: ticket.id,
        workItemId: item.id, botId: holder.botId, places: [...spokenFor(ctx, ticket.task_id, holder.botId), ticket.session_id, item.home_session_id],
        body: supervisorNoticeBody(locale(ctx), { code: "unknown_effect", job, bot: botName(ctx, holder.botId), tool: unknown.at(-1) ?? null }), now });
      continue;
    }
    const progressSeq = progressCycle(ctx, ticket);
    const spent = ctx.db.query<{ n: number; work_item_id: string | null }, [string, number]>(`SELECT COUNT(*) AS n, MAX(work_item_id) AS work_item_id
      FROM check_backs WHERE ticket_id = ? AND kind = 'supervisor' AND json_extract(wait_spec, '$.reason') = 'orphan'
        AND json_extract(wait_spec, '$.progress_seq') = ?`).get(ticket.id, progressSeq)!;
    if (spent.n >= ORPHAN_WAKES_PER_PROGRESS) {
      notice(ctx, result, { key: `stalled:${ticket.id}:${progressSeq}`, code: "stalled", taskId: ticket.task_id, ticketId: ticket.id,
        workItemId: spent.work_item_id, botId: holder.botId, places: [...spokenFor(ctx, ticket.task_id, holder.botId), ticket.session_id],
        body: supervisorNoticeBody(locale(ctx), { code: "stalled", job, bot: botName(ctx, holder.botId), count: spent.n }), now });
      continue;
    }
    const ask = holder.kind === "delegation"
      ? ctx.db.query<{ ask: string }, [string]>("SELECT ask FROM delegations WHERE id = ?").get(holder.delegationId)?.ask ?? null : null;
    const body = supervisorWakeNote(locale(ctx), { kind: "orphan", job, role: holder.kind, ask, submissionId: holder.kind === "reviewer" ? holder.submissionId : null,
      quietMinutes: Math.max(1, Math.floor((Date.parse(now) - quiet.since) / 60_000)) });
    const sessionId = item ? item.thread_session_id ?? item.home_session_id : conversationFor(ctx, holder.botId, ticket.task_id) ?? ticket.session_id;
    const queued = queueWork(ctx, { botId: holder.botId, sessionId, taskId: ticket.task_id, ticketId: ticket.id, messageId: null, author: "app",
      body, source: "system", kind: "wake", priority: 3, notice: false });
    const checkBackId = recordWake(ctx, { work: queued.workItem, sessionId, note: body, now,
      spec: { reason: "orphan", holder: holder.kind, progress_seq: progressSeq, attempt: spent.n + 1, inbox_seq: queued.inbox.seq },
      dedupeKey: `supervisor:orphan:${ticket.id}:${progressSeq}:${spent.n + 1}` });
    result.wakes.push({ workItemId: queued.workItem.id, botId: holder.botId, taskId: ticket.task_id, ticketId: ticket.id, checkBackId,
      inboxSeq: queued.inbox.seq, noteId: null, cause: "orphan" });
  }
}

/**
 * One scheduler tick of the supervisor, in one write: I6's repair of waits that are gone and of
 * segments cut off unseen, then the pick-ups of work that needs attention, then the call-backs to
 * tickets nobody is moving. Off below {@link ENGINE_LEVELS.supervision}.
 */
export function supervisorTick(ctx: StoreContext, input: { now?: string } = {}): SupervisorTickResult {
  return ctx.commit(() => {
    const now = clock(input.now);
    const result = emptyResult();
    if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) return result;
    repairWaits(ctx, result, now);
    repairLostSegments(ctx, result, now);
    requeueMailInLine(ctx, result, now);
    pickUpAttention(ctx, result, now);
    if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions) {
      result.unsupported = SUPERVISOR_UNSUPPORTED_AT_SUBMISSIONS;
      const submissions = superviseSubmissions(ctx, now);
      result.approved = submissions.moved;
      result.messages.push(...submissions.messages);
      result.checksToRun = submissions.toRun;
    }
    callBackOrphans(ctx, result, now);
    return result;
  });
}

/**
 * At boot, from the supervisor's level (§5.6): the work behind each turn the restart cut off needs
 * attention, with a record of the restart (`supervisor.restart`: which boot, why, which segment and
 * its 「中断」 line) that {@link supervisorTick} applies the restart policy from. Returns how each
 * turn goes on, for the restart notice to say. Recording the same boot twice records nothing more.
 */
export function recordSupervisorRestart(ctx: StoreContext, input: {
  bootId: string; cause: "clean" | "crash" | "dev"; interruptedTurnIds: readonly string[]; now?: string;
}): Array<{ turnId: string; workItemId: string | null; arrangement: RestartArrangement }> {
  return ctx.commit(() => {
    const bootId = requireNonEmpty("bootId", input.bootId);
    if (!["clean", "crash", "dev"].includes(input.cause) || !Array.isArray(input.interruptedTurnIds)) {
      throw new HttpError(422, "invalid_args", "a restart needs its cause and the turns it cut off");
    }
    const now = clock(input.now);
    const out: Array<{ turnId: string; workItemId: string | null; arrangement: RestartArrangement }> = [];
    const supervised = readEngineLevel(ctx.db) >= ENGINE_LEVELS.supervision;
    const boot = currentBoot(ctx);
    for (const turnId of input.interruptedTurnIds) {
      const turn = ctx.db.query<{ work_item_id: string | null; task_id: string | null; status: string }, [string]>(
        "SELECT work_item_id, task_id, status FROM turns WHERE id = ?").get(requireNonEmpty("interruptedTurnId", turnId));
      const work = turn?.work_item_id ? workRow(ctx, turn.work_item_id) : null;
      const active = work?.task_id ? ctx.db.query(`SELECT 1 FROM tasks p WHERE p.id = ? AND ${ACTIVE_PLAN("p")}`).get(work.task_id) : null;
      if (!supervised || !turn || turn.status !== "interrupted" || !work || work.state === "closed" || !active) {
        out.push({ turnId, workItemId: work?.id ?? null, arrangement: "waits" });
        continue;
      }
      const segment = latestSegment(ctx, work.id);
      if (segment?.id === turnId && !ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'supervisor.restart' AND work_item_id = ?
        AND json_extract(payload, '$.boot_id') = ? AND json_extract(payload, '$.turn_id') = ?`).get(work.id, bootId, turnId)) {
        ctx.db.run("UPDATE work_items SET state = 'needs_attention', updated_at = ? WHERE id = ? AND state NOT IN ('closed', 'blocked')", [now, work.id]);
        ctx.db.run(`INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, work_item_id, turn_id, session_id, payload)
          VALUES (?, 'supervisor.restart', 'app', ?, ?, ?, ?, ?, ?, ?)`, [now, work.bot_id, work.task_id, work.ticket_id, work.id, turnId,
          work.home_session_id, JSON.stringify({ boot_id: bootId, cause: input.cause, turn_id: turnId, note_id: continuableNote(ctx, segment) })]);
      }
      const arrangement: RestartArrangement = segment?.id !== turnId ? "waits"
        : heldWork(ctx, work) ? "held"
          : uncertainEffects(ctx, segment, true).length > 0 ? "unknown_effect"
            : input.cause === "clean" ? "now"
              : input.cause === "dev" && boot && boot.boot_id === bootId && restartedJustBefore(ctx, boot) ? "dev_burst"
                : "after_stable";
      out.push({ turnId, workItemId: work.id, arrangement });
    }
    return out;
  });
}

/**
 * Whether the work this segment was on is now the supervisor's to take up (§5.3.5): it needs
 * attention, on a plan the supervisor works in. A failure there is retried without you, and you are
 * told only when it will not be any more (its retry budget, an outcome it cannot know), so the
 * failure itself asks nothing of you.
 */
export function supervisorTakesUp(ctx: StoreContext, turnId: string): boolean {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) return false;
  return Boolean(ctx.db.query(`SELECT 1 FROM turns t JOIN work_items w ON w.id = t.work_item_id JOIN tasks p ON p.id = w.task_id
    WHERE t.id = ? AND w.state = 'needs_attention' AND ${ACTIVE_PLAN("p")}`).get(turnId));
}

/**
 * Work an earlier development restart cut off that has not been picked up and now never will be on
 * its own — the daemon started again first, and §5.6 leaves work cut by a development restart to you
 * once another restart came before its pick-up — with no restart notice naming its 「中断」 line:
 * its own boot said nothing, since it was to go on after a minute (2026-10-04). The boot that strands
 * it tells you instead (engine/restart.ts). Turn and note ids, oldest first.
 */
export function workLeftByEarlierRestart(ctx: StoreContext, bootId: string): Array<{ turnId: string; noteId: string }> {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) return [];
  const items = ctx.db.query<Work, []>(`SELECT w.* FROM work_items w JOIN tasks p ON p.id = w.task_id
    WHERE w.state = 'needs_attention' AND ${ACTIVE_PLAN("p")} ORDER BY w.updated_at, w.id`).all();
  const out: Array<{ turnId: string; noteId: string }> = [];
  for (const work of items) {
    const segment = latestSegment(ctx, work.id);
    const record = restartRecord(ctx, work, segment);
    if (!segment || !record || record.cause !== "dev" || record.boot_id === bootId || record.turn_id !== segment.id) continue;
    const noteId = continuableNote(ctx, segment);
    if (!noteId || noteId !== record.note_id) continue;
    if (ctx.db.query(`SELECT 1 FROM messages m WHERE json_valid(m.control) AND json_extract(m.control, '$.kind') = 'restart'
      AND EXISTS (SELECT 1 FROM json_each(json_extract(m.control, '$.notes')) n WHERE n.value = ?)`).get(noteId)) continue;
    out.push({ turnId: segment.id, noteId });
  }
  return out;
}

/**
 * Restart notices whose every 「中断」 line has been continued — by the supervisor or by you — get
 * the 继续 they no longer need marked as done, and their notification resolved. Returns the lines
 * that changed, for the engine to publish.
 */
export function settleRestartNotices(ctx: StoreContext, noteIds: readonly string[]): Message[] {
  return ctx.commit(() => {
    const changed: Message[] = [];
    const notices = ctx.db.query<{ id: string }, [string]>(`SELECT m.id FROM messages m
      WHERE json_valid(m.control) AND json_extract(m.control, '$.kind') = 'restart'
        AND EXISTS (SELECT 1 FROM json_each(json_extract(m.control, '$.notes')) n WHERE n.value IN (SELECT value FROM json_each(?)))`)
      .all(JSON.stringify(noteIds));
    for (const row of notices) {
      const control = getMessage(ctx, row.id).control;
      if (control?.kind !== "restart" || (control.acted ?? []).length > 0) continue;
      if (control.notes.some((id) => ctx.db.query("SELECT 1 FROM messages WHERE id = ? AND source_turn_id IS NULL").get(id))) continue;
      changed.push(setMessageControl(ctx, row.id, { ...control, acted: ["resume"] }));
      updateNotificationActionState(ctx, `restart:${row.id}`, "resolved", "continued", true);
    }
    return changed;
  });
}

/**
 * A segment's written files by content hash (ADR 0045 / §5.3 「任务目录下出现内容哈希新的产物」):
 * `artifact.changed` for each in its job's folder — its ticket's, else its plan's, leaving out
 * what is reserved there — whose hash differs from the last one recorded for that path. These are
 * progress; the same bytes written again are not. Returns how many were new.
 */
export function recordArtifactProgress(ctx: StoreContext, input: { turnId: string; artifacts: ReadonlyArray<{ path: string; sha256: string }> }): number {
  return ctx.commit(() => {
    const turn = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null }, [string]>(
      "SELECT bot_id, task_id, ticket_id, work_item_id FROM turns WHERE id = ?").get(requireNonEmpty("turnId", input.turnId));
    if (!turn?.task_id) return 0;
    const dir = turn.ticket_id
      ? ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE id = ?").get(turn.ticket_id)?.dir
      : ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tasks WHERE id = ?").get(turn.task_id)?.dir;
    if (!dir) return 0;
    let recorded = 0;
    for (const artifact of input.artifacts) {
      if (typeof artifact.path !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) continue;
      if (!artifact.path.startsWith(`${dir}/`) || artifact.path.split("/").some((part) => part === ".." || part === ".")
        || isReservedTaskPath(dir, artifact.path)) continue;
      const last = ctx.db.query<{ sha256: string | null }, [string, string | null, string]>(`SELECT json_extract(payload, '$.sha256') AS sha256
        FROM work_events WHERE kind = 'artifact.changed' AND task_id = ? AND ticket_id IS ? AND json_extract(payload, '$.path') = ?
        ORDER BY seq DESC LIMIT 1`).get(turn.task_id, turn.ticket_id, artifact.path);
      if (last?.sha256 === artifact.sha256) continue;
      recordWorkEvent(ctx, { kind: "artifact.changed", actor: "app", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id,
        turnId: input.turnId, payload: { work_item_id: turn.work_item_id, path: artifact.path, sha256: artifact.sha256 } });
      recorded += 1;
    }
    return recorded;
  });
}
