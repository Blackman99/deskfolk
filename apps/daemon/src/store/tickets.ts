/**
 * A ticket (任务): the smallest unit of a plan that hands something over. It has a number, a title,
 * a spec, a status, who is on it (as observed, not assigned) and a folder inside the plan's dir.
 * Only the organizer and the user change tickets; Bots see them in the situation block and work
 * in the ticket dir their turn was filed under.
 */
import type { Ticket, TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { type StoreContext } from "./shared";
import { getTask, isReservedTaskPath, slugify, taskTitle } from "./tasks";

export type { Ticket, TicketStatus } from "@real-bot/protocol";

export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "doing", "review", "done", "parked"];
export const TICKET_TITLE_MAX = 80;
export const TICKET_SPEC_MAX = 2000;
/** Tickets one plan may hold; a plan past this is two plans. */
export const TICKETS_MAX = 40;
const TICKET_SLUG_MAX = 24;

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

/** `work/写周报-7f3k/01-初稿`. The number keeps the folder list in the order the work happened. */
export function ticketDirName(planDir: string, seq: number, title: string): string {
  const number = String(seq).padStart(2, "0");
  const slug = slugify(taskTitle(title), TICKET_SLUG_MAX);
  return slug ? `${planDir}/${number}-${slug}` : `${planDir}/${number}`;
}

export function nextTicketSeq(ctx: StoreContext, taskId: string): number {
  const row = ctx.db
    .query<{ n: number | null }, [string]>(`SELECT MAX(seq) AS n FROM tickets WHERE task_id = ?`)
    .get(taskId);
  return (row?.n ?? 0) + 1;
}

function cleanTitle(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new HttpError(422, "invalid_args", "ticket title is required");
  return takeCodePoints(text, TICKET_TITLE_MAX).text;
}

function cleanSpec(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "ticket spec must be a string");
  return takeCodePoints(value.trim(), TICKET_SPEC_MAX).text;
}

function cleanStatus(value: unknown, fallback: TicketStatus): TicketStatus {
  if (value === undefined) return fallback;
  if (!isTicketStatus(value)) throw new HttpError(422, "invalid_args", "ticket status is not one of todo, doing, review, done, parked");
  return value;
}

export function createTicket(
  ctx: StoreContext,
  input: { taskId: string; title: unknown; spec?: unknown; status?: unknown; worker?: string | null; now?: Date },
): Ticket {
  const task = getTask(ctx, input.taskId);
  const title = cleanTitle(input.title);
  const spec = cleanSpec(input.spec);
  const status = cleanStatus(input.status, "todo");
  const at = input.now ?? new Date();
  const now = at.toISOString();
  const id = ulid(at.getTime());
  const seq = nextTicketSeq(ctx, task.id);
  if (seq > TICKETS_MAX) throw new HttpError(422, "invalid_args", `a plan holds at most ${TICKETS_MAX} tickets`);
  const dir = ticketDirName(task.dir, seq, title);
  const closedAt = status === "done" || status === "parked" ? now : null;
  ctx.db.run(
    `INSERT INTO tickets (id, task_id, seq, title, slug, dir, spec, status, worker, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, task.id, seq, title, dir.slice(dir.lastIndexOf("/") + 1), dir, spec, status, input.worker ?? null, now, now, closedAt],
  );
  return getTicket(ctx, id);
}

export function getTicket(ctx: StoreContext, id: string): Ticket {
  const row = ctx.db.query<Ticket, [string]>(`SELECT * FROM tickets WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "ticket not found");
  return row;
}

export function listTickets(ctx: StoreContext, taskId: string): Ticket[] {
  return ctx.db
    .query<Ticket, [string]>(`SELECT * FROM tickets WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId);
}

/**
 * Changes only the fields given. A ticket going to done or parked is closed; one coming back is
 * reopened. `updated_at` moves only when something actually changed, so a run that repeats what
 * is already there raises no event.
 */
export function patchTicket(
  ctx: StoreContext,
  id: string,
  patch: { title?: unknown; spec?: unknown; status?: unknown; worker?: string | null },
  opts: { now?: Date } = {},
): Ticket {
  const current = getTicket(ctx, id);
  const next = {
    title: patch.title !== undefined ? cleanTitle(patch.title) : current.title,
    spec: patch.spec !== undefined ? cleanSpec(patch.spec) : current.spec,
    status: cleanStatus(patch.status, current.status),
    worker: patch.worker !== undefined ? patch.worker : current.worker,
  };
  const changed =
    next.title !== current.title || next.spec !== current.spec || next.status !== current.status || next.worker !== current.worker;
  if (!changed) return current;
  const now = (opts.now ?? new Date()).toISOString();
  const closing = next.status === "done" || next.status === "parked";
  ctx.db.run(
    `UPDATE tickets SET title = ?, spec = ?, status = ?, worker = ?, updated_at = ?,
       closed_at = CASE WHEN ? THEN COALESCE(closed_at, ?) ELSE NULL END
     WHERE id = ?`,
    [next.title, next.spec, next.status, next.worker, now, closing ? 1 : 0, now, id],
  );
  return getTicket(ctx, id);
}

export function ticketOfTurn(ctx: StoreContext, turnId: string): string | null {
  const row = ctx.db
    .query<{ ticket_id: string | null }, [string]>(`SELECT ticket_id FROM turns WHERE id = ?`)
    .get(turnId);
  return row?.ticket_id ?? null;
}

export type TicketArtifact = { path: string; message_id: string; attachment_id: string; last_cited_at: string };

/** Files this ticket's messages cited and that are still there, newest citation first. */
export function ticketArtifacts(
  ctx: StoreContext,
  ticketId: string,
  present: (path: string) => boolean,
  limit = 100,
): TicketArtifact[] {
  const ticket = getTicket(ctx, ticketId);
  const task = getTask(ctx, ticket.task_id);
  const rows = ctx.db
    .query<TicketArtifact, [string]>(
      `SELECT a.workspace_relpath AS path, a.message_id, a.id AS attachment_id, m.created_at AS last_cited_at
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.ticket_id = ?
       ORDER BY m.created_at DESC, a.id DESC`,
    )
    .all(ticketId);
  const out: TicketArtifact[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    if (isReservedTaskPath(task.dir, row.path)) continue;
    if (present(row.path)) out.push(row);
  }
  return out;
}

export function listTicketDirs(ctx: StoreContext, taskId: string): string[] {
  return ctx.db
    .query<{ dir: string }, [string]>(`SELECT dir FROM tickets WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId)
    .map((row) => row.dir);
}
