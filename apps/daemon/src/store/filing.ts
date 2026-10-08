/**
 * Message attribution (ADR 0040 §8.2, ADR 0057): the locked signals 1–5 — what you chose, an
 * annotation, a quoted reply, a workspace path or attachment, the work a line is bound to —
 * accumulate in order. Without one, where a line of yours goes is what a model read it as
 * (`reader.ts`, given `lineToFile`): one or more of the jobs it may be about, a new one, or no
 * telling. A line the reading did not place is the Bot's to choose at its desk. Nothing here reads
 * the line's words, numbers or opening to guess. message_filings is authoritative; the old message
 * and quote columns project only its primary target. Candidate ids are captured with the decision.
 * Dormancy is independent of stage and holds. Engine/API integration belongs to the facade.
 */
import { isoNow, isoPlus, ulid } from "../ids";
import { HttpError } from "../errors";
import type { FilingReading } from "../line-reading";
import { LIVE_TURN_STATUSES, planStageSql, type StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";
import { heldSql } from "./holds";
import { externalJobsReadable } from "./external-jobs-migration";
import { parsePlanSpec } from "./plan-shape";
import { STAGE_SQL } from "./ticket-stage";

export type Filing = { taskId: string; ticketId: string | null };
export type FilingTarget = { taskId: string; ticketId?: string | null; partKey?: string | null };
export type FilingState = "filed" | "undetermined" | "none";
export type MessageFiling = {
  taskId: string; ticketId: string | null; partKey: string | null; filedBy: string;
  strength: "locked" | "default" | "bot" | "user"; isPrimary: boolean; createdAt: string;
};
export type PlanCandidate = {
  id: string; title: string; dir: string; stage: "active" | "delivered" | "accepted" | "abandoned";
  dormantSince: string | null; lastActivityAt: string; recentArtifacts: string[]; lastUserQuote: string | null;
};
export type FileMessageInput = {
  botId?: string; explicit?: FilingTarget[]; boundWorkItemId?: string; bound?: FilingTarget[];
  referenceMessageId?: string; none?: boolean;
  /** Caller validates the admitted turn's snapshot, or atomically creates the new plan from a quote. */
  botSelection?: FilingTarget[];
  /**
   * A model's reading of where a line of yours belongs (ADR 0057), read from `lineToFile`. It files
   * the line only when no locked signal does; one it read as about none of the jobs is left for
   * the Bot's desk, marked so (`lineReadAsNew`).
   */
  read?: FilingReading;
};

export function filingsOfMessage(ctx: StoreContext, messageId: string): MessageFiling[] {
  return ctx.db.query<MessageFiling, [string]>(`SELECT task_id AS taskId, ticket_id AS ticketId,
    part_key AS partKey, filed_by AS filedBy, strength, is_primary AS isPrimary, created_at AS createdAt
    FROM message_filings WHERE message_id = ? ORDER BY is_primary DESC, rowid ASC`).all(messageId)
    .map((row) => ({ ...row, isPrimary: Boolean(row.isPrimary) }));
}

/** Validate before any writes: a ticket of a different plan cannot become a locked filing. */
function validTarget(ctx: StoreContext, target: FilingTarget): void {
  if (!target.taskId || !ctx.db.query("SELECT 1 FROM tasks WHERE id = ?").get(target.taskId)) throw new HttpError(422, 'invalid_args', 'no such plan');
  if (target.ticketId && !ctx.db.query("SELECT 1 FROM tickets WHERE id = ? AND task_id = ?").get(target.ticketId, target.taskId)) {
    throw new HttpError(422, 'invalid_args', 'ticket does not belong to plan');
  }
  if (target.partKey && (!target.ticketId || !ctx.db.query('SELECT 1 FROM ticket_parts WHERE ticket_id = ? AND key = ?').get(target.ticketId, target.partKey))) {
    throw new HttpError(422, 'invalid_args', 'part does not belong to ticket');
  }
}

/**
 * The plans a line in `sessionId` may be filed under (ADR 0040 §8.4): the conversation's own, and
 * its main conversation's when it is a Bot↔Bot thread; from any other conversation only a plan the
 * called Bot (`botId`; with none, the Bots in the conversation) has open work in, or worked on in
 * the last 24 hours. Being in a group is not working on its plans: a line in your direct with a Bot
 * is not filed under a group plan it never touched.
 */
export function planCandidates(ctx: StoreContext, input: { sessionId: string; botId?: string }): PlanCandidate[] {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = ctx.db.query<{ id: string }, [string, string | null, string]>(`WITH visible_sessions AS (
      SELECT ?1 AS id
      UNION SELECT origin_session_id FROM sessions WHERE id = ?1 AND origin_session_id IS NOT NULL
    ), called AS (
      SELECT ?2 AS id WHERE ?2 IS NOT NULL
      UNION SELECT member FROM session_participants WHERE ?2 IS NULL AND session_id = ?1 AND left_at IS NULL AND member <> 'user'
    ), candidate_ids AS (
      SELECT t.id FROM tasks t JOIN visible_sessions s ON s.id = t.session_id
      UNION SELECT task_id FROM work_items WHERE bot_id IN (SELECT id FROM called) AND state <> 'closed' AND task_id IS NOT NULL
      UNION SELECT task_id FROM turns WHERE bot_id IN (SELECT id FROM called) AND last_activity_at >= ?3 AND task_id IS NOT NULL
        AND IFNULL(mode, 'work') <> 'readonly'
    ) SELECT t.id FROM tasks t JOIN candidate_ids c ON c.id = t.id
      WHERE t.dormant_since IS NULL AND t.routine_id IS NULL
        AND ${planStageSql("t")} IN ('active', 'delivered')
      ORDER BY t.created_at DESC, t.id DESC`).all(input.sessionId, input.botId ?? null, since);
  return rows.map((row) => candidateOf(ctx, row.id));
}

/** How many lines before yours a reading of where it belongs sees, and whose jobs it may file it under. */
export const LINES_BEFORE = 6;

type LineBefore = { id: string; kind: string; author: string; body: string; created_at: string; taskId: string | null };

/**
 * The lines just before `messageId` in its conversation, oldest first, each with the job it is
 * filed under (its primary filing; null when none). Lines only a Bot reads and the app's own lines
 * about your stops, cards and checks are not among them.
 */
export function linesBefore(ctx: StoreContext, messageId: string, limit = LINES_BEFORE): LineBefore[] {
  const line = ctx.db.query<{ session_id: string; created_at: string; message_seq: number }, [string]>(
    'SELECT session_id, created_at, message_seq FROM messages WHERE id = ?').get(messageId);
  if (!line) return [];
  return ctx.db.query<Omit<LineBefore, 'taskId'>, [string, string, string, number, number]>(`SELECT id, kind, author, body, created_at FROM messages
    WHERE session_id = ?1 AND id <> ?2 AND kind IN ('user', 'bot') AND hidden_from_bots = 0 AND bot_only = 0
      AND (created_at < ?3 OR (created_at = ?3 AND message_seq < ?4))
    ORDER BY created_at DESC, message_seq DESC LIMIT ?5`).all(line.session_id, messageId, line.created_at, line.message_seq, limit)
    .reverse()
    .map((row) => ({ ...row, taskId: inheritedTargets(ctx, row.id)[0]?.taskId ?? null }));
}

/**
 * The jobs a line may be about (ADR 0057): the conversation's candidates (`planCandidates`), and
 * the jobs the lines just before it are on, while those are still open or delivered — a routine's
 * standing plan or a dormant job included, which are never candidates by themselves. What you say
 * three minutes after the morning brief may well be about the brief (2026-10-03: with only the
 * conversation's candidates, the one left was a three-day-old address job). A desk segment
 * captures the same set, so the Bot can choose what the reading could not.
 */
export function lineCandidates(ctx: StoreContext, input: { sessionId: string; botId?: string; messageId: string }): PlanCandidate[] {
  const candidates = planCandidates(ctx, input);
  for (const line of linesBefore(ctx, input.messageId)) {
    if (!line.taskId || candidates.some((c) => c.id === line.taskId)) continue;
    const open = ctx.db.query(`SELECT 1 FROM tasks WHERE id = ?
      AND ${planStageSql()} IN ('active', 'delivered')`).get(line.taskId);
    if (open) candidates.push(candidateOf(ctx, line.taskId));
  }
  return candidates;
}

/** Read evidence only for an already captured id; never widen the desk's candidate set. */
export function candidateOf(ctx: StoreContext, taskId: string): PlanCandidate {
  const row = ctx.db.query<Omit<PlanCandidate, 'recentArtifacts' | 'lastUserQuote'>, [string]>(`SELECT id, title, dir,
    ${planStageSql()} AS stage,
    dormant_since AS dormantSince, MAX(created_at, COALESCE(spec_updated_at, created_at),
      COALESCE((SELECT MAX(last_activity_at) FROM turns WHERE task_id = tasks.id), created_at),
      COALESCE((SELECT MAX(created_at) FROM messages WHERE task_id = tasks.id), created_at),
      COALESCE((SELECT MAX(at) FROM work_events WHERE task_id = tasks.id), created_at),
      COALESCE((SELECT MAX(created_at) FROM user_quotes WHERE task_id = tasks.id), created_at)) AS lastActivityAt
    FROM tasks WHERE id = ?`).get(taskId);
  if (!row) throw new Error('no such plan');
  const recentArtifacts = ctx.db.query<{ path: string }, [string]>(`WITH plan_messages AS (
      SELECT id FROM messages WHERE task_id = ?1
      UNION SELECT message_id FROM message_filings WHERE task_id = ?1
    ) SELECT a.workspace_relpath AS path FROM plan_messages p JOIN messages m ON m.id = p.id
      JOIN attachments a ON a.message_id = p.id
      GROUP BY a.workspace_relpath ORDER BY MAX(m.created_at) DESC, path ASC LIMIT 3`).all(taskId).map((a) => a.path);
  const quote = ctx.db.query<{ body: string }, [string]>(`WITH plan_quotes AS (
      SELECT id FROM user_quotes WHERE task_id = ?1
      UNION SELECT quote_id AS id FROM user_quote_filings WHERE task_id = ?1
    ) SELECT q.body FROM plan_quotes p JOIN user_quotes q ON q.id = p.id WHERE q.redacted_at IS NULL
      ORDER BY q.created_at DESC, q.id DESC LIMIT 1`).get(taskId);
  return { ...row, recentArtifacts, lastUserQuote: quote?.body ?? null };
}

type FilingDecision = FilingTarget & { filedBy: string; strength: MessageFiling['strength'] };
type FilingMessage = {
  id: string; session_id: string; created_at: string; body: string; kind: string; author: string;
  parent_id: string | null; turn_id: string | null; task_id: string | null; ticket_id: string | null;
  control: string | null; filing_state: FilingState | null; filing_candidates: string | null; message_seq: number;
};

export function fileMessage(ctx: StoreContext, messageId: string, input: FileMessageInput = {}): {
  filings: MessageFiling[]; candidates: PlanCandidate[]; state: FilingState;
} {
  return ctx.commit(() => {
    const message = ctx.db.query<FilingMessage, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId);
    if (!message) throw new HttpError(404, 'not_found', 'no such message');
    // Validate a supplied binding even on a replay; a caller cannot smuggle a foreign work item.
    if (input.boundWorkItemId) for (const target of workItemTarget(ctx, input.boundWorkItemId, input.botId)) validTarget(ctx, target);
    for (const target of input.bound ?? []) validTarget(ctx, target);
    const existing = filingsOfMessage(ctx, messageId);
    if (input.botSelection) {
      if (!input.botId) throw new HttpError(422, 'invalid_args', 'bot selection requires bot id');
      const selected = [...new Map(input.botSelection.map((target) => [targetKey(target), target])).values()];
      for (const target of selected) validTarget(ctx, target);
      const authoritative = existing.filter((f) => f.strength === 'locked' || f.strength === 'user');
      if (authoritative.some((f) => !selected.some((target) => targetKey(target) === targetKey(f)))) {
        throw new HttpError(422, 'locked_attribution', 'locked attribution can only be changed by the user');
      }
      const ids: unknown = message.filing_candidates ? JSON.parse(message.filing_candidates) : null;
      const candidates = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string')
        .filter((id) => Boolean(ctx.db.query('SELECT 1 FROM tasks WHERE id = ?').get(id))).map((id) => candidateOf(ctx, id))
        : planCandidates(ctx, { sessionId: message.session_id, botId: input.botId });
      for (const target of selected) if (!candidates.some((c) => c.id === target.taskId)) candidates.push(candidateOf(ctx, target.taskId));
      const decisions = selected.map((target): FilingDecision => {
        const prior = authoritative.find((f) => targetKey(f) === targetKey(target));
        return { ...target, filedBy: prior?.filedBy ?? `bot:${input.botId}`, strength: prior?.strength ?? 'bot' };
      });
      const state: FilingState = decisions.length ? 'filed' : 'none';
      replaceFilings(ctx, message, decisions, state, candidates);
      recordWorkEvent(ctx, { kind: 'attribution.selected', actor: input.botId, botId: input.botId,
        taskId: selected[0]?.taskId, sessionId: message.session_id, payload: { message: messageId, before: existing, after: filingsOfMessage(ctx, messageId) } });
      return { filings: filingsOfMessage(ctx, messageId), candidates, state };
    }
    // A replay must neither undo your correction nor widen a captured desk snapshot.
    if (input.explicit === undefined && input.none === undefined && message.filing_state !== null
      && (message.filing_candidates !== null || message.filing_state === 'none' || existing.some((f) => f.strength === 'user') || existing.some((f) => f.strength === 'locked'))) {
      const ids: unknown = message.filing_candidates ? JSON.parse(message.filing_candidates) : null;
      const candidates = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string')
        .filter((id) => Boolean(ctx.db.query('SELECT 1 FROM tasks WHERE id = ?').get(id))).map((id) => candidateOf(ctx, id))
        : planCandidates(ctx, { sessionId: message.session_id, botId: input.botId });
      return { filings: existing, candidates, state: message.filing_state };
    }
    const candidates = message.kind === 'user'
      ? lineCandidates(ctx, { sessionId: message.session_id, botId: input.botId, messageId })
      : planCandidates(ctx, { sessionId: message.session_id, botId: input.botId });
    const control = pureControl(message.control);
    const decisions = !input.none && !control ? lockedDecisions(ctx, message, input) : [];
    // Nothing locked: a line of yours goes where a model read it as being about (ADR 0057) — never
    // where its words, a number in it or how it opens suggest. A target that has since closed or
    // gone is dropped; what is left unplaced is the Bot's to choose at its desk.
    if (!decisions.length && !input.none && !control && message.kind === 'user' && input.read?.about === 'jobs') {
      for (const target of input.read.targets) {
        if (!openTarget(ctx, target) || decisions.some((d) => targetKey(d) === targetKey(target))) continue;
        decisions.push({ ...target, filedBy: 'reader', strength: 'default' });
      }
    }
    // Explicitly referenced plans remain selectable, even when dormant or already accepted.
    for (const decision of decisions) if (!candidates.some((c) => c.id === decision.taskId)) candidates.push(candidateOf(ctx, decision.taskId));
    const state: FilingState = decisions.length ? 'filed' : input.none || control ? 'none' : 'undetermined';
    replaceFilings(ctx, message, decisions, state, candidates);
    if (message.kind === 'user') {
      ctx.db.run('UPDATE messages SET filing_reading = ? WHERE id = ?',
        [state === 'undetermined' && input.read?.about === 'new' ? 'new' : null, message.id]);
    }
    return { filings: filingsOfMessage(ctx, messageId), candidates, state };
  });
}

