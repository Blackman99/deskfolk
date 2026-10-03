/**
 * Deterministic message attribution (ADR 0040 §8.2): locked signals 1–5 accumulate in order;
 * otherwise defaults 6–8 decide one plan. message_filings is authoritative; the old message and
 * quote columns project only its primary target. Candidate ids are captured with the decision.
 * Dormancy is independent of stage and holds. Engine/API integration belongs to the facade.
 */
import { isoNow, ulid } from "../ids";
import { HttpError } from "../errors";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";
import { heldSql } from "./holds";
import { externalJobsReadable } from "./external-jobs-migration";

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
        AND COALESCE(t.stage, CASE WHEN t.status = 'done' THEN 'delivered' ELSE 'active' END) IN ('active', 'delivered')
      ORDER BY t.created_at DESC, t.id DESC`).all(input.sessionId, input.botId ?? null, since);
  return rows.map((row) => candidateOf(ctx, row.id));
}

/** Read evidence only for an already captured id; never widen the desk's candidate set. */
export function candidateOf(ctx: StoreContext, taskId: string): PlanCandidate {
  const row = ctx.db.query<Omit<PlanCandidate, 'recentArtifacts' | 'lastUserQuote'>, [string]>(`SELECT id, title, dir,
    COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) AS stage,
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
    const candidates = planCandidates(ctx, { sessionId: message.session_id, botId: input.botId });
    const control = pureControl(message.control);
    const decisions: FilingDecision[] = [];
    const add = (targets: FilingTarget[], rule: number) => {
      for (const target of targets) {
        validTarget(ctx, target);
        if (!decisions.some((d) => targetKey(d) === targetKey(target))) decisions.push({ ...target, filedBy: `rule:${rule}`, strength: 'locked' });
      }
    };
    if (!input.none && !control) {
      add(input.explicit ?? (message.kind === 'user' && message.filing_state === null && message.task_id
        ? [{ taskId: message.task_id, ticketId: message.ticket_id }] : []), 1);
      const annotations = ctx.db.query<{ relpath: string; target_message_id: string; target_turn_id: string | null }, [string]>(
        "SELECT relpath, target_message_id, target_turn_id FROM annotations WHERE message_id = ? AND status <> 'draft' ORDER BY rowid").all(messageId);
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
        WHERE message_id = ? AND task_id IS NOT NULL ORDER BY created_at, id`).all(messageId);
      add(wakes, 5);
      const boundItems = ctx.db.query<{ work_item_id: string | null; task_id: string | null; ticket_id: string | null }, [string]>(`SELECT work_item_id, task_id, ticket_id
        FROM inbox_items WHERE message_id = ? AND source IN ('delegation', 'delegation_reply', 'review', 'job', 'timer') ORDER BY seq`).all(messageId);
      for (const item of boundItems) add(item.work_item_id ? workItemTarget(ctx, item.work_item_id) : item.task_id ? [{ taskId: item.task_id, ticketId: item.ticket_id }] : [], 5);
    }
    if (!decisions.length && !input.none && !control && message.kind === 'user') {
      decisions.push(...defaultDecisions(ctx, { sessionId: message.session_id, body: message.body, candidates, line: message }));
    }
    // Explicitly referenced plans remain selectable, even when dormant or already accepted.
    for (const decision of decisions) if (!candidates.some((c) => c.id === decision.taskId)) candidates.push(candidateOf(ctx, decision.taskId));
    const state: FilingState = decisions.length ? 'filed' : input.none || control ? 'none' : 'undetermined';
    replaceFilings(ctx, message, decisions, state, candidates);
    return { filings: filingsOfMessage(ctx, messageId), candidates, state };
  });
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
        const delivered = Boolean(ctx.db.query(`SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE a.workspace_relpath = ? AND m.ticket_id = ? AND m.kind = 'bot' LIMIT 1`).get(raw, ticket.id));
        if (delivered) registerFilenameParts(ctx, ticket.id, raw);
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

const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUMBER = '[零一二两三四五六七八九十百\\d]+';
const PART_WORD = new RegExp(`前\\s*(${NUMBER})\\s*镜|第\\s*(${NUMBER})\\s*镜|(?<![a-z])(?:shot|镜头?|c)\\s*[ _-]?\\s*0*(\\d{1,3})(?:\\s*[–—-]\\s*0*(\\d{1,3}))?(?!\\d)|(?<!\\d)(\\d{1,3})\\s*[–—-]\\s*(\\d{1,3})(?!\\d)`, 'gi');

/** One bounded numbering system, 1..999; ranges and Chinese tens use exactly the same numbers. */
export function partNumbers(body: string): number[] {
  const found = new Set<number>();
  const range = (from: number, to: number) => {
    if (from < 1 || to > 999 || from > to) return;
    for (let n = from; n <= to; n++) found.add(n);
  };
  for (const match of body.matchAll(PART_WORD)) {
    if (match[1]) range(1, numberOf(match[1]));
    else if (match[2]) range(numberOf(match[2]), numberOf(match[2]));
    else if (match[3]) range(Number(match[3]), Number(match[4] ?? match[3]));
    else if (match[5] && match[6]) range(Number(match[5]), Number(match[6]));
  }
  return [...found].sort((a, b) => a - b);
}

function numberOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  let result = 0;
  let digit = 0;
  for (const char of text) {
    if (char === '十' || char === '百') { result += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = CN[char] ?? 0;
  }
  return result + digit;
}

/** How long after the Bot's line a line of yours in your direct still answers it (rule 9). */
export const ANSWERS_BOT_LINE_MS = 2 * 60 * 60 * 1000;

/**
 * Rule 9: in your direct with a Bot, a line of yours that comes right after the Bot's line, with
 * nothing of yours in between and within {@link ANSWERS_BOT_LINE_MS}, answers that line the way a
 * quoted reply does, and goes where it went. That reaches a routine's standing plan and its dated
 * ticket too, which no other default does: what you say three minutes after the morning brief is
 * about the morning brief, not about the one other job the conversation has open (2026-10-03).
 */
function answeredBotLine(ctx: StoreContext, line: Pick<FilingMessage, 'id' | 'session_id' | 'created_at' | 'parent_id'> & { message_seq?: number }): FilingTarget[] {
  if (line.parent_id) return [];
  const session = ctx.db.query<{ kind: string }, [string]>('SELECT kind FROM sessions WHERE id = ?').get(line.session_id);
  if (session?.kind !== 'direct' || !ctx.db.query("SELECT 1 FROM session_participants WHERE session_id = ? AND member = 'user'").get(line.session_id)) return [];
  const previous = ctx.db.query<{ id: string; kind: string; created_at: string }, [string, string, string, number]>(`SELECT id, kind, created_at FROM messages
    WHERE session_id = ?1 AND id <> ?2 AND parent_id IS NULL AND kind IN ('user', 'bot') AND hidden_from_bots = 0
      AND (created_at < ?3 OR (created_at = ?3 AND message_seq < ?4))
    ORDER BY created_at DESC, message_seq DESC LIMIT 1`).get(line.session_id, line.id, line.created_at, line.message_seq ?? Number.MAX_SAFE_INTEGER);
  if (previous?.kind !== 'bot' || Date.parse(line.created_at) - Date.parse(previous.created_at) > ANSWERS_BOT_LINE_MS) return [];
  // A job you have accepted or dropped since is not where a new line goes; the other rules read it.
  return inheritedTargets(ctx, previous.id).filter((target) => ctx.db.query(`SELECT 1 FROM tasks WHERE id = ?
    AND COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) IN ('active', 'delivered')`).get(target.taskId));
}

function defaultDecisions(ctx: StoreContext, input: {
  sessionId: string; body: string; candidates: PlanCandidate[];
  /** The line being filed, when there is one: what rule 9 reads it against. */
  line?: Pick<FilingMessage, 'id' | 'session_id' | 'created_at' | 'parent_id'> & { message_seq?: number };
}): FilingDecision[] {
  const candidates = input.candidates.filter((c) => c.dormantSince === null && (c.stage === 'active' || c.stage === 'delivered'));
  const numbers = partNumbers(input.body);
  const { hits: partHits, ambiguous } = matchParts(ctx, candidates, numbers);
  const newRequest = /^(?:另外|再帮我|新做|顺便)/.test(input.body.trim()) && numbers.length === 0 && messagePaths(ctx, input).length === 0;
  const decide = (target: FilingTarget, rule: number): FilingDecision => ({ ...target, filedBy: `rule:${rule}`, strength: 'default' });
  // Signal 9 comes before the others: an answer to the Bot's line is about that line's job.
  const answered = input.line && !newRequest ? answeredBotLine(ctx, input.line) : [];
  if (answered.length) return answered.map((target) => decide(target, 9));
  // Signal 6 decides the plan first. Within it, attach uniquely known parts without overriding its provenance.
  if (candidates.length === 1 && !newRequest) {
    const planHits = partHits.filter((hit) => hit.taskId === candidates[0]!.id);
    return (planHits.length ? planHits : [{ taskId: candidates[0]!.id }]).map((hit) => decide(hit, 6));
  }
  if (!ambiguous && new Set(partHits.map((hit) => hit.taskId)).size === 1) return partHits.map((hit) => decide(hit, 7));
  const session = ctx.db.query<{ kind: string }, [string]>('SELECT kind FROM sessions WHERE id = ?').get(input.sessionId);
  if (session?.kind === 'group' && !newRequest) {
    const own = candidates.filter((c) => c.stage === 'active' && ctx.db.query('SELECT 1 FROM tasks WHERE id = ? AND session_id = ?').get(c.id, input.sessionId));
    if (own.length === 1) return [decide({ taskId: own[0]!.id }, 8)];
  }
  return [];
}

/** The part numbers a file's name gives (§8.2 rule 7): `shot_07`, `C07`, `镜头7`, `第七镜`. */
export function filenamePartNumbers(path: string): number[] {
  const filename = path.split('/').at(-1) ?? '';
  const found = new Set<number>();
  for (const match of filename.matchAll(/(?<![a-z])(?:shot|c|镜头?)[ _-]?0*(\d{1,3})(?!\d)/gi)) found.add(Number(match[1]));
  for (const match of filename.matchAll(/第?([零一二两三四五六七八九十百]+)镜|镜头?([零一二两三四五六七八九十百]+)/g)) found.add(numberOf(match[1] ?? match[2]!));
  return [...found].filter((n) => n >= 1 && n <= 999).sort((a, b) => a - b);
}

/**
 * The ticket's parts a file's name numbers, made when missing (declared by the file name); returns
 * their keys. A part made this way starts with that file as its current one.
 */
export function registerFilenameParts(ctx: StoreContext, ticketId: string, path: string): string[] {
  return filenamePartNumbers(path).map((n) => {
    const key = `shot_${String(n).padStart(2, '0')}`;
    ctx.db.run(`INSERT OR IGNORE INTO ticket_parts (id, ticket_id, key, title, declared_by, current_artifact)
      VALUES (?, ?, ?, ?, 'filename', ?)`, [ulid(), ticketId, key, `Shot ${String(n).padStart(2, '0')}`, path]);
    return key;
  });
}

/** Filename discovery only traverses candidate plans and materializes identities, not delivery stages. */
function matchParts(ctx: StoreContext, candidates: PlanCandidate[], numbers: number[]): { hits: FilingTarget[]; ambiguous: boolean } {
  if (!numbers.length) return { hits: [], ambiguous: false };
  const hits: FilingTarget[] = [];
  let anyAmbiguous = false;
  for (const candidate of candidates) {
    const tickets = ctx.db.query<{ id: string; title: string }, [string]>('SELECT id, title FROM tickets WHERE task_id = ? ORDER BY seq').all(candidate.id);
    for (const ticket of tickets) {
      const paths = ctx.db.query<{ path: string }, [string]>(`SELECT a.workspace_relpath AS path FROM messages m
        JOIN attachments a ON a.message_id = m.id WHERE m.ticket_id = ? AND m.kind = 'bot'
        ORDER BY m.created_at DESC, a.id DESC LIMIT 256`).all(ticket.id);
      for (const { path } of paths) registerFilenameParts(ctx, ticket.id, path);
    }
    const parts = ctx.db.query<{ ticket_id: string; key: string; title: string }, [string]>(`SELECT p.ticket_id, p.key, p.title FROM ticket_parts p
      JOIN tickets k ON k.id = p.ticket_id WHERE k.task_id = ? ORDER BY k.seq, p.key`).all(candidate.id);
    const selected: FilingTarget[] = [];
    const covered = new Set<number>();
    let ambiguous = false;
    for (const n of numbers) {
      const matching = parts.filter((part) => partNumbers(`${part.key} ${part.title}`).includes(n));
      if (matching.length > 1) { ambiguous = true; break; }
      if (matching.length === 1) {
        const part = matching[0]!;
        selected.push({ taskId: candidate.id, ticketId: part.ticket_id, partKey: part.key });
        covered.add(n);
      }
    }
    if (ambiguous) { anyAmbiguous = true; continue; }
    if (covered.size === numbers.length) {
      hits.push(...[...new Map(selected.map((hit) => [targetKey(hit), hit])).values()]);
      continue;
    }
    // Minimum legacy compatibility: titles declared before ticket_parts carry a numbered span.
    const legacy = tickets.filter((ticket) => numbers.every((n) => partNumbers(ticket.title).includes(n)));
    if (legacy.length === 1) hits.push({ taskId: candidate.id, ticketId: legacy[0]!.id });
    else if (legacy.length > 1) anyAmbiguous = true;
  }
  return { hits, ambiguous: anyAmbiguous };
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
    const twoHours = new Date(Date.parse(now) - 2 * 60 * 60 * 1000).toISOString();
    const seventyTwoHours = new Date(Date.parse(now) - 72 * 60 * 60 * 1000).toISOString();
    const newPlan = input.newTaskId ? ctx.db.query<{ session_id: string | null; created_at: string }, [string]>('SELECT session_id, created_at FROM tasks WHERE id = ?').get(input.newTaskId) : null;
    if (input.newTaskId && !newPlan) throw new Error('no such new plan');
    // By the columns it reads, not the table's name: a draft's table of that name lacked them (ADR 0040 P4d).
    const externalJobs = externalJobsReadable(ctx.db);
    const rows = ctx.db.query<{ id: string; session_id: string | null; created_at: string; stage: string; delivered_at: string | null; last_user: string; recent_turn: number; open_work: number; pending_job: number }, Array<string | null>>(`SELECT t.id, t.session_id, t.created_at,
      COALESCE(t.stage, CASE WHEN t.status = 'done' THEN 'delivered' ELSE 'active' END) AS stage,
      t.delivered_at, MAX(COALESCE((SELECT MAX(q.created_at) FROM user_quotes q WHERE q.task_id = t.id), t.created_at),
        COALESCE((SELECT MAX(q.created_at) FROM user_quote_filings f JOIN user_quotes q ON q.id = f.quote_id
          WHERE f.task_id = t.id), t.created_at),
        COALESCE((SELECT MAX(e.at) FROM work_events e WHERE e.task_id = t.id AND e.actor = 'user'
          AND e.kind IN ('plan.resumed', 'attribution.changed')), t.created_at)) AS last_user,
      EXISTS (SELECT 1 FROM turns s WHERE s.task_id = t.id AND s.last_activity_at > ?1) AS recent_turn,
      (EXISTS (SELECT 1 FROM work_items w WHERE w.task_id = t.id AND w.state NOT IN ('idle', 'closed'))
        OR EXISTS (SELECT 1 FROM turns s WHERE s.task_id = t.id AND s.status IN ('running', 'waiting_approval', 'waiting_ask'))) AS open_work,
      ${externalJobs ? "EXISTS (SELECT 1 FROM external_jobs j WHERE j.task_id = t.id AND j.state = 'pending')" : '0'} AS pending_job
      FROM tasks t WHERE t.dormant_since IS NULL AND t.routine_id IS NULL
        AND (COALESCE(t.stage, CASE WHEN t.status = 'done' THEN 'delivered' ELSE 'active' END) = 'delivered'
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
    recordWorkEvent(ctx, { kind: 'attribution.changed', actor: 'user', taskId: primary?.taskId ?? null, ticketId: primary?.ticketId ?? null,
      sessionId: message.session_id, payload: { message: messageId, user_action_id: 'filings' in input ? input.userActionId : null,
      before, after: filingsOfMessage(ctx, messageId) } });
    return ctx.db.query<RefileMessageResult, [string]>('SELECT id, session_id, task_id, ticket_id, filing_state FROM messages WHERE id = ?').get(messageId)!;
  });
}

