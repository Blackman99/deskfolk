/**
 * A ticket (任务): the smallest unit of a plan that hands something over. It has a number, a title,
 * a spec, a status, who is on it (filled from the plan's division of work when the organizer opens
 * it, then from who is seen doing it — a record, not an assignment) and a folder inside the plan's
 * dir. The organizer and the user change tickets; the app also moves one forward on what it sees
 * a turn filed under it do ({@link observeTicketWork}). Bots see them in the situation block and
 * work in the ticket dir their turn was filed under.
 */
import { isBotRunner, isTicketAgentModel, type Ticket, type TicketModel, type TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { recordWorkEvent } from "./work-events";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { takeCodePoints } from "../text";
import { type StoreContext } from "./shared";
import { getTask, isReservedTaskPath, slugify, taskTitle } from "./tasks";
import { providerListsModel, rungOf } from "./model-ladder";

export type { Ticket, TicketStatus } from "@real-bot/protocol";

export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "doing", "review", "done", "parked"];
export const TICKET_TITLE_MAX = 80;
export const TICKET_SPEC_MAX = 2000;
/** Tickets one plan may hold; a plan past this is two plans. */
export const TICKETS_MAX = 40;
const TICKET_SLUG_MAX = 24;

/** How many other tickets one may wait for; a plan holds {@link TICKETS_MAX} at most. */
export const TICKET_DEPENDS_MAX = TICKETS_MAX - 1;

/** A `tickets` row as stored: `depends_on` and `model_override` are JSON text, `sample` 0 or 1. */
export type TicketRow = Omit<Ticket, "depends_on" | "model_override" | "sample"> & { depends_on: string; model_override?: string | null; sample?: number | null };

/** A stored row as the API gives it: `depends_on` a list (a row an older build wrote reads as none), `model_override` an object or null. */
export function toTicket(row: TicketRow): Ticket {
  return { ...row, depends_on: ticketDependencies(row.depends_on), model_override: ticketModel(row.model_override), sample: row.sample === 1 };
}

/** A stored override, or null for none or one that does not read: an endpoint's model, or a local agent's (ADR 0079). */
export function ticketModel(raw: string | null | undefined): TicketModel | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.model !== "string") return null;
    if ("runner" in parsed) {
      if (!isBotRunner(parsed.runner)) return null;
      const customId = typeof parsed.custom_id === "string" ? parsed.custom_id : null;
      return { runner: parsed.runner, model: parsed.model, effort: typeof parsed.effort === "string" ? parsed.effort : null,
        config_dir: typeof parsed.config_dir === "string" ? parsed.config_dir : null, ...(customId ? { custom_id: customId } : {}) };
    }
    return typeof parsed.provider_id === "string" ? { provider_id: parsed.provider_id, model: parsed.model } : null;
  } catch {
    return null;
  }
}

/**
 * Your override as given: null, a model an endpoint lists, or a local agent's model on an account
 * listed in Settings, checked as a ladder rung is (ADR 0079) — only from level 7, where turns read it.
 */
function cleanModelOverride(ctx: StoreContext, value: unknown): TicketModel | null {
  if (value === null) return null;
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.routing) throw new HttpError(409, "conflict", "a ticket's model needs engine level 7");
  const raw = value as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object" && "runner" in raw) {
    const rung = rungOf(ctx, { ...raw, effort: raw.effort ?? null, config_dir: raw.config_dir ?? null });
    if (isTicketAgentModel(rung)) return rung;
  }
  if (!raw || typeof raw !== "object" || typeof raw.provider_id !== "string" || typeof raw.model !== "string") {
    throw new HttpError(422, "invalid_args", "model_override must be {provider_id, model}, {runner, model, effort, config_dir} or null");
  }
  if (!providerListsModel(ctx, raw.provider_id, raw.model)) throw new HttpError(422, "invalid_args", "model_override names no model an endpoint lists");
  return { provider_id: raw.provider_id, model: raw.model };
}

/** The ids in a stored `depends_on`; text that is not a list of strings reads as none. */
export function ticketDependencies(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

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
  // The owner is written alongside the worker (ADR 0045): whoever is on it is who is called back to it.
  ctx.db.run(
    `INSERT INTO tickets (id, task_id, seq, title, slug, dir, spec, status, worker, owner_bot_id, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, task.id, seq, title, dir.slice(dir.lastIndexOf("/") + 1), dir, spec, status, input.worker ?? null, input.worker ?? null, now, now, closedAt],
  );
  if (status !== "todo") {
    recordWorkEvent(ctx, { kind: "ticket.stage_changed", actor: "app", taskId: task.id, ticketId: id,
      payload: { before: null, after: status, source: "created" } });
  }
  return getTicket(ctx, id);
}

export function getTicket(ctx: StoreContext, id: string): Ticket {
  const row = ctx.db.query<TicketRow, [string]>(`SELECT * FROM tickets WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "ticket not found");
  return toTicket(row);
}