/**
 * Signals 1–5, in order, deduplicated: what you chose for the line (or the job it was sent from),
 * an annotation's file or line, the line a reply quotes, workspace paths it carries or names, and
 * the work it is bound to. Each is a reference the line makes, not a reading of what it says.
 */
function lockedDecisions(ctx: StoreContext, message: FilingMessage, input: FileMessageInput): FilingDecision[] {
  const decisions: FilingDecision[] = [];
  const add = (targets: FilingTarget[], rule: number) => {
    for (const target of targets) {
      validTarget(ctx, target);
      if (!decisions.some((d) => targetKey(d) === targetKey(target))) decisions.push({ ...target, filedBy: `rule:${rule}`, strength: 'locked' });
    }
  };
  add(input.explicit ?? (message.kind === 'user' && message.filing_state === null && message.task_id
    ? [{ taskId: message.task_id, ticketId: message.ticket_id }] : []), 1);
  const annotations = ctx.db.query<{ relpath: string; target_message_id: string; target_turn_id: string | null }, [string]>(
    "SELECT relpath, target_message_id, target_turn_id FROM annotations WHERE message_id = ? AND status <> 'draft' ORDER BY rowid").all(message.id);
  for (const annotation of annotations) {
    const paths = pathTargets(ctx, [annotation.relpath]);
    add(paths.length ? paths : inheritedTargets(ctx, annotation.target_message_id), 2);
    if (!paths.length && annotation.target_turn_id) add(turnTarget(ctx, annotation.target_turn_id), 2);
  }
  const reference = input.referenceMessageId ?? message.parent_id;
  if (reference) add(inheritedTargets(ctx, reference), 3);
  const paths = messagePaths(ctx, message);
  add(pathTargets(ctx, paths), 4);
  add(input.bound ?? [], 5);
  if (input.boundWorkItemId) add(workItemTarget(ctx, input.boundWorkItemId, input.botId), 5);
  // Bot output inherits its own current work item, never the source/waking turn.
  if (message.kind === 'bot' && message.turn_id) add(turnTarget(ctx, message.turn_id, message.author), 5);
  const wakes = ctx.db.query<FilingTarget, [string]>(`SELECT task_id AS taskId, ticket_id AS ticketId FROM check_backs
    WHERE message_id = ? AND task_id IS NOT NULL ORDER BY created_at, id`).all(message.id);
  add(wakes, 5);
  const boundItems = ctx.db.query<{ work_item_id: string | null; task_id: string | null; ticket_id: string | null }, [string]>(`SELECT work_item_id, task_id, ticket_id
    FROM inbox_items WHERE message_id = ? AND source IN ('delegation', 'delegation_reply', 'review', 'job', 'timer') ORDER BY seq`).all(message.id);
  for (const item of boundItems) add(item.work_item_id ? workItemTarget(ctx, item.work_item_id) : item.task_id ? [{ taskId: item.task_id, ticketId: item.ticket_id }] : [], 5);
  return decisions;
}

