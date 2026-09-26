/**
 * A plan's spec over time, and the two ways it changes: the organizer's run and the user's edit.
 * Every change is a revision that names its cause — the message or turn that prompted it, or the
 * user — so the board can show how the goal moved. The organizer's ticket list is applied here
 * too, in one transaction with the spec, so a plan is never half-updated.
 */
import type { TaskDetail, TaskSpecRevision, Ticket, TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { normalizePlanSpec, parsePlanSpec, type PlanSpec } from "./plan-shape";
import { type StoreContext } from "./shared";
import {
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
  getTask(ctx, taskId);
  const spec = normalizePlanSpec(raw);
  if (!spec) throw new HttpError(422, "invalid_args", "spec needs a goal");
  return ctx.db.transaction(() => {
    assertRevision(ctx, taskId, ifRevision);
    const now = isoNow();
    const task = setTaskSpec(ctx, taskId, spec, now);
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

export type OrganizerTicketInput = {
  /** An existing ticket's id, or `new-N` for one the organizer wants opened. */
  id: string;
  title: string;
  spec: string;
  status: TicketStatus;
  /** A Bot id, resolved by the parser from the name the organizer wrote. */
  worker: string | null;
};

export type OrganizerResult = {
  decision: "continue" | "new" | "resume";
  resumePlanId: string | null;
  spec: PlanSpec;
  tickets: OrganizerTicketInput[];
  /** Which ticket the message that prompted this run is about: an id, a `new-N`, or null. */
  messageTicket: string | null;
};

/** Tickets one organizer run may open. More than this is the organizer rewriting the plan, not filing it. */
export const ORGANIZER_NEW_TICKETS_MAX = 10;

const NEW_TICKET = /^new-\d+$/;

function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
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
  },
): { task: Task; tickets: Ticket[]; messageTicketId: string | null; revision: SpecRevisionRow; created: number } {
  const at = input.now ?? new Date();
  const now = at.toISOString();
  return ctx.db.transaction(() => {
    const result = input.result;
    let target: Task | null = null;
    if (result.decision === "resume" && result.resumePlanId) {
      const candidates = sessionRecentTasks(ctx, input.sessionId);
      if (candidates.some((task) => task.id === result.resumePlanId)) {
        reopenTask(ctx, result.resumePlanId, input.sessionId);
        target = getTask(ctx, result.resumePlanId);
      }
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

    const existing = listTickets(ctx, target.id);
    const byId = new Map(existing.map((ticket) => [ticket.id, ticket]));
    const byTitle = new Map(existing.map((ticket) => [titleKey(ticket.title), ticket]));
    const placeholders = new Map<string, string>();
    let created = 0;
    for (const entry of result.tickets) {
      const known = byId.get(entry.id) ?? (NEW_TICKET.test(entry.id) ? byTitle.get(titleKey(entry.title)) : undefined);
      if (known) {
        try {
          // An empty spec from the organizer says nothing about the ticket; it does not erase one.
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
      if (!NEW_TICKET.test(entry.id)) continue;
      if (created >= ORGANIZER_NEW_TICKETS_MAX || existing.length + created >= TICKETS_MAX) continue;
      try {
        const ticket = createTicket(ctx, { taskId: target.id, title: entry.title, spec: entry.spec, status: entry.status, worker: entry.worker, now: at });
        created += 1;
        placeholders.set(entry.id, ticket.id);
        byId.set(ticket.id, ticket);
        byTitle.set(titleKey(ticket.title), ticket);
      } catch {
        // same: a bad title or a full plan drops the entry
      }
    }

    const task = setTaskSpec(ctx, target.id, result.spec, now);
    const revision = recordSpecRevision(ctx, {
      taskId: task.id,
      spec: result.spec,
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
    return { task, tickets: listTickets(ctx, task.id), messageTicketId, revision, created };
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