export function listTickets(ctx: StoreContext, taskId: string): Ticket[] {
  return ctx.db
    .query<TicketRow, [string]>(`SELECT * FROM tickets WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId)
    .map(toTicket);
}

/** A ticket's parts by key, as the lead (or you) declared them, each with its stage. */
export function listTicketParts(ctx: StoreContext, ticketId: string): Array<{ key: string; title: string; stage: string }> {
  return ctx.db
    .query<{ key: string; title: string; stage: string }, [string]>(`SELECT key, title, stage FROM ticket_parts WHERE ticket_id = ? ORDER BY key`)
    .all(ticketId);
}

/**
 * A ticket's dependencies as you set them (ADR 0045): other tickets of its plan, each once, none of
 * them itself, and no loop back to it through theirs.
 */
function cleanDependencies(ctx: StoreContext, ticket: Pick<Ticket, "id" | "task_id">, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new HttpError(422, "invalid_args", "depends_on must be a list of ticket ids");
  }
  const ids = [...new Set(value as string[])];
  if (ids.length > TICKET_DEPENDS_MAX) throw new HttpError(422, "invalid_args", `a ticket waits for at most ${TICKET_DEPENDS_MAX} others`);
  if (ids.includes(ticket.id)) throw new HttpError(422, "invalid_args", "a ticket cannot wait for itself");
  const plan = new Map(ctx.db.query<{ id: string; depends_on: string }, [string]>("SELECT id, depends_on FROM tickets WHERE task_id = ?")
    .all(ticket.task_id).map((row) => [row.id, ticketDependencies(row.depends_on)] as const));
  for (const id of ids) if (!plan.has(id)) throw new HttpError(422, "invalid_args", "depends_on names only tickets of the same plan");
  // A parked ticket is never done: waiting for one would never end. One that was set before it was parked may stay.
  const before = new Set(ticketDependencies(ctx.db.query<{ depends_on: string }, [string]>("SELECT depends_on FROM tickets WHERE id = ?").get(ticket.id)?.depends_on));
  for (const id of ids) {
    if (!before.has(id) && ctx.db.query("SELECT 1 FROM tickets WHERE id = ? AND status = 'parked'").get(id)) {
      throw new HttpError(422, "invalid_args", "a ticket cannot wait for a parked one");
    }
  }
  // Walks what the named tickets wait for, transitively: reaching this one would be a loop.
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === ticket.id) throw new HttpError(422, "invalid_args", "depends_on would make the tickets wait for each other");
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(plan.get(id) ?? []));
  }
  return ids;
}

/** A ticket's reviewer as you set it (ADR 0046): a Bot that exists, is not archived and is not the ticket's owner, or null for none. */
function cleanReviewer(ctx: StoreContext, value: unknown, owner: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "invalid_args", "reviewer_bot_id must be a Bot id or null");
  if (!ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL").get(value)) {
    throw new HttpError(422, "invalid_args", "reviewer_bot_id names no Bot");
  }
  if (value === owner) throw new HttpError(422, "invalid_args", "a ticket's reviewer cannot be its owner");
  return value;
}

/**
 * Changes only the fields given. A ticket going to done or parked is closed; one coming back is
 * reopened. `updated_at` moves only when something actually changed, so a run that repeats what
 * is already there raises no event.
 */
export function patchTicket(
  ctx: StoreContext,
  id: string,
  patch: { title?: unknown; spec?: unknown; status?: unknown; worker?: string | null; dependsOn?: unknown; reviewerBotId?: unknown; modelOverride?: unknown },
  opts: {
    now?: Date;
    /**
     * Who moved its stage, for the work log's `ticket.stage_changed` (the supervisor's progress,
     * ADR 0045): the board, the organizer, or a turn seen working on it.
     */
    stage?: { source: "user" | "organizer" | "observed_work"; botId?: string | null; turnId?: string | null; workItemId?: string | null };
  } = {},
): Ticket {
  const current = getTicket(ctx, id);
  const next = {
    title: patch.title !== undefined ? cleanTitle(patch.title) : current.title,
    spec: patch.spec !== undefined ? cleanSpec(patch.spec) : current.spec,
    status: cleanStatus(patch.status, current.status),
    worker: patch.worker !== undefined ? patch.worker : current.worker,
    dependsOn: patch.dependsOn !== undefined ? cleanDependencies(ctx, current, patch.dependsOn) : (current.depends_on ?? []),
    // Against the owner it will have: a call that hands the ticket to its reviewer is refused too.
    reviewer: patch.reviewerBotId !== undefined
      ? cleanReviewer(ctx, patch.reviewerBotId, patch.worker !== undefined ? patch.worker : (current.owner_bot_id ?? current.worker))
      : (current.reviewer_bot_id ?? null),
    modelOverride: patch.modelOverride !== undefined ? cleanModelOverride(ctx, patch.modelOverride) : (current.model_override ?? null),
  };
  // Whichever side moves, a ticket's owner is never its reviewer: that would cancel the review unnoticed.
  if (patch.worker !== undefined && next.worker && next.worker === next.reviewer) {
    throw new HttpError(422, "invalid_args", "a ticket's reviewer cannot be its owner");
  }
  const dependsChanged = JSON.stringify(next.dependsOn) !== JSON.stringify(current.depends_on ?? []);
  const changed =
    next.title !== current.title || next.spec !== current.spec || next.status !== current.status || next.worker !== current.worker || dependsChanged
    || next.reviewer !== (current.reviewer_bot_id ?? null)
    || JSON.stringify(next.modelOverride) !== JSON.stringify(current.model_override ?? null);
  if (!changed) return current;
  const now = (opts.now ?? new Date()).toISOString();
  const closing = next.status === "done" || next.status === "parked";
  ctx.db.run(
    `UPDATE tickets SET title = ?, spec = ?, status = ?, worker = ?, depends_on = ?, reviewer_bot_id = ?, model_override = ?, updated_at = ?,
       owner_bot_id = CASE WHEN ? THEN ? ELSE owner_bot_id END,
       closed_at = CASE WHEN ? THEN COALESCE(closed_at, ?) ELSE NULL END
     WHERE id = ?`,
    [next.title, next.spec, next.status, next.worker, JSON.stringify(next.dependsOn), next.reviewer, next.modelOverride ? JSON.stringify(next.modelOverride) : null, now,
      next.worker !== current.worker ? 1 : 0, next.worker, closing ? 1 : 0, now, id],
  );
  if (next.status !== current.status) {
    recordWorkEvent(ctx, { kind: "ticket.stage_changed", actor: opts.stage?.source === "user" ? "user" : "app",
      botId: opts.stage?.botId ?? null, taskId: current.task_id, ticketId: id, turnId: opts.stage?.turnId ?? null,
      payload: { work_item_id: opts.stage?.workItemId ?? null, before: current.status, after: next.status, source: opts.stage?.source ?? "organizer" } });
  }
  return getTicket(ctx, id);
}

/**
 * What the app sees a Bot do on a ticket, without asking a model. A turn filed under it starting
 * real work (writing, running) moves it from todo to doing; a turn handing files over moves it to
 * review. Only forward, never to done or parked — that stays the organizer's and yours — and the
 * worker is filled only when nobody is on it. Between the organizer's runs, which wait for a plan
 * to go quiet, this is what keeps the board saying who is doing what. Returns the ticket when it
 * changed, else null.
 */
export function observeTicketWork(
  ctx: StoreContext,
  input: { ticketId: string; botId: string; turnId?: string; seen: "working" | "delivered"; now?: Date },
): Ticket | null {
  const row = ctx.db.query<TicketRow, [string]>(`SELECT * FROM tickets WHERE id = ?`).get(input.ticketId);
  if (!row) return null;
  // From engine level 5 a hand-over is a submission, whose checks move the ticket (ADR 0046): a
  // turn handing files over no longer moves it to review here.
  const handsOver = readEngineLevel(ctx.db) < ENGINE_LEVELS.submissions;
  const moves: Partial<Record<TicketStatus, TicketStatus>> =
    input.seen === "working" ? { todo: "doing" } : handsOver ? { todo: "review", doing: "review" } : {};
  const status = moves[row.status];
  const worker = row.worker ?? input.botId;
  if (!status && worker === row.worker) return null;
  return ctx.commit(() => {
    // The move is the turn's own only when that turn is on exactly this ticket; else it is still a move.
    const turn = input.turnId ? ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null }, [string]>(
      "SELECT bot_id, task_id, ticket_id, work_item_id FROM turns WHERE id = ?").get(input.turnId) : null;
    const own = turn?.bot_id === input.botId && turn.task_id === row.task_id && turn.ticket_id === row.id;
    return patchTicket(ctx, row.id, { status: status ?? row.status, worker }, { now: input.now,
      stage: { source: "observed_work", botId: input.botId, turnId: own ? input.turnId ?? null : null, workItemId: own ? turn!.work_item_id : null } });
  });
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