/** A target a reading named that can still take a line: its job open or delivered, its ticket not dropped, its part still there. */
function openTarget(ctx: StoreContext, target: FilingTarget): boolean {
  try {
    validTarget(ctx, target);
  } catch {
    return false;
  }
  const open = ctx.db.query(`SELECT 1 FROM tasks WHERE id = ?
    AND ${planStageSql()} IN ('active', 'delivered')`).get(target.taskId);
  if (!open) return false;
  if (!target.ticketId) return true;
  return Boolean(ctx.db.query(`SELECT 1 FROM tickets t WHERE t.id = ? AND ${STAGE_SQL('t')} <> 'dropped'`).get(target.ticketId));
}

/** Whether a line of yours was read as about none of the jobs it might have been (ADR 0057), and is still unplaced. */
export function lineReadAsNew(ctx: StoreContext, messageId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM messages WHERE id = ? AND filing_reading = 'new' AND filing_state = 'undetermined'`).get(messageId));
}

/** How many jobs, and tickets per job, a reading of where a line belongs is shown. */
const JOBS_TO_READ = 12;
const TICKETS_TO_READ = 12;
const PARTS_TO_READ = 30;

export type JobToFile = {
  taskId: string;
  title: string;
  goal: string | null;
  stage: 'active' | 'delivered';
  lastActivityAt: string;
  /** Null when the job lives in this conversation; else the name of the one it does. */
  home: string | null;
  tickets: Array<{ ticketId: string; title: string; stage: string; owner: string | null; parts: Array<{ key: string; title: string }> }>;
  recentArtifacts: string[];
  lastUserQuote: string | null;
};

/** What a model reads to say where a line of yours belongs (ADR 0057). */
export type LineToFile = {
  where: 'group' | 'direct';
  said: string;
  at: string;
  before: Array<{ author: string; text: string; at: string; taskId: string | null }>;
  jobs: JobToFile[];
};

/**
 * The line and the jobs it may be about, for the reading of where it belongs; null when there is
 * nothing for a reading to decide: not a line of yours, filed already, only a stop or a go on, a
 * locked signal places it, or no job is open for it.
 */
export function lineToFile(ctx: StoreContext, messageId: string): LineToFile | null {
  const message = ctx.db.query<FilingMessage, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (!message || message.kind !== 'user' || message.filing_state !== null || pureControl(message.control)) return null;
  try {
    if (lockedDecisions(ctx, message, {}).length) return null;
  } catch {
    // An unreadable locked signal is fileMessage's to refuse; a reading would not help.
    return null;
  }
  const candidates = lineCandidates(ctx, { sessionId: message.session_id, messageId })
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0))
    .slice(0, JOBS_TO_READ);
  if (candidates.length === 0) return null;
  const nameOf = (author: string): string => author === 'user' ? 'user'
    : ctx.db.query<{ name: string }, [string]>('SELECT name FROM bots WHERE id = ?').get(author)?.name ?? author;
  const jobs = candidates.map((candidate): JobToFile => {
    const task = ctx.db.query<{ session_id: string | null; spec: string | null; brief: string | null }, [string]>(
      'SELECT session_id, spec, brief FROM tasks WHERE id = ?').get(candidate.id);
    const home = task?.session_id && task.session_id !== message.session_id
      ? ctx.db.query<{ name: string | null; kind: string }, [string]>('SELECT name, kind FROM sessions WHERE id = ?').get(task.session_id)
      : null;
    const tickets = ctx.db.query<{ id: string; title: string; stage: string; owner: string | null }, [string]>(`SELECT t.id, t.title,
        ${STAGE_SQL('t')} AS stage, COALESCE(t.owner_bot_id, t.worker) AS owner FROM tickets t
      WHERE t.task_id = ? AND ${STAGE_SQL('t')} <> 'dropped' ORDER BY t.seq DESC LIMIT ${TICKETS_TO_READ}`).all(candidate.id).reverse();
    return {
      taskId: candidate.id,
      title: candidate.title,
      goal: parsePlanSpec(task?.spec ?? null)?.goal?.trim() || task?.brief?.trim() || null,
      stage: candidate.stage === 'delivered' ? 'delivered' : 'active',
      lastActivityAt: candidate.lastActivityAt,
      home: home ? (home.name ?? home.kind) : null,
      tickets: tickets.map((ticket) => ({
        ticketId: ticket.id,
        title: ticket.title,
        stage: ticket.stage,
        owner: ticket.owner ? nameOf(ticket.owner) : null,
        parts: ctx.db.query<{ key: string; title: string }, [string]>(`SELECT key, title FROM ticket_parts WHERE ticket_id = ?
          ORDER BY key LIMIT ${PARTS_TO_READ}`).all(ticket.id),
      })),
      recentArtifacts: candidate.recentArtifacts,
      lastUserQuote: candidate.lastUserQuote,
    };
  });
  const kind = ctx.db.query<{ kind: string }, [string]>('SELECT kind FROM sessions WHERE id = ?').get(message.session_id)?.kind;
  return {
    where: kind === 'direct' ? 'direct' : 'group',
    said: message.body,
    at: message.created_at,
    before: linesBefore(ctx, messageId).map((line) => ({ author: nameOf(line.kind === 'user' ? 'user' : line.author), text: line.body, at: line.created_at, taskId: line.taskId })),
    jobs,
  };
}

/**
 * A line the app wrote about your stops, a restart or a check is about no job. A line of yours only
 * marked as maybe meaning a stop or a go on (`possible_control`, 「继续优化标题」) went on as any line
 * and is filed as one; so is one an unreadable mark sits on.
 */
function pureControl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const kind = (JSON.parse(raw) as { kind?: unknown } | null)?.kind;
    return typeof kind === 'string' && kind !== 'possible_control';
  } catch {
    return false;
  }
}

function targetKey(target: FilingTarget): string {
  return JSON.stringify([target.taskId, target.ticketId ?? null, target.partKey ?? null]);
}

function replaceFilings(ctx: StoreContext, message: FilingMessage, decisions: FilingDecision[], state: FilingState, candidates?: PlanCandidate[]): void {
  ctx.db.run('DELETE FROM message_filings WHERE message_id = ?', [message.id]);
  for (const [i, target] of decisions.entries()) {
    ctx.db.run(`INSERT INTO message_filings (message_id, task_id, ticket_id, part_key, filed_by, strength, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [message.id, target.taskId, target.ticketId ?? null, target.partKey ?? null,
      target.filedBy, target.strength, i === 0 ? 1 : 0, message.created_at]);
  }
  // Before the legacy quote-following triggers clear dormant_since on the primary target.
  if (message.kind === 'user') for (const decision of decisions) {
    ctx.db.run('UPDATE tasks SET dormant_since = NULL, closed_at = NULL WHERE id = ? AND dormant_since IS NOT NULL', [decision.taskId]);
  }
  ctx.db.run('UPDATE messages SET task_id = ?, ticket_id = ?, filing_state = ? WHERE id = ?',
    [decisions[0]?.taskId ?? null, decisions[0]?.ticketId ?? null, state, message.id]);
  if (candidates) ctx.db.run('UPDATE messages SET filing_candidates = ? WHERE id = ?', [JSON.stringify(candidates.map((c) => c.id)), message.id]);
  ctx.db.run('UPDATE user_quotes SET task_id = ?, ticket_id = ?, part_key = ? WHERE message_id = ?',
    [decisions[0]?.taskId ?? null, decisions[0]?.ticketId ?? null, decisions[0]?.partKey ?? null, message.id]);
  const quotes = ctx.db.query<{ id: string }, [string]>('SELECT id FROM user_quotes WHERE message_id = ?').all(message.id);
  for (const quote of quotes) {
    ctx.db.run('DELETE FROM user_quote_filings WHERE quote_id = ?', [quote.id]);
    for (const target of decisions) ctx.db.run('INSERT INTO user_quote_filings (quote_id, task_id, ticket_id, part_key) VALUES (?, ?, ?, ?)',
      [quote.id, target.taskId, target.ticketId ?? null, target.partKey ?? null]);
  }
}

