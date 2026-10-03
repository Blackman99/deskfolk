/**
 * Durable Bot-to-Bot hand-offs (ADR 0040 P4c): identity and waiting belong to the store, never to
 * a quiet-thread timer. Writers do not open/end turns or call a model; the engine consumes their
 * returned inbox items and ends a segment when `wait` is present.
 */
import type { HoldScope, HoldTarget } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { HOLD_SCOPES, holdsCovering } from "./holds";
import { holdInboxItems, queueInboxItem, refreshHeldInbox, supersedeInboxItems, type InboxItem } from "./inbox";
import { aliveBot, isPresent, requireNonEmpty, sessionRow, type StoreContext } from "./shared";
import { requirementsBearingOn } from "./requirements";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { WorkItem } from "./work-items";

export type Delegation = {
  id: string;
  task_id: string;
  ticket_id: string | null;
  part_keys: string[];
  from_work_item_id: string;
  from_turn_id: string | null;
  to_bot_id: string;
  to_work_item_id: string;
  thread_session_id: string;
  ask: string;
  expects: "deliverable" | "review" | "answer";
  requirement_ids: string[];
  status: "open" | "replied" | "cancelled";
  reply_ref: string | null;
  request_inbox_seq: number | null;
  result_inbox_seq: number | null;
  due_at: string | null;
  created_at: string;
};
type DelegationRow = Omit<Delegation, "part_keys" | "requirement_ids"> & { part_keys: string; requirement_ids: string };
export type DelegationWait = {
  id: string;
  work_item_id: string;
  bot_id: string;
  session_id: string;
  turn_id: string | null;
  task_id: string;
  ticket_id: string | null;
  cause: "delegation";
  kind: "delegation_wait";
  wait_spec: { kind: "delegation"; ref: string };
  due_at: string;
  created_at: string;
  fired_at: string | null;
  voided_at: string | null;
  suspended_at: string | null;
};
type WaitRow = Omit<DelegationWait, "wait_spec"> & { wait_spec: string };
type Actor = {
  id: string; bot_id: string; session_id: string; task_id: string; ticket_id: string | null;
  work_item_id: string; home_session_id: string; trigger_message_id: string;
};

function toDelegation(row: DelegationRow): Delegation {
  return { ...row, part_keys: JSON.parse(row.part_keys) as string[], requirement_ids: JSON.parse(row.requirement_ids) as string[] };
}
export function getDelegation(ctx: StoreContext, id: string): Delegation {
  const row = ctx.db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "delegation not found");
  return toDelegation(row);
}
export function listDelegations(ctx: StoreContext, filter: {
  fromWorkItemId?: string; toWorkItemId?: string; threadSessionId?: string; status?: Delegation["status"];
} = {}): Delegation[] {
  return ctx.db.query<DelegationRow, Array<string | null>>(`SELECT * FROM delegations
    WHERE (?1 IS NULL OR from_work_item_id = ?1) AND (?2 IS NULL OR to_work_item_id = ?2)
      AND (?3 IS NULL OR thread_session_id = ?3) AND (?4 IS NULL OR status = ?4)
    ORDER BY created_at, rowid`).all(filter.fromWorkItemId ?? null, filter.toWorkItemId ?? null, filter.threadSessionId ?? null, filter.status ?? null).map(toDelegation);
}
export function getDelegationWait(ctx: StoreContext, delegationId: string): DelegationWait | null {
  const row = ctx.db.query<WaitRow, [string]>("SELECT * FROM check_backs WHERE dedupe_key = ? AND kind = 'delegation_wait' ORDER BY created_at DESC, id DESC LIMIT 1").get(`delegation:${delegationId}`);
  return row ? { ...row, wait_spec: JSON.parse(row.wait_spec) as DelegationWait["wait_spec"] } : null;
}

