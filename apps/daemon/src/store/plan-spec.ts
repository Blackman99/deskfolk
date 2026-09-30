/**
 * A plan's spec over time, and the two ways it changes: the organizer's run and the user's edit.
 * Every change is a revision that names its cause — the message or turn that prompted it, or the
 * user — so the board can show how the goal moved. The organizer's ticket list is applied here
 * too, in one transaction with the spec, so a plan is never half-updated.
 */
import type { AcceptanceCheck, TaskDetail, TaskSpecRevision, Ticket, TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { applyOrganizerChecks, checkNeverRanSinceDefinition, checksHoldingPlanOpen, listChecks, rebindCheckItems, type OrganizerCheckInput } from "./acceptance-checks";
import { normalizePlanSpec, parsePlanSpec, type PlanSpec } from "./plan-shape";
import { type StoreContext } from "./shared";
import {
  elsewherePlans,
  getTask,
  openTask,
  reopenTask,
  sessionRecentTasks,
  setTaskSpec,
  taskLastActivityAt,
  taskSummary,
  type Task,
} from "./tasks";
import { createTicket, isTicketStatus, listTickets, patchTicket, ticketArtifacts, TICKETS_MAX } from "./tickets";

export type SpecRevisionRow = {
  id: string;
  task_id: string;
  revision: number;
  spec: string;
  tickets_snapshot: string;
  source_message_id: string | null;
  source_turn_id: string | null;
  actor: "app" | "user";
  created_at: string;
};

export function currentRevision(ctx: StoreContext, taskId: string): number {
  const row = ctx.db
    .query<{ n: number | null }, [string]>(`SELECT MAX(revision) AS n FROM task_spec_revisions WHERE task_id = ?`)
    .get(taskId);
  return row?.n ?? 0;
}

/** When the spec last changed, else when the plan was opened: the organizer reads what came after. */
export function lastSpecRevisionAt(ctx: StoreContext, taskId: string): string {
  const row = ctx.db
    .query<{ at: string | null }, [string]>(`SELECT MAX(created_at) AS at FROM task_spec_revisions WHERE task_id = ?`)
    .get(taskId);
  return row?.at ?? getTask(ctx, taskId).created_at;
}

function toRevision(ctx: StoreContext, row: SpecRevisionRow): TaskSpecRevision {
  let tickets: Ticket[] = [];
  try {
    const parsed = JSON.parse(row.tickets_snapshot) as unknown;
    if (Array.isArray(parsed)) tickets = parsed as Ticket[];
  } catch {
    tickets = [];
  }
  const sessionId = row.source_message_id
    ? (ctx.db.query<{ session_id: string }, [string]>(`SELECT session_id FROM messages WHERE id = ?`).get(row.source_message_id)?.session_id ?? null)
    : null;
  return {
    id: row.id,
    task_id: row.task_id,
    revision: row.revision,
    actor: row.actor,
    spec: parsePlanSpec(row.spec) ?? normalizePlanSpec({ goal: "…" })!,
    tickets_snapshot: tickets,
    source_message_id: row.source_message_id,
    source_turn_id: row.source_turn_id,
    session_id: sessionId,
    created_at: row.created_at,
  };
}

/** Newest first. */
export function listSpecRevisions(ctx: StoreContext, taskId: string, limit = 100): TaskSpecRevision[] {
  getTask(ctx, taskId);
  return ctx.db
    .query<SpecRevisionRow, [string, number]>(
      `SELECT * FROM task_spec_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT ?`,
    )
    .all(taskId, limit)
    .map((row) => toRevision(ctx, row));
}

export function recordSpecRevision(
  ctx: StoreContext,
  input: {
    taskId: string;
    spec: PlanSpec;
    sourceMessageId?: string | null;
    sourceTurnId?: string | null;
    actor: "app" | "user";
    now?: string;
  },
): SpecRevisionRow {
  const now = input.now ?? isoNow();
  const id = ulid();
  const revision = currentRevision(ctx, input.taskId) + 1;
  ctx.db.run(
    `INSERT INTO task_spec_revisions
       (id, task_id, revision, spec, tickets_snapshot, source_message_id, source_turn_id, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.taskId,
      revision,
      JSON.stringify(input.spec),
      JSON.stringify(listTickets(ctx, input.taskId)),
      input.sourceMessageId ?? null,
      input.sourceTurnId ?? null,
      input.actor,
      now,
    ],
  );
  return ctx.db.query<SpecRevisionRow, [string]>(`SELECT * FROM task_spec_revisions WHERE id = ?`).get(id)!;
}

function assertRevision(ctx: StoreContext, taskId: string, ifRevision: unknown): void {
  if (ifRevision === undefined || ifRevision === null) return;
  if (typeof ifRevision !== "number" || !Number.isInteger(ifRevision) || ifRevision < 0) {
    throw new HttpError(422, "invalid_args", "if_revision must be a non-negative integer");
  }
  if (ifRevision !== currentRevision(ctx, taskId)) {
    throw new HttpError(409, "revision_conflict", "the plan changed; reload before saving");
  }
}

/** Your edit of the spec: validated like the organizer's, recorded as yours. */
export function setPlanSpecByUser(
  ctx: StoreContext,
  taskId: string,
  raw: unknown,
  ifRevision?: unknown,
): { task: Task; revision: SpecRevisionRow } {
  const before = getTask(ctx, taskId);
  const spec = normalizePlanSpec(raw);
  if (!spec) throw new HttpError(422, "invalid_args", "spec needs a goal");
  const beforeAcceptance = parsePlanSpec(before.spec)?.acceptance ?? [];
  return ctx.db.transaction(() => {
    assertRevision(ctx, taskId, ifRevision);
    const now = isoNow();
    const task = setTaskSpec(ctx, taskId, spec, now);
    rebindCheckItems(ctx, taskId, beforeAcceptance, spec.acceptance, now);
    const revision = recordSpecRevision(ctx, { taskId, spec, actor: "user", now });
    return { task, revision };
  })();
}

/** Your edit of one ticket, recorded as a revision of its plan so the history shows it. */
export function patchTicketByUser(
  ctx: StoreContext,
  ticketId: string,
  patch: { title?: unknown; spec?: unknown; status?: unknown; worker?: string | null },
  ifRevision?: unknown,
): { ticket: Ticket; revision: SpecRevisionRow | null } {
  return ctx.db.transaction(() => {
    const before = ctx.db.query<Ticket, [string]>(`SELECT * FROM tickets WHERE id = ?`).get(ticketId);
    if (!before) throw new HttpError(404, "not_found", "ticket not found");
    assertRevision(ctx, before.task_id, ifRevision);
    const ticket = patchTicket(ctx, ticketId, patch);
    const changed =
      ticket.title !== before.title || ticket.spec !== before.spec || ticket.status !== before.status || ticket.worker !== before.worker;
    if (!changed) return { ticket, revision: null };
    const task = getTask(ctx, before.task_id);
    const spec = parsePlanSpec(task.spec);
    const revision = spec ? recordSpecRevision(ctx, { taskId: task.id, spec, actor: "user" }) : null;
    return { ticket, revision };
  })();
}

/**
 * What of a plan as it stands you typed on the board yourself: the goal if you set it last, the Done
 * when lines and rules your edits brought in, and the tickets whose description you wrote last. Read
 * from every revision, not the latest few,
 * since every drag of a ticket on the board is a revision of yours too. The organizer counts these
 * as your words, the same as a line you sent, so a rule you typed is never taken for one a Bot made
 * up.
 */
export function userWrittenSpec(
  ctx: StoreContext,
  taskId: string,
): { goal: boolean; acceptance: string[]; rules: string[]; ticketIds: string[] } {
  const none = { goal: false, acceptance: [], rules: [], ticketIds: [] };
  if (!ctx.db.query(`SELECT 1 FROM task_spec_revisions WHERE task_id = ? AND actor = 'user' LIMIT 1`).get(taskId)) return none;
  const rows = ctx.db
    .query<Pick<SpecRevisionRow, "spec" | "tickets_snapshot" | "actor">, [string]>(
      `SELECT spec, tickets_snapshot, actor FROM task_spec_revisions WHERE task_id = ? ORDER BY revision ASC`,
    )
    .all(taskId);
  const ruleBy = new Map<string, SpecRevisionRow["actor"]>();
  const acceptanceBy = new Map<string, SpecRevisionRow["actor"]>();
  const specBy = new Map<string, SpecRevisionRow["actor"]>();
  let goal = "";
  let goalBy: SpecRevisionRow["actor"] | null = null;
  let acceptance: string[] = [];
  let rules: string[] = [];
  let specs = new Map<string, string>();
  for (const row of rows) {
    const parsed = parsePlanSpec(row.spec);
    if ((parsed?.goal ?? "") !== goal) goalBy = row.actor;
    goal = parsed?.goal ?? "";
    const lines = parsed?.acceptance ?? [];
    for (const line of lines) if (!acceptance.includes(line)) acceptanceBy.set(line, row.actor);
    acceptance = lines;
    const next = parsed?.rules ?? [];
    for (const rule of next) if (!rules.includes(rule)) ruleBy.set(rule, row.actor);
    rules = next;
    const snapshot = new Map<string, string>();
    try {
      const parsed = JSON.parse(row.tickets_snapshot) as unknown;
      if (Array.isArray(parsed)) for (const ticket of parsed as Ticket[]) snapshot.set(ticket.id, ticket.spec ?? "");
    } catch {
      // a snapshot that does not parse says nothing about who wrote what
    }
    for (const [id, spec] of snapshot) if (spec.trim() && spec !== specs.get(id)) specBy.set(id, row.actor);
    specs = snapshot;
  }
  const now = parsePlanSpec(getTask(ctx, taskId).spec);
  return {
    goal: goalBy === "user" && !!now?.goal && now.goal === goal,
    acceptance: (now?.acceptance ?? []).filter((line) => acceptanceBy.get(line) === "user"),
    rules: (now?.rules ?? []).filter((rule) => ruleBy.get(rule) === "user"),
    // A description changed since the last revision is no longer the one you wrote.
    ticketIds: listTickets(ctx, taskId)
      .filter((ticket) => specBy.get(ticket.id) === "user" && ticket.spec === specs.get(ticket.id))
      .map((ticket) => ticket.id),
  };
}

export type OrganizerTicketInput = {
  /** An existing ticket's id, or `new-N` for one the organizer wants opened. */
  id: string;
  /** Always there on a `new-N`; absent on an existing ticket the organizer only moved. */
  title?: string;
  spec: string;
  /** Absent leaves an existing ticket's status as it was; a `new-N` without one is todo. */
  status?: TicketStatus;
  /**
   * A Bot id, resolved by the parser from the name the organizer wrote. Absent leaves an existing
   * ticket's worker as it was: the organizer never clears one, only you do.
   */
  worker?: string | null;
};

export type OrganizerResult = {
  decision: "continue" | "new" | "resume" | "join";
  resumePlanId: string | null;
  /** A plan the Bots here are on in another session, which the line is about (`elsewherePlans`). */
  joinPlanId?: string | null;
  spec: PlanSpec;
  tickets: OrganizerTicketInput[];
  /** Which ticket the message that prompted this run is about: an id, a `new-N`, or null. */
  messageTicket: string | null;
  /**
   * Acceptance checks this run proposes, edits or removes. Applied only when this run lands on the
   * current plan or opens a new one (a `resume` or `join` never touches another plan's checks).
   */
  checks?: OrganizerCheckInput[];
  /**
   * The answer's own picks, exactly as written, before candidate-set or format validation narrowed
   * them into `decision`/`resumePlanId`/`joinPlanId`/`messageTicket` above — kept only so
   * `organizer.ts` can put what the model actually asked for on the `organizer_runs` row. Never read
   * by `applyOrganizerResult`. A target is kept only beside the decision that uses it (a resume id
   * beside `resume`, a join id beside `join`, a message ticket on a message filing), so a stray id
   * beside some other decision never reads as a pick.
   */
  raw?: { decision: string; resumePlanId: string | null; joinPlanId: string | null; messageTicket: string | null };
  /**
   * Why `decision` is not the decision `raw` wrote: a resume/join with no target, or one that no
   * longer qualified once the candidate set was re-read after the call returned (the organizer then
   * files nothing, ADR 0040 P1), a decision word that is none of the four, or anything but continue
   * from a settle. Null when the written decision is the one that applies.
   */
  downgradeReason?: string | null;
};

/**
 * A plan the organizer reads as done while some of its tickets are still to do or in progress is
 * not done: the run's other changes land, the plan stays active, and whoever looks at the board
 * sees what is left instead of a finished plan over untouched tickets. Tickets awaiting review
 * count as handed over. You can still close such a plan yourself.
 */
export function ticketsHoldingPlanOpen(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === "todo" || ticket.status === "doing");
}

/** Tickets one organizer run may open. More than this is the organizer rewriting the plan, not filing it. */
export const ORGANIZER_NEW_TICKETS_MAX = 10;

const NEW_TICKET = /^new-\d+$/;

/** How a ticket's title is matched: a `new-N` whose title is an existing ticket's is that ticket. */
export function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A resume or join whose plan stopped being one this session can go to between the answer being
 * read and applied. The answer was written for that plan, so continuing the current one with it,
 * or opening a plan when there is none, would file a copy of the job (ADR 0040 P1): nothing lands.
 */
function targetGone(decision: "resume" | "join", planId: string): HttpError {
  return new HttpError(409, "conflict", `the plan this ${decision} names (${planId}) is no longer one this line can go to`);
}

/**
 * What one organizer run changes, in one transaction: the plan it lands on, the spec, the tickets
 * (existing ones by id, new ones opened, absent ones untouched), and the stamp on the message it
 * was about. Returns what the engine needs to open turns in the right place.
 */
export function applyOrganizerResult(
  ctx: StoreContext,
  input: {
    sessionId: string;
    /** The session's current plan when the run started; null when it had none. */
    current: Task | null;
    result: OrganizerResult;
    source: { messageId: string | null; turnId: string | null; messageBody: string };
    now?: Date;
    /**
     * The revision of `current` the run was built on. When the plan has moved since (a line or an
     * edit of yours landed while the call was out), nothing is applied: the answer would undo it.
     */
    ifRevision?: number;
  },
): {
  task: Task;
  tickets: Ticket[];
  messageTicketId: string | null;
  revision: SpecRevisionRow;
  created: number;
  /** Tickets that kept a plan the organizer called done open; empty when it was not called done or nothing was left. */
  heldOpenBy: Ticket[];
  /** Checks that kept a plan the organizer called done open: failed, or never run since their definition. */
  heldByChecks: AcceptanceCheck[];
  /** `heldByChecks` is not empty and every one of them is holding it open only for lack of a run yet — none has failed. */
  awaitingEvidence: boolean;
} {
  // On the store's clock, like the lines it files: that clock runs ahead of the wall clock when it
  // is busy, and a version stamped by the wall clock could read as older than the line that made it,
  // which a settle would then take for something you said since.
  const now = input.now ? input.now.toISOString() : isoNow();
  const at = new Date(now);
  return ctx.db.transaction(() => {
    if (input.current && input.ifRevision !== undefined) assertRevision(ctx, input.current.id, input.ifRevision);
    const result = input.result;
    let target: Task | null = null;
    if (result.decision === "resume" && result.resumePlanId) {
      const candidates = sessionRecentTasks(ctx, input.sessionId);
      if (!candidates.some((task) => task.id === result.resumePlanId)) throw targetGone("resume", result.resumePlanId);
      reopenTask(ctx, result.resumePlanId, input.sessionId);
      target = getTask(ctx, result.resumePlanId);
    }
    // A job going on elsewhere takes the line without becoming this session's plan: its own
    // session keeps it, and this session's current plan stays where it was.
    if (result.decision === "join" && result.joinPlanId) {
      const candidates = elsewherePlans(ctx, input.sessionId);
      if (!candidates.some((task) => task.id === result.joinPlanId)) throw targetGone("join", result.joinPlanId);
      reopenTask(ctx, result.joinPlanId, input.sessionId);
      target = getTask(ctx, result.joinPlanId);
    }
    if (!target && result.decision !== "new") target = input.current;
    if (!target) {
      const body = input.source.messageBody.trim();
      target = openTask(ctx, {
        sessionId: input.sessionId,
        title: result.spec.goal || body,
        brief: body || result.spec.goal,
        kind: result.spec.kind,
        spec: result.spec,
        now: at,
      });
    }
    // Checks and rebinding read the spec as it stood before this run touches it: `target` was
    // fetched fresh above (resume/join) or is `input.current` (continue), never yet written to.
    const beforeAcceptance = parsePlanSpec(target.spec)?.acceptance ?? [];
    // A resumed or joined plan is someone else's spec history to revise, not this run's own checks
    // to write: the organizer only touches checks on the plan it is continuing or opening.
    const appliesChecks = result.decision === "continue" || result.decision === "new";

    const existing = listTickets(ctx, target.id);
    const byId = new Map(existing.map((ticket) => [ticket.id, ticket]));
    const byTitle = new Map(existing.map((ticket) => [titleKey(ticket.title), ticket]));
    const placeholders = new Map<string, string>();
    let created = 0;
    for (const entry of result.tickets) {
      const known =
        byId.get(entry.id) ?? (NEW_TICKET.test(entry.id) && entry.title ? byTitle.get(titleKey(entry.title)) : undefined);
      if (known) {
        try {
          // What the organizer left out says nothing about the ticket: an empty spec does not
          // erase one, and a missing title, status or worker keeps what is there.
          const next = patchTicket(
            ctx,
            known.id,
            { title: entry.title, spec: entry.spec || undefined, status: entry.status, worker: entry.worker },
            { now: at },
          );
          byTitle.set(titleKey(next.title), next);
          if (NEW_TICKET.test(entry.id)) placeholders.set(entry.id, known.id);
        } catch {
          // an entry the store refuses is dropped; the rest of the run still applies
        }
        continue;
      }
      if (!NEW_TICKET.test(entry.id) || !entry.title) continue;
      if (created >= ORGANIZER_NEW_TICKETS_MAX || existing.length + created >= TICKETS_MAX) continue;
      try {
        const ticket = createTicket(ctx, {
          taskId: target.id,
          title: entry.title,
          spec: entry.spec,
          status: entry.status ?? "todo",
          worker: entry.worker ?? null,
          now: at,
        });
        created += 1;
        placeholders.set(entry.id, ticket.id);
        byId.set(ticket.id, ticket);
        byTitle.set(titleKey(ticket.title), ticket);
      } catch {
        // same: a bad title or a full plan drops the entry
      }
    }

    if (appliesChecks && result.checks?.length) {
      applyOrganizerChecks(ctx, { task: target, entries: result.checks, placeholders, now: at });
    }
    // A line dropped from the plan should not silently take its check with it: a check whose item
    // was one of the old acceptance lines follows a rewording to the same position.
    rebindCheckItems(ctx, target.id, beforeAcceptance, result.spec.acceptance, now);

    const heldOpenBy = result.spec.status === "done" ? ticketsHoldingPlanOpen(listTickets(ctx, target.id)) : [];
    const heldByChecks = result.spec.status === "done" ? checksHoldingPlanOpen(ctx, target.id) : [];
    const spec: PlanSpec = heldOpenBy.length > 0 || heldByChecks.length > 0 ? { ...result.spec, status: "active" } : result.spec;
    const task = setTaskSpec(ctx, target.id, spec, now);
    const revision = recordSpecRevision(ctx, {
      taskId: task.id,
      spec,
      sourceMessageId: input.source.messageId,
      sourceTurnId: input.source.turnId,
      actor: "app",
      now,
    });

    let messageTicketId: string | null = null;
    if (result.messageTicket) {
      const resolved = placeholders.get(result.messageTicket) ?? result.messageTicket;
      if (ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM tickets WHERE id = ? AND task_id = ?`).get(resolved, task.id)) {
        messageTicketId = resolved;
      }
    }
    if (input.source.messageId) {
      ctx.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [task.id, messageTicketId, input.source.messageId]);
    }
    const awaitingEvidence = heldByChecks.length > 0 && heldByChecks.every((check) => checkNeverRanSinceDefinition(check));
    return { task, tickets: listTickets(ctx, task.id), messageTicketId, revision, created, heldOpenBy, heldByChecks, awaitingEvidence };
  })();
}