function inheritedTargets(ctx: StoreContext, messageId: string): FilingTarget[] {
  const filings = filingsOfMessage(ctx, messageId);
  if (filings.length) return filings;
  const legacy = ctx.db.query<{ task_id: string | null; ticket_id: string | null; filing_state: FilingState | null }, [string]>(
    'SELECT task_id, ticket_id, filing_state FROM messages WHERE id = ?').get(messageId);
  return legacy?.task_id && (legacy.filing_state === null || legacy.filing_state === 'filed')
    ? [{ taskId: legacy.task_id, ticketId: legacy.ticket_id }] : [];
}

function workItemTarget(ctx: StoreContext, id: string, botId?: string): FilingTarget[] {
  const row = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; state: string }, [string]>(
    'SELECT bot_id, task_id, ticket_id, state FROM work_items WHERE id = ?').get(id);
  if (!row || row.state === 'closed' || (botId && row.bot_id !== botId)) throw new HttpError(422, 'invalid_args', 'invalid bound work item');
  return row.task_id ? [{ taskId: row.task_id, ticketId: row.ticket_id }] : [];
}

function turnTarget(ctx: StoreContext, id: string, botId?: string): FilingTarget[] {
  const row = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null }, [string]>(
    'SELECT bot_id, task_id, ticket_id, work_item_id FROM turns WHERE id = ?').get(id);
  if (!row || (botId && row.bot_id !== botId)) throw new Error('invalid bound turn');
  // A completed delivery's work item may be closed: its immutable turn binding remains evidence.
  if (row.work_item_id) {
    const bound = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null }, [string]>('SELECT bot_id, task_id, ticket_id FROM work_items WHERE id = ?').get(row.work_item_id);
    if (!bound || bound.bot_id !== row.bot_id) throw new Error('invalid bound turn work item');
    return bound.task_id ? [{ taskId: bound.task_id, ticketId: bound.ticket_id }] : [];
  }
  return row.task_id ? [{ taskId: row.task_id, ticketId: row.ticket_id }] : [];
}