function refileRoute(ctx: StoreContext, botId: string, sessionId: string, target: FilingTarget): { workItemId: string; turnId: string | null; sessionId: string; held: boolean } {
  // I1b routes all mail about a plan to the Bot's one live segment, even when this correction
  // names no ticket (or another ticket). The segment's own binding remains unchanged.
  const live = ctx.db.query<{ id: string; session_id: string; work_item_id: string | null }, [string, string]>(`SELECT id, session_id, work_item_id
    FROM turns WHERE bot_id = ? AND task_id = ? AND IFNULL(mode, 'work') NOT IN ('readonly', 'desk')
      AND status IN ('running', 'waiting_approval', 'waiting_ask') ORDER BY created_at DESC, id DESC LIMIT 1`).get(botId, target.taskId);
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
    AND status IN ('running', 'waiting_approval', 'waiting_ask') ORDER BY created_at DESC LIMIT 1`).get(work.id, botId);
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

/** Legacy scalar caller; the same ordered defaults, never the old shared-user/first-worker heuristic. */
export function fileLine(ctx: StoreContext, input: { sessionId: string; body: string }): Filing | null {
  return ctx.commit(() => {
    const candidates = planCandidates(ctx, { sessionId: input.sessionId });
    const target = defaultDecisions(ctx, { ...input, candidates })[0];
    return target ? { taskId: target.taskId, ticketId: target.ticketId ?? null } : null;
  });
}