/** One plan as the board and the plan event read it: the switcher row plus spec, revision and tickets. */
export function taskDetail(ctx: StoreContext, taskId: string, present: (path: string) => boolean): TaskDetail {
  const task = getTask(ctx, taskId);
  const summary = taskSummary(ctx, task, taskLastActivityAt(ctx, taskId));
  const latest = ctx.db
    .query<{ revision: number; actor: "app" | "user" }, [string]>(
      `SELECT revision, actor FROM task_spec_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(taskId);
  return {
    ...summary,
    brief: task.brief,
    spec: parsePlanSpec(task.spec),
    spec_updated_at: task.spec_updated_at,
    revision: latest?.revision ?? 0,
    revision_actor: latest?.actor ?? null,
    routine_id: task.routine_id,
    checks: listChecks(ctx, taskId),
    tickets: listTickets(ctx, taskId).map((ticket) => ({
      ...ticket,
      artifacts: ticketArtifacts(ctx, ticket.id, present).map((row) => ({
        path: row.path,
        message_id: row.message_id,
        attachment_id: row.attachment_id,
        exists: true,
      })),
    })),
  };
}

export function isTicketStatusValue(value: unknown): value is TicketStatus {
  return isTicketStatus(value);
}

/**
 * Whether a ticket of the plan went to review or done after `since`: a version recorded after then
 * shows it there while the version before did not, or the board now does while the last version
 * did not (the app's own move to review leaves no version). Only a ticket changed after `since`
 * can have moved after it. The plan watch's sign that a call-back moved something: rewording a
 * ticket that sits in review is no move, and a ticket sent back and handed over again is. Reads
 * only each version's ticket ids, statuses and times, not the specs they carry.
 */
export function ticketHandedOverSince(ctx: StoreContext, taskId: string, since: string): boolean {
  const rows = ctx.db
    .query<
      { revision: number; created_at: string; id: string | null; status: string | null; updated_at: string | null },
      [string, string, string]
    >(
      `SELECT r.revision, r.created_at,
              json_extract(j.value, '$.id') AS id,
              json_extract(j.value, '$.status') AS status,
              json_extract(j.value, '$.updated_at') AS updated_at
       FROM task_spec_revisions r LEFT JOIN json_each(r.tickets_snapshot) AS j
       WHERE r.task_id = ? AND r.revision >= COALESCE(
         (SELECT MAX(revision) FROM task_spec_revisions WHERE task_id = ? AND created_at <= ?), 0)
       ORDER BY r.revision ASC, j.key ASC`,
    )
    .all(taskId, taskId, since);
  type Seen = { status: string; updated_at: string | null };
  const versions = new Map<number, { at: string; board: Map<string, Seen> }>();
  for (const row of rows) {
    const version = versions.get(row.revision) ?? { at: row.created_at, board: new Map<string, Seen>() };
    versions.set(row.revision, version);
    if (row.id !== null && row.status !== null) version.board.set(row.id, { status: row.status, updated_at: row.updated_at });
  }
  const movedFrom = (before: ReadonlyMap<string, Seen>, board: ReadonlyMap<string, Seen>): boolean =>
    [...board].some(
      ([id, ticket]) =>
        (ticket.status === "review" || ticket.status === "done") &&
        (ticket.updated_at === null || ticket.updated_at > since) &&
        before.get(id)?.status !== ticket.status,
    );
  let before = new Map<string, Seen>();
  for (const { at, board } of versions.values()) {
    if (at > since && movedFrom(before, board)) return true;
    before = board;
  }
  const now = new Map(listTickets(ctx, taskId).map((ticket) => [ticket.id, { status: ticket.status, updated_at: ticket.updated_at }]));
  return movedFrom(before, now);
}