function messagePaths(ctx: StoreContext, message: { id?: string; body: string }): string[] {
  const paths = message.id ? ctx.db.query<{ path: string }, [string]>('SELECT workspace_relpath AS path FROM attachments WHERE message_id = ? ORDER BY rowid').all(message.id).map((r) => r.path) : [];
  // Quoted paths may contain spaces. Unquoted paths end at whitespace or ordinary prose punctuation.
  for (const match of message.body.matchAll(/[`"'](work\/[^`"'\n]+)[`"']|(?<![\w/])(?:work\/[^\s`"'<>()[\]，。；！？]+)/g)) {
    paths.push(match[1] ?? match[0]);
  }
  return paths;
}

/** Exact directory-prefix lookups, not LIKE over all titles/paths: matching cost follows path depth. */
function pathTargets(ctx: StoreContext, paths: string[]): FilingTarget[] {
  const targets: FilingTarget[] = [];
  for (const raw of paths.slice(0, 100)) {
    if (raw.length > 4096) continue;
    const segments = raw.replace(/\\/g, '/').replace(/[.,;:]+$/, '').split('/');
    if (segments.length > 32 || segments.some((s) => !s) || segments[0] !== 'work' || segments.includes('..') || segments.includes('.')) continue;
    for (let i = segments.length; i >= 2; i--) {
      const dir = segments.slice(0, i).join('/');
      const ticket = ctx.db.query<{ task_id: string; id: string }, [string]>('SELECT task_id, id FROM tickets WHERE dir = ?').get(dir);
      if (ticket) {
        // The part whose current file this is, as its hand-over named it; a file name numbers no part.
        const parts = ctx.db.query<{ key: string }, [string, string]>('SELECT key FROM ticket_parts WHERE ticket_id = ? AND current_artifact = ? ORDER BY key').all(ticket.id, raw);
        targets.push(...(parts.length ? parts.map((p) => ({ taskId: ticket.task_id, ticketId: ticket.id, partKey: p.key })) : [{ taskId: ticket.task_id, ticketId: ticket.id }]));
        break;
      }
      const task = ctx.db.query<{ id: string }, [string]>('SELECT id FROM tasks WHERE dir = ?').get(dir);
      if (task) { targets.push({ taskId: task.id }); break; }
    }
  }
  return targets;
}