function actor(ctx: StoreContext, turnId: string): Actor {
  const row = ctx.db.query<Actor, [string]>(`SELECT t.*, w.home_session_id FROM turns t JOIN work_items w ON w.id = t.work_item_id
    WHERE t.id = ? AND t.status = 'running' AND IFNULL(t.mode, 'work') = 'work' AND t.task_id IS NOT NULL
      AND w.state <> 'closed' AND w.bot_id = t.bot_id AND w.task_id = t.task_id AND w.ticket_id IS t.ticket_id`).get(turnId);
  if (!row) throw new HttpError(422, "invalid_args", "delegation needs a running bound work turn");
  if (holdsCovering(ctx, { botId: row.bot_id, sessionId: row.session_id, taskId: row.task_id, ticketId: row.ticket_id, turnId }).length) {
    throw new HttpError(409, "held", "this work is held");
  }
  return row;
}

function clock(now: string | undefined): string {
  if (now === undefined) return isoNow();
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) throw new HttpError(422, "invalid_args", "now must be a valid timestamp");
  return new Date(now).toISOString();
}

function identifiers(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", `${field} must be an array of ids`);
  return [...new Set(value.map((entry) => requireNonEmpty(field, entry)))];
}

function validateBindings(ctx: StoreContext, taskId: string, ticketId: string | null, partKeys: string[], requirementIds: string[]): void {
  if (ticketId !== null && !ctx.db.query("SELECT 1 FROM tickets WHERE id = ? AND task_id = ?").get(ticketId, taskId)) {
    throw new HttpError(422, "invalid_args", "ticket must belong to the delegating plan");
  }
  if (partKeys.length && ticketId === null) throw new HttpError(422, "invalid_args", "parts need a ticket");
  const parts = ticketId === null ? [] : ctx.db.query<{ id: string; key: string }, [string]>("SELECT id, key FROM ticket_parts WHERE ticket_id = ?").all(ticketId);
  if (partKeys.some((key) => !parts.some((part) => part.key === key))) throw new HttpError(422, "invalid_args", "part must belong to the delegated ticket");
  const applicable = new Set(requirementsBearingOn(ctx, taskId, ["open"]).filter((entry) => !entry.excluded
    && (entry.scope !== "ticket" || entry.scope_id === ticketId)).map((entry) => entry.id));
  if (partKeys.length) {
    for (const entry of ctx.db.query<{ id: string; scope_id: string }, [string]>(`SELECT id, scope_id FROM requirements WHERE scope = 'part'
      AND status = 'open' AND NOT EXISTS (SELECT 1 FROM requirement_exclusions x WHERE x.requirement_id = requirements.id AND x.task_id = ?)` ).all(taskId)) {
      if (parts.some((part) => part.id === entry.scope_id && partKeys.includes(part.key))) applicable.add(entry.id);
    }
  }
  if (requirementIds.some((id) => !applicable.has(id))) throw new HttpError(422, "invalid_args", "cited requirement must be in force for the delegated work");
}

function thread(ctx: StoreContext, from: Actor, toBotId: string, now: string): string {
  const existing = ctx.db.query<{ id: string }, [string, string, string]>(`SELECT s.id FROM sessions s
    WHERE s.kind = 'direct' AND s.thread_task_id = ?1 AND s.archived_at IS NULL
      AND (SELECT COUNT(*) FROM session_participants p WHERE p.session_id = s.id AND p.left_at IS NULL) = 2
      AND EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.member = ?2 AND p.left_at IS NULL)
      AND EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.member = ?3 AND p.left_at IS NULL)
    ORDER BY s.created_at, s.id LIMIT 1`).get(from.task_id, from.bot_id, toBotId);
  if (existing) return existing.id;
  const id = ulid(Date.parse(now));
  ctx.db.run(`INSERT INTO sessions (id, kind, thread_task_id, origin_session_id, origin_message_id, created_at, updated_at)
    VALUES (?, 'direct', ?, ?, ?, ?, ?)`, [id, from.task_id, from.session_id, from.trigger_message_id, now, now]);
  for (const member of [from.bot_id, toBotId]) {
    ctx.db.run("INSERT INTO session_participants (session_id, member, joined_at) VALUES (?, ?, ?)", [id, member, now]);
  }
  return id;
}