export function resumePlan(ctx: StoreContext, taskId: string): void {
  validTarget(ctx, { taskId });
  ctx.commit(() => {
    const changed = ctx.db.query<{ id: string }, [string]>('UPDATE tasks SET dormant_since = NULL, closed_at = NULL WHERE id = ? AND dormant_since IS NOT NULL RETURNING id').get(taskId);
    if (changed) recordWorkEvent(ctx, { kind: 'plan.resumed', actor: 'user', taskId });
  });
}

/** Dormancy never changes plan stage or lifts holds. Hooks: clear-history, new-plan admission, ageing tick. */
export function updatePlanDormancy(ctx: StoreContext, input: {
  now?: string; clearedSessionId?: string; clearedAt?: string; newTaskId?: string;
} = {}): string[] {
  return ctx.commit(() => {
    const now = input.now ?? isoNow();
    const twoHours = isoPlus(now, -(2 * 60 * 60 * 1000));
    const seventyTwoHours = isoPlus(now, -(72 * 60 * 60 * 1000));
    const newPlan = input.newTaskId ? ctx.db.query<{ session_id: string | null; created_at: string }, [string]>('SELECT session_id, created_at FROM tasks WHERE id = ?').get(input.newTaskId) : null;
    if (input.newTaskId && !newPlan) throw new Error('no such new plan');
    // By the columns it reads, not the table's name: a draft's table of that name lacked them (ADR 0040 P4d).
    const externalJobs = externalJobsReadable(ctx.db);
    const rows = ctx.db.query<{ id: string; session_id: string | null; created_at: string; stage: string; delivered_at: string | null; last_user: string; recent_turn: number; open_work: number; pending_job: number }, Array<string | null>>(`SELECT t.id, t.session_id, t.created_at,
      ${planStageSql("t")} AS stage,
      t.delivered_at, MAX(COALESCE((SELECT MAX(q.created_at) FROM user_quotes q WHERE q.task_id = t.id), t.created_at),
        COALESCE((SELECT MAX(q.created_at) FROM user_quote_filings f JOIN user_quotes q ON q.id = f.quote_id
          WHERE f.task_id = t.id), t.created_at),
        COALESCE((SELECT MAX(e.at) FROM work_events e WHERE e.task_id = t.id AND e.actor = 'user'
          AND e.kind IN ('plan.resumed', 'attribution.changed')), t.created_at)) AS last_user,
      EXISTS (SELECT 1 FROM turns s WHERE s.task_id = t.id AND s.last_activity_at > ?1) AS recent_turn,
      (EXISTS (SELECT 1 FROM work_items w WHERE w.task_id = t.id AND w.state NOT IN ('idle', 'closed'))
        OR EXISTS (SELECT 1 FROM turns s WHERE s.task_id = t.id AND s.status IN ${LIVE_TURN_STATUSES})) AS open_work,
      ${externalJobs ? "EXISTS (SELECT 1 FROM external_jobs j WHERE j.task_id = t.id AND j.state = 'pending')" : '0'} AS pending_job
      FROM tasks t WHERE t.dormant_since IS NULL AND t.routine_id IS NULL
        AND (${planStageSql("t")} = 'delivered'
          OR t.session_id = ?2 OR t.session_id = ?3)`)
      .all(twoHours, input.clearedSessionId ?? null, newPlan?.session_id ?? null);
    const asleep: string[] = [];
    for (const row of rows) {
      let cause: string | null = null;
      if (input.clearedSessionId === row.session_id && candidateOf(ctx, row.id).lastActivityAt < (input.clearedAt ?? now)) cause = 'cleared';
      else if (row.stage === 'delivered' && row.delivered_at && row.delivered_at <= seventyTwoHours && row.last_user <= seventyTwoHours) cause = 'delivered_age';
      else if (newPlan?.session_id && row.session_id === newPlan.session_id && row.id !== input.newTaskId
        && row.created_at < newPlan.created_at && row.last_user <= twoHours && !row.recent_turn && !row.open_work && !row.pending_job) cause = 'new_plan';
      if (!cause) continue;
      ctx.db.run('UPDATE tasks SET dormant_since = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?', [now, now, row.id]);
      recordWorkEvent(ctx, { kind: 'plan.dormant', actor: 'app', taskId: row.id, sessionId: row.session_id, payload: { cause } });
      asleep.push(row.id);
    }
    return asleep;
  });
}

export type RefileMessageInput = FilingTarget | { filings: FilingTarget[]; userActionId: string };
export type RefileMessageResult = { id: string; session_id: string; task_id: string | null; ticket_id: string | null; filing_state: FilingState };

/** Move unread mail, never rewrite the history of what a running Bot already read. */
export function refileMessage(ctx: StoreContext, messageId: string, input: RefileMessageInput): RefileMessageResult {
  return ctx.commit(() => {
    const message = ctx.db.query<FilingMessage, [string]>('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!message) throw new HttpError(404, 'not_found', 'no such message');
    if ('filings' in input && !input.userActionId.trim()) throw new HttpError(422, 'invalid_args', 'user action id required');
    const targets = [...new Map(('filings' in input ? input.filings : [input]).map((t) => [targetKey(t), t])).values()];
    for (const target of targets) validTarget(ctx, target);
    const before = filingsOfMessage(ctx, messageId);
    const quotes = ctx.db.query<{ id: string; task_id: string | null; ticket_id: string | null; part_key: string | null }, [string]>(
      'SELECT id, task_id, ticket_id, part_key FROM user_quotes WHERE message_id = ?').all(messageId);
    const decisions = targets.map((target): FilingDecision => ({ ...target, filedBy: 'user', strength: 'user' }));
    replaceFilings(ctx, message, decisions, targets.length ? 'filed' : 'none');
    const primary = targets[0];
    for (const quote of quotes) {
      const project = primary ? ctx.db.query<{ session_id: string | null }, [string]>('SELECT session_id FROM tasks WHERE id = ?').get(primary.taskId)?.session_id ?? null : null;
      const partId = primary?.partKey && primary.ticketId ? ctx.db.query<{ id: string }, [string, string]>('SELECT id FROM ticket_parts WHERE ticket_id = ? AND key = ?').get(primary.ticketId, primary.partKey)?.id ?? null : null;
      const requirements = ctx.db.query<{ id: string; scope: string }, [string]>('SELECT id, scope FROM requirements WHERE source_quote_id = ?').all(quote.id);
      for (const requirement of requirements) {
        let scope = requirement.scope;
        let scopeId: string | null = null;
        if (scope === 'project') scopeId = project;
        else if (scope === 'plan') scopeId = primary?.taskId ?? null;
        else if (scope === 'ticket' || scope === 'part') {
          if (scope === 'part' && partId) scopeId = partId;
          else if (primary?.ticketId) { scope = 'ticket'; scopeId = primary.ticketId; }
          else { scope = 'plan'; scopeId = primary?.taskId ?? null; }
        } else { ctx.db.run('UPDATE requirements SET origin_task_id = ? WHERE id = ?', [primary?.taskId ?? null, requirement.id]); continue; }
        ctx.db.run('UPDATE requirements SET origin_task_id = ?, scope = ?, scope_id = ? WHERE id = ?', [primary?.taskId ?? null, scope, scopeId, requirement.id]);
      }
    }
    const inbox = ctx.db.query<{ seq: number; bot_id: string; session_id: string | null; task_id: string | null; ticket_id: string | null; state: string; source: string }, [string]>(
      'SELECT seq, bot_id, session_id, task_id, ticket_id, state, source FROM inbox_items WHERE message_id = ? ORDER BY seq').all(messageId);
    const corrected = new Set<string>();
    // A previous correction still unread will be retargeted below; do not enqueue a second one.
    if (primary) for (const item of inbox) if (item.source === 'system' && (item.state === 'queued' || item.state === 'held')) {
      corrected.add(`${item.bot_id}:${targetKey(primary)}`);
    }
    for (const item of inbox) {
      if (item.state === 'queued' || item.state === 'held') {
        if (!primary) {
          ctx.db.run("UPDATE inbox_items SET state = 'superseded', turn_id = NULL, work_item_id = NULL, disposition_note = 'message explicitly unfiled', disposed_at = ? WHERE seq = ?", [isoNow(), item.seq]);
          continue;
        }
        const route = refileRoute(ctx, item.bot_id, item.session_id ?? message.session_id, primary);
        ctx.db.run(`UPDATE inbox_items SET task_id = ?, ticket_id = ?, work_item_id = ?, turn_id = ?, session_id = ?, state = ?,
          body_snapshot = CASE WHEN source = 'system' THEN ? ELSE body_snapshot END WHERE seq = ?`,
          [primary.taskId, primary.ticketId ?? null, route.workItemId, route.turnId, route.sessionId, route.held ? 'held' : 'queued',
          `这句改归到 ${candidateOf(ctx, primary.taskId).title}：${message.body}`, item.seq]);
      } else if (['delivered', 'adopted', 'answered', 'declined', 'deferred', 'unacked', 'merged'].includes(item.state) && primary) {
        const key = `${item.bot_id}:${targetKey(primary)}`;
        if (corrected.has(key)) continue;
        corrected.add(key);
        queueCorrection(ctx, message, item.bot_id, item.session_id ?? message.session_id, primary);
      }
    }
    // The opening trigger is read as context, not as an inbox row. Its actual readers need the
    // same correction, while their original turn binding remains immutable.
    const readers = ctx.db.query<{ bot_id: string; session_id: string }, [string]>(
      'SELECT DISTINCT bot_id, session_id FROM turns WHERE trigger_message_id = ? ORDER BY bot_id, session_id').all(messageId);
    for (const target of targets) for (const reader of readers) {
      const key = `${reader.bot_id}:${targetKey(target)}`;
      if (!corrected.has(key)) { corrected.add(key); queueCorrection(ctx, message, reader.bot_id, reader.session_id, target); }
    }
    // More than one new filing gets distinct mail for every Bot that already received this line.
    for (const target of targets.slice(1)) for (const item of inbox) {
      const key = `${item.bot_id}:${targetKey(target)}`;
      if (!corrected.has(key)) { corrected.add(key); queueCorrection(ctx, message, item.bot_id, item.session_id ?? message.session_id, target); }
    }
    tellSegmentsLeftBehind(ctx, message, targets);
    recordWorkEvent(ctx, { kind: 'attribution.changed', actor: 'user', taskId: primary?.taskId ?? null, ticketId: primary?.ticketId ?? null,
      sessionId: message.session_id, payload: { message: messageId, user_action_id: 'filings' in input ? input.userActionId : null,
      before, after: filingsOfMessage(ctx, messageId) } });
    return ctx.db.query<RefileMessageResult, [string]>('SELECT id, session_id, task_id, ticket_id, filing_state FROM messages WHERE id = ?').get(messageId)!;
  });
}

/**
 * A segment still running that read the line, on a job the line is no longer filed under (or on no
 * job yet, at its desk), would go on acting on it there: your correction reached the job you moved
 * it to, and the segment never heard it. It hears so at its next step, from the app, and is told
 * not to act on the line where it is (2026-10-03: a new request glued to an old job could only be
 * stopped and said again).
 */
function tellSegmentsLeftBehind(ctx: StoreContext, message: FilingMessage, targets: FilingTarget[]): void {
  const segments = ctx.db.query<{ id: string; bot_id: string; session_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null }, [string]>(
    `SELECT t.id, t.bot_id, t.session_id, t.task_id, t.ticket_id, t.work_item_id FROM turns t
     WHERE t.status IN ${LIVE_TURN_STATUSES} AND IFNULL(t.mode, 'work') <> 'readonly'
       AND (t.trigger_message_id = ?1 OR EXISTS (SELECT 1 FROM inbox_items i WHERE i.message_id = ?1 AND i.delivered_turn_id = t.id))`).all(message.id);
  const where = targets.length
    ? targets.map((target) => `《${candidateOf(ctx, target.taskId).title}》`).join('、')
    : null;
  for (const segment of segments) {
    if (segment.task_id && targets.some((target) => target.taskId === segment.task_id)) continue;
    const body = where
      ? `（应用）用户把你这一段读过的这句话改归到了${where}，那件事会在那里另开一段做；这一段别再按这句动手：${message.body}`
      : `（应用）用户说这句话不归到任何事；这一段别再按这句动手：${message.body}`;
    ctx.db.run(`INSERT INTO inbox_items (id, bot_id, work_item_id, session_id, turn_id, task_id, ticket_id,
      message_id, author, body_snapshot, source, kind, priority, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'app', ?, 'system', 'change', 1, 'queued', ?)`, [ulid(), segment.bot_id, segment.work_item_id,
      segment.session_id, segment.id, segment.task_id, segment.ticket_id, message.id, body, isoNow()]);
  }
}

function refileRoute(ctx: StoreContext, botId: string, sessionId: string, target: FilingTarget): { workItemId: string; turnId: string | null; sessionId: string; held: boolean } {
  // I1b routes all mail about a plan to the Bot's one live segment, even when this correction
  // names no ticket (or another ticket). The segment's own binding remains unchanged.
  const live = ctx.db.query<{ id: string; session_id: string; work_item_id: string | null }, [string, string]>(`SELECT id, session_id, work_item_id
    FROM turns WHERE bot_id = ? AND task_id = ? AND IFNULL(mode, 'work') NOT IN ('readonly', 'desk')
      AND status IN ${LIVE_TURN_STATUSES} ORDER BY created_at DESC, id DESC LIMIT 1`).get(botId, target.taskId);
  let work = live?.work_item_id ? ctx.db.query<{ id: string; home_session_id: string; thread_session_id: string | null }, [string]>(
    'SELECT id, home_session_id, thread_session_id FROM work_items WHERE id = ?').get(live.work_item_id) : null;
  work ??= ctx.db.query<{ id: string; home_session_id: string; thread_session_id: string | null }, [string, string, string | null]>(`SELECT id, home_session_id, thread_session_id FROM work_items
    WHERE bot_id = ? AND task_id = ? AND ticket_id IS ? AND state <> 'closed'`).get(botId, target.taskId, target.ticketId ?? null);
  if (!work) {
    const now = isoNow();
    work = { id: ulid(), home_session_id: sessionId, thread_session_id: null };
    ctx.db.run(`INSERT INTO work_items (id, bot_id, task_id, ticket_id, home_session_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`, [work.id, botId, target.taskId, target.ticketId ?? null, sessionId, now, now]);
  }
  const turn = live ?? ctx.db.query<{ id: string; session_id: string }, [string, string]>(`SELECT id, session_id FROM turns WHERE work_item_id = ? AND bot_id = ?
    AND status IN ${LIVE_TURN_STATUSES} ORDER BY created_at DESC LIMIT 1`).get(work.id, botId);
  const destinationSession = turn?.session_id ?? work.thread_session_id ?? work.home_session_id;
  const held = Boolean(ctx.db.query<{ held: number }, Array<string | null>>(`SELECT ${heldSql({ bot: '?1', session: '?2', task: '?3', ticket: '?4', turn: '?5' })} AS held`)
    .get(botId, destinationSession, target.taskId, target.ticketId ?? null, turn?.id ?? null)?.held);
  return { workItemId: work.id, turnId: turn?.id ?? null, sessionId: destinationSession, held };
}

function queueCorrection(ctx: StoreContext, message: FilingMessage, botId: string, sessionId: string, target: FilingTarget): void {
  const route = refileRoute(ctx, botId, sessionId, target);
  const title = candidateOf(ctx, target.taskId).title;
  ctx.db.run(`INSERT INTO inbox_items (id, bot_id, work_item_id, session_id, turn_id, task_id, ticket_id,
    message_id, author, body_snapshot, source, kind, priority, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, 'system', 'change', 1, ?, ?)`, [ulid(), botId, route.workItemId,
    route.sessionId, route.turnId, target.taskId, target.ticketId ?? null, message.id, `这句改归到 ${title}：${message.body}`,
    route.held ? 'held' : 'queued', isoNow()]);
}