function resultInbox(ctx: StoreContext, delegation: Delegation): InboxItem | null {
  return delegation.result_inbox_seq === null ? null : ctx.db.query<InboxItem, [number]>("SELECT * FROM inbox_items WHERE seq = ?").get(delegation.result_inbox_seq) ?? null;
}

function resolve(ctx: StoreContext, delegation: Delegation, from: Pick<Actor, "bot_id">, input: {
  answer: string; replyRef: string; now: string; status: "replied" | "cancelled"; wakes?: boolean;
}): InboxItem {
  const sender = ctx.db.query<{ bot_id: string; home_session_id: string; ticket_id: string | null }, [string]>(
    "SELECT bot_id, home_session_id, ticket_id FROM work_items WHERE id = ?").get(delegation.from_work_item_id);
  if (!sender) throw new HttpError(422, "invalid_args", "delegating work item no longer exists");
  const live = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM turns WHERE work_item_id = ?
    AND status IN ('running', 'waiting_ask', 'waiting_approval') ORDER BY created_at LIMIT 1`).get(delegation.from_work_item_id);
  const queued = queueInboxItem(ctx, { botId: sender.bot_id, sessionId: sender.home_session_id, turnId: live?.id ?? delegation.from_turn_id ?? null,
    sourceTurnId: delegation.from_turn_id,
    workItemId: delegation.from_work_item_id, taskId: delegation.task_id, ticketId: sender.ticket_id,
    messageId: null, author: from.bot_id, body: input.answer, saidIn: delegation.thread_session_id,
    source: "delegation_reply", kind: "result", priority: 2, wakes: input.wakes, now: input.now });
  ctx.db.run("UPDATE delegations SET status = ?, reply_ref = ?, result_inbox_seq = ? WHERE id = ? AND status = 'open'",
    [input.status, input.replyRef, queued.seq, delegation.id]);
  if (delegation.request_inbox_seq !== null) supersedeInboxItems(ctx, [delegation.request_inbox_seq], input.now);
  ctx.db.run("UPDATE check_backs SET voided_at = ?, suspended_at = NULL WHERE dedupe_key = ? AND kind = 'delegation_wait' AND fired_at IS NULL",
    [input.now, `delegation:${delegation.id}`]);
  ctx.db.run(`UPDATE work_items SET state = ?, waiting_on = NULL, updated_at = ? WHERE id = ? AND state = 'waiting'
    AND json_extract(waiting_on, '$.kind') = 'delegation' AND json_extract(waiting_on, '$.ref') = ?`,
    [input.wakes === false ? 'idle' : 'queued', input.now, delegation.from_work_item_id, delegation.id]);
  if (input.wakes !== false && !live) {
    ctx.db.run("UPDATE work_items SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'idle'",
      [input.now, delegation.from_work_item_id]);
  }
  refreshHeldInbox(ctx, { botId: sender.bot_id });
  const held = [delegation.from_turn_id, live?.id ?? null].some((turnId) => holdsCovering(ctx, {
    botId: sender.bot_id, sessionId: sender.home_session_id, taskId: delegation.task_id, ticketId: sender.ticket_id, turnId,
  }).length > 0);
  if (held) holdInboxItems(ctx, [queued.seq]);
  return ctx.db.query<InboxItem, [number]>("SELECT * FROM inbox_items WHERE seq = ?").get(queued.seq)!;
}

function validateSubmission(ctx: StoreContext, delegation: Delegation, from: Actor, id: string): void {
  if (!ctx.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submissions'").get()) {
    throw new HttpError(422, "invalid_args", "submission replies require a stored submission");
  }
  const row = ctx.db.query<{ work_item_id: string; task_id: string; ticket_id: string | null; bot_id: string;
    turn_id: string | null; part_keys: string; state: string }, [string]>("SELECT * FROM submissions WHERE id = ?").get(id);
  if (!row || row.work_item_id !== delegation.to_work_item_id || row.task_id !== delegation.task_id
    || row.ticket_id !== delegation.ticket_id || row.bot_id !== from.bot_id || row.turn_id !== from.id
    || !["in_review", "approved", "rejected"].includes(row.state)) {
    throw new HttpError(422, "invalid_args", "submission must belong to this delegated work and replying turn");
  }
  const parts: unknown = JSON.parse(row.part_keys);
  if (!Array.isArray(parts) || delegation.part_keys.some((key) => !parts.includes(key))) {
    throw new HttpError(422, "invalid_args", "submission must cover the delegated parts");
  }
}

export function replyDelegation(ctx: StoreContext, input: {
  delegationId: string; fromTurnId: string; answer?: string; submissionId?: string; now?: string;
}): { delegation: Delegation; inbox: InboxItem | null; replied: boolean } {
  return ctx.commit(() => {
    const delegation = getDelegation(ctx, input.delegationId);
    const from = actor(ctx, input.fromTurnId);
    if (from.bot_id !== delegation.to_bot_id || from.work_item_id !== delegation.to_work_item_id) {
      throw new HttpError(422, "invalid_args", "only the delegated work item can reply");
    }
    if (delegation.status !== "open") return { delegation, inbox: resultInbox(ctx, delegation), replied: false };
    const submissionId = input.submissionId === undefined ? null : requireNonEmpty("submissionId", input.submissionId);
    if (submissionId) validateSubmission(ctx, delegation, from, submissionId);
    const answer = input.answer === undefined && submissionId ? `Submission: ${submissionId}` : requireNonEmpty("answer", input.answer);
    const inbox = resolve(ctx, delegation, from, { answer, replyRef: submissionId ? `submission:${submissionId}` : `answer:${from.id}`,
      now: clock(input.now), status: "replied" });
    return { delegation: getDelegation(ctx, delegation.id), inbox, replied: true };
  });
}

/**
 * A hand-over approved answers the requests for it (2026-10-03). A delegation that expects a
 * deliverable is answered by the work it asked for being handed in and approved — by a review, the
 * app on its checks, or your 放行 — not by anything the producer says in the thread; nothing answered
 * it before, so the Bot that delegated waited for good and was never told (all three such
 * delegations in the live database ended only when their group was cleared). One that names parts
 * is answered once the approval covers them all; one that names none, once the ticket is through.
 */
export function deliverDelegations(ctx: StoreContext, submission: {
  id: string; work_item_id: string | null; task_id: string; part_keys: string[]; artifacts: Array<{ path: string }>; content: string | null;
}, input: { ticketApproved: boolean; now: string }): InboxItem[] {
  if (!submission.work_item_id) return [];
  const open = ctx.db.query<DelegationRow, [string, string]>(`SELECT * FROM delegations WHERE status = 'open' AND expects = 'deliverable'
    AND to_work_item_id = ? AND task_id = ? ORDER BY created_at, rowid`).all(submission.work_item_id, submission.task_id).map(toDelegation);
  const en = ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'locale'").get()?.value === "en";
  const out: InboxItem[] = [];
  for (const delegation of open) {
    const covered = delegation.part_keys.length > 0
      ? delegation.part_keys.every((key) => submission.part_keys.includes(key))
      : input.ticketApproved;
    if (!covered) continue;
    const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(delegation.to_bot_id)?.name ?? delegation.to_bot_id;
    const what = submission.artifacts.length > 0
      ? submission.artifacts.map((artifact) => artifact.path).join(en ? ", " : "、")
      : (submission.content ?? "").slice(0, 400);
    const answer = en
      ? `(app) ${name} handed in "${delegation.ask}", and it was approved (submission ${submission.id}): ${what}`
      : `（应用）${name} 交了「${delegation.ask}」，已通过（交付 ${submission.id}）：${what}`;
    out.push(resolve(ctx, delegation, { bot_id: delegation.to_bot_id }, { answer, replyRef: `submission:${submission.id}`, now: input.now, status: "replied" }));
  }
  return out;
}

export function cancelDelegation(ctx: StoreContext, input: {
  delegationId: string; fromTurnId: string; now?: string;
}): { delegation: Delegation; inbox: InboxItem | null; cancelled: boolean } {
  return ctx.commit(() => {
    const delegation = getDelegation(ctx, input.delegationId);
    const from = actor(ctx, input.fromTurnId);
    if (from.work_item_id !== delegation.from_work_item_id && from.work_item_id !== delegation.to_work_item_id) {
      throw new HttpError(422, "invalid_args", "only a party to the delegation can cancel it");
    }
    if (delegation.status !== "open") return { delegation, inbox: resultInbox(ctx, delegation), cancelled: false };
    const inbox = resolve(ctx, delegation, from, { answer: `Delegation cancelled: ${delegation.ask}`, replyRef: `cancel:${from.id}`,
      now: clock(input.now), status: "cancelled" });
    return { delegation: getDelegation(ctx, delegation.id), inbox, cancelled: true };
  });
}

/** Open durable edges, not delegated_by, define a cascade snapshot; reused work can have many parents. */
export function delegationDescendants(ctx: StoreContext, fromWorkItemIds: string[]): WorkItem[] {
  const roots = identifiers(fromWorkItemIds, "fromWorkItemIds");
  if (!roots.length) return [];
  return ctx.db.query<WorkItem, [string]>(`WITH RECURSIVE
    valid_edges AS (
      SELECT d.from_work_item_id AS parent, d.to_work_item_id AS child FROM delegations d
      JOIN work_items source ON source.id = d.from_work_item_id
      JOIN work_items target ON target.id = d.to_work_item_id
      WHERE d.status = 'open' AND target.state <> 'closed'
        AND source.task_id = d.task_id AND target.task_id = d.task_id
        AND target.bot_id = d.to_bot_id AND target.ticket_id IS d.ticket_id
        AND (d.ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets ticket WHERE ticket.id = d.ticket_id AND ticket.task_id = d.task_id))
    ), reachable(id) AS (
      SELECT id FROM work_items WHERE id IN (SELECT value FROM json_each(?1))
      UNION
      SELECT edge.child FROM valid_edges edge JOIN reachable parent ON parent.id = edge.parent
    )
    SELECT work.* FROM reachable JOIN work_items work ON work.id = reachable.id
    WHERE work.id NOT IN (SELECT value FROM json_each(?1))
    ORDER BY work.created_at, work.id`).all(JSON.stringify(roots));
}

/** Extra targets for a hold's fixed snapshot; the base scope itself is already covered by Control. */
export function delegationCascadeTargets(ctx: StoreContext, subject: { scope: HoldScope; id: string | null }): HoldTarget[] {
  if (!HOLD_SCOPES.includes(subject.scope)) throw new HttpError(422, "invalid_args", "invalid hold scope");
  if (subject.scope === 'global') {
    if (subject.id !== null) throw new HttpError(422, "invalid_args", "a global hold has no id");
    return [];
  }
  const id = requireNonEmpty("id", subject.id);
  let predicate: string;
  let params: string[];
  switch (subject.scope) {
    case 'bot':
      aliveBot(ctx, id);
      predicate = 'w.bot_id = ?1'; params = [id]; break;
    case 'bot_plan': {
      const separator = id.indexOf(':');
      const botId = id.slice(0, separator); const taskId = id.slice(separator + 1);
      if (separator <= 0 || !taskId) throw new HttpError(422, "invalid_args", "bot_plan id must name Bot and plan");
      aliveBot(ctx, botId);
      if (!ctx.db.query('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw new HttpError(404, 'not_found', 'plan not found');
      predicate = 'w.bot_id = ?1 AND w.task_id = ?2'; params = [botId, taskId]; break;
    }
    case 'session':
      sessionRow(ctx, id);
      predicate = `w.home_session_id = ?1 OR w.thread_session_id = ?1 OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = w.task_id AND t.session_id = ?1)`;
      params = [id]; break;
    case 'plan':
      if (!ctx.db.query('SELECT 1 FROM tasks WHERE id = ?').get(id)) throw new HttpError(404, 'not_found', 'plan not found');
      predicate = 'w.task_id = ?1'; params = [id]; break;
    case 'ticket':
      if (!ctx.db.query('SELECT 1 FROM tickets WHERE id = ?').get(id)) throw new HttpError(404, 'not_found', 'ticket not found');
      predicate = 'w.ticket_id = ?1'; params = [id]; break;
    case 'turn': {
      const turn = ctx.db.query<{ work_item_id: string | null }, [string]>('SELECT work_item_id FROM turns WHERE id = ?').get(id);
      if (!turn) throw new HttpError(404, 'not_found', 'turn not found');
      if (!turn.work_item_id) return [];
      predicate = 'w.id = ?1'; params = [turn.work_item_id]; break;
    }
  }
  const roots = ctx.db.query<WorkItem, string[]>(`SELECT w.* FROM work_items w WHERE (${predicate})`).all(...params);
  const rootIds = new Set(roots.map((root) => root.id));
  const targets = new Map<string, HoldTarget>();
  for (const work of delegationDescendants(ctx, [...rootIds])) {
    if (work.task_id) targets.set(`${work.bot_id}:${work.task_id}`, { scope: 'bot_plan', id: `${work.bot_id}:${work.task_id}` });
  }
  return [...targets.values()];
}

export type DelegationCancellation = { delegations: Delegation[]; inbox: InboxItem[] };

/** Called by the deterministic archive/delete write, before the Bot's rows or membership change. */
export function cancelDelegationsForBot(ctx: StoreContext, input: { botId: string; now?: string }): DelegationCancellation {
  return ctx.commit(() => {
    aliveBot(ctx, input.botId);
    const now = clock(input.now);
    const affected = ctx.db.query<DelegationRow, [string]>(`SELECT d.* FROM delegations d
      JOIN work_items source ON source.id = d.from_work_item_id
      WHERE d.status = 'open' AND (d.to_bot_id = ?1 OR source.bot_id = ?1) ORDER BY d.created_at, d.rowid`).all(input.botId).map(toDelegation);
    const result: DelegationCancellation = { delegations: [], inbox: [] };
    for (const delegation of affected) {
      const sender = ctx.db.query<{ bot_id: string; state: string; archived_at: string | null; deleted_at: string | null }, [string]>(
        `SELECT w.bot_id, w.state, b.archived_at, b.deleted_at FROM work_items w JOIN bots b ON b.id = w.bot_id WHERE w.id = ?`).get(delegation.from_work_item_id);
      const wakes = !!sender && sender.bot_id !== input.botId && sender.state !== 'closed' && !sender.archived_at && !sender.deleted_at;
      const inbox = resolve(ctx, delegation, { bot_id: input.botId }, { answer: `Delegation cancelled: Bot archived (${input.botId}) — ${delegation.ask}`,
        replyRef: `bot_archived:${input.botId}`, now, status: 'cancelled', wakes });
      result.delegations.push(getDelegation(ctx, delegation.id));
      result.inbox.push(inbox);
    }
    return result;
  });
}

/** Clearing/deleting a context records cancellation but deliberately schedules no new execution. */
export function cancelDelegationsForSession(ctx: StoreContext, input: { sessionId: string; now?: string }): DelegationCancellation {
  return ctx.commit(() => {
    sessionRow(ctx, input.sessionId);
    const now = clock(input.now);
    const affected = ctx.db.query<DelegationRow, [string]>(`SELECT d.* FROM delegations d
      LEFT JOIN work_items source ON source.id = d.from_work_item_id
      LEFT JOIN work_items target ON target.id = d.to_work_item_id
      LEFT JOIN tasks plan ON plan.id = d.task_id
      LEFT JOIN turns origin ON origin.id = d.from_turn_id
      WHERE d.status = 'open' AND (d.thread_session_id = ?1 OR source.home_session_id = ?1
        OR target.home_session_id = ?1 OR plan.session_id = ?1 OR origin.session_id = ?1)
      ORDER BY d.created_at, d.rowid`).all(input.sessionId).map(toDelegation);
    const result: DelegationCancellation = { delegations: [], inbox: [] };
    for (const delegation of affected) {
      const inbox = resolve(ctx, delegation, { bot_id: "app" }, { answer: `Delegation cancelled: conversation cleared — ${delegation.ask}`,
        replyRef: `session_cleared:${input.sessionId}`, now, status: 'cancelled', wakes: false });
      result.delegations.push(getDelegation(ctx, delegation.id));
      result.inbox.push(inbox);
    }
    return result;
  });
}

/**
 * A request for a deliverable on a ticket the caller owns, naming no part, makes whatever comes back
 * the whole ticket's hand-over (a delegate there hands it over as its producer). On 2026-10-04's
 * real-model run the poster group's lead, asked for a poster with three slogans, sent the slogans
 * straight to 文案 on the job's one ticket; 文案's 宣传语.txt then went to you to approve as the whole
 * job, and 放行 would have delivered it with no poster. From level 5 the piece gets a ticket of its
 * own first (`plan_items`, the lead's; with ADR 0053's layout, then the request), or comes back as an
 * answer for the caller to hand over itself.
 */
function refuseOwnTicket(ctx: StoreContext, input: { botId: string; ticketId: string | null; expects: Delegation["expects"]; partKeys: readonly string[] }): void {
  if (input.expects !== "deliverable" || !input.ticketId || input.partKeys.length > 0) return;
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.submissions) return;
  const owner = ctx.db.query<{ owner: string | null }, [string]>("SELECT COALESCE(owner_bot_id, worker) AS owner FROM tickets WHERE id = ?").get(input.ticketId)?.owner;
  if (owner !== input.botId) return;
  throw new HttpError(422, "invalid_args", "this ticket is your own: what the delegate hands over for it would close it as the whole of your work. "
    + "Give the piece you are handing over a ticket of its own first (plan_items: its title, the delegate as owner, you as reviewer) and delegate on that ticket, "
    + "or ask with expects \"answer\" to get it back and hand this ticket over yourself.");
}

export function delegateWork(ctx: StoreContext, input: {
  fromTurnId: string; toBotId: string; ask: string; expects: Delegation["expects"];
  ticketId?: string | null; partKeys?: string[]; requirementIds?: string[]; continue?: boolean; now?: string;
}): { delegation: Delegation; inbox: InboxItem; wait: DelegationWait | null } {
  return ctx.commit(() => {
    const from = actor(ctx, input.fromTurnId);
    const target = aliveBot(ctx, input.toBotId);
    const planHome = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(from.task_id)?.session_id;
    if (target.archived_at || target.id === from.bot_id || (!isPresent(ctx, from.session_id, target.id) && !isPresent(ctx, from.home_session_id, target.id)
      && (!planHome || !isPresent(ctx, planHome, target.id)))) {
      throw new HttpError(422, "invalid_args", "delegate to an eligible Bot present in this work's conversation");
    }
    const ask = requireNonEmpty("ask", input.ask);
    if (!["deliverable", "review", "answer"].includes(input.expects)) throw new HttpError(422, "invalid_args", "expects must be deliverable, review or answer");
    if (input.continue !== undefined && typeof input.continue !== "boolean") throw new HttpError(422, "invalid_args", "continue must be a boolean");
    const now = clock(input.now);
    const ticketId = input.ticketId === undefined ? from.ticket_id : input.ticketId;
    const partKeys = identifiers(input.partKeys, "partKeys");
    const requirementIds = identifiers(input.requirementIds, "requirementIds");
    validateBindings(ctx, from.task_id, ticketId, partKeys, requirementIds);
    refuseOwnTicket(ctx, { botId: from.bot_id, ticketId, expects: input.expects, partKeys });
    const threadId = thread(ctx, from, target.id, now);
    const recipientHome = planHome && isPresent(ctx, planHome, target.id) ? planHome
      : isPresent(ctx, from.home_session_id, target.id) ? from.home_session_id : from.session_id;
    let recipient = ctx.db.query<{ id: string }, [string, string, string | null]>(`SELECT id FROM work_items
      WHERE bot_id = ? AND task_id = ? AND ticket_id IS ? AND state <> 'closed' LIMIT 1`).get(target.id, from.task_id, ticketId);
    if (!recipient) {
      recipient = { id: ulid(Date.parse(now)) };
      ctx.db.run(`INSERT INTO work_items (id, bot_id, task_id, ticket_id, home_session_id, thread_session_id, role, state, delegated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, [recipient.id, target.id, from.task_id, ticketId, recipientHome, threadId,
          input.expects === "review" ? "review" : "assist", from.work_item_id, now, now]);
    }
    ctx.db.run(`UPDATE work_items SET thread_session_id = ?, updated_at = ?,
      state = CASE WHEN EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = work_items.id
        AND t.status IN ('running', 'waiting_ask', 'waiting_approval')) THEN state ELSE 'queued' END
      WHERE id = ?`, [threadId, now, recipient.id]);
    const id = ulid(Date.parse(now));
    ctx.db.run(`INSERT INTO delegations (id, task_id, ticket_id, from_work_item_id, from_turn_id, to_bot_id, to_work_item_id, thread_session_id, ask, expects, part_keys, requirement_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, from.task_id, ticketId, from.work_item_id, from.id, target.id, recipient.id, threadId, ask, input.expects,
        JSON.stringify(partKeys), JSON.stringify(requirementIds), now]);
    const recipientLive = ctx.db.query<{ id: string; session_id: string }, [string]>(`SELECT id, session_id FROM turns
      WHERE work_item_id = ? AND status IN ('running', 'waiting_ask', 'waiting_approval') ORDER BY created_at LIMIT 1`).get(recipient.id);
    const inbox = queueInboxItem(ctx, { botId: target.id, sessionId: threadId, turnId: recipientLive?.id ?? null, workItemId: recipient.id,
      taskId: from.task_id, ticketId, messageId: null, author: from.bot_id, body: ask, source: "delegation", kind: "change", priority: 3, now });
    ctx.db.run("UPDATE delegations SET request_inbox_seq = ? WHERE id = ?", [inbox.seq, id]);
    refreshHeldInbox(ctx, { botId: target.id });
    if (recipientLive && holdsCovering(ctx, { botId: target.id, sessionId: recipientLive.session_id,
      taskId: from.task_id, ticketId, turnId: recipientLive.id }).length > 0) holdInboxItems(ctx, [inbox.seq]);
    if (input.continue !== true) {
      ctx.db.run(`INSERT INTO check_backs (id, work_item_id, bot_id, session_id, turn_id, task_id, ticket_id, note, due_at, created_at, kind, cause, wait_spec, dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delegation_wait', 'delegation', ?, ?)`, [ulid(Date.parse(now)), from.work_item_id,
        from.bot_id, from.home_session_id, from.id, from.task_id, from.ticket_id, ask, now, now, JSON.stringify({ kind: "delegation", ref: id }), `delegation:${id}`]);
      ctx.db.run("UPDATE work_items SET state = 'waiting', waiting_on = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify({ kind: "delegation", ref: id, since: now }), now, from.work_item_id]);
    }
    return { delegation: getDelegation(ctx, id), inbox: ctx.db.query<InboxItem, [number]>("SELECT * FROM inbox_items WHERE seq = ?").get(inbox.seq)!, wait: getDelegationWait(ctx, id) };
  });
}
