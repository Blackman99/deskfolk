/**
 * `plan_items` (ADR 0053, engine level 5): the plan's lead lays out its tickets in one call — each
 * with who makes it, who reviews it, what it waits for and the parts it has. A ticket already in the
 * plan under the same title is that ticket, never opened twice (rework is the same ticket), and only
 * filled in: an owner or reviewer already set stays (yours on the board, or anyone's), dependencies
 * and parts are only added, and a ticket that is closed or approved is not touched. The whole call
 * stands or falls together. Only a lead that does not shift with who ran most is let in: the stored
 * one, the group lead you confirmed, or the one Bot of a direct.
 */
import type { Ticket } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { filenamePartNumbers } from "./part-numbers";
import { allJobConversations, confirmedLeadsOf, eligibleInJob, jobConversations } from "./job-conversations";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { StoreContext } from "./shared";
import { createTicket, getTicket, listTickets, patchTicket } from "./tickets";
import { setTicketStage } from "./submissions";
import { recordWorkEvent } from "./work-events";
import { closeWorkItemIfIdle, findOrCreateWorkItem } from "./work-items";

/** At most this many items in one call; a plan holds at most `TICKETS_MAX` tickets anyway. */
export const PLAN_ITEMS_MAX = 20;
/** At most this many parts declared on one ticket. */
const PARTS_MAX = 60;

export type PlanItemsResult = {
  tickets: Array<{
    ticket_id: string; seq: number; title: string; owner: string | null; reviewer: string | null; depends_on: string[]; parts: string[]; created: boolean;
    /** What was asked but left as it was: an owner or reviewer already set. */
    kept?: Array<"owner" | "reviewer">;
  }>;
  /** The ticket the job opened with, dropped because the layout left it out and nothing was done on it. */
  folded?: string;
};

type Item = { title: string; owner: string | null; reviewer: string | null; dependsOn: string[]; parts: Array<{ key: string; title: string }> };

/**
 * The lead plan_items listens to: the plan's stored lead, else a group lead you confirmed in one of
 * the job's conversations (its home's first, then where you spoke about it last: a job opened in a
 * direct and taken up in a group is led by the lead you confirmed there), else the one Bot of its
 * home direct — each while it can still work in one of those conversations. Never the Bot that
 * happened to run most, which would move under you (`planLead` keeps that for whom the supervisor
 * calls back).
 */
function stableLead(ctx: StoreContext, taskId: string): string | null {
  const plan = ctx.db.query<{ session_id: string | null; lead_bot_id: string | null }, [string]>("SELECT session_id, lead_bot_id FROM tasks WHERE id = ?").get(taskId);
  if (!plan?.session_id) return null;
  const conversations = jobConversations(ctx, taskId);
  const eligible = (botId: string | null | undefined) => eligibleInJob(ctx, botId, taskId, conversations);
  const confirmed = confirmedLeadsOf(ctx, conversations).map(eligible).find(Boolean) ?? null;
  const kind = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(plan.session_id)?.kind;
  const directBots = kind === "direct" ? ctx.db.query<{ member: string }, [string]>(`SELECT p.member FROM session_participants p JOIN bots b ON b.id = p.member
    WHERE p.session_id = ? AND p.left_at IS NULL`).all(plan.session_id) : [];
  return eligible(plan.lead_bot_id) ?? confirmed ?? (directBots.length === 1 ? eligible(directBots[0]!.member) : null);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "invalid_args", `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(422, "invalid_args", `${field} is at most ${max} characters`);
  return trimmed;
}

function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new HttpError(422, "invalid_args", `${field} must be a list of strings`);
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

/** A part as the file names number it (`shot_07`, 「Shot 07」), or as given when it has no number. */
function partKey(raw: string): { key: string; title: string } {
  const plain = /^\d{1,3}$/.test(raw) ? Number(raw) : (filenamePartNumbers(raw)[0] ?? null);
  if (plain !== null && plain >= 1) {
    const n = String(plain).padStart(2, "0");
    return { key: `shot_${n}`, title: `Shot ${n}` };
  }
  const key = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!key) throw new HttpError(422, "invalid_args", `part "${raw}" has nothing to key it by`);
  return { key, title: raw.slice(0, 60) };
}

/** The Bots this plan's tickets can go to: in its conversation, not archived or deleted; by id or exact name. */
/** The Bots of the job's conversations (its home, and where you spoke about it), by id or name. */
function memberResolver(ctx: StoreContext, taskId: string): (ref: string, field: string) => string {
  const sessions = allJobConversations(jobConversations(ctx, taskId));
  const members = ctx.db.query<{ id: string; name: string }, [string]>(`SELECT DISTINCT b.id, b.name FROM bots b
    JOIN session_participants sp ON sp.member = b.id AND sp.left_at IS NULL AND sp.session_id IN (SELECT value FROM json_each(?))
    WHERE b.archived_at IS NULL AND b.deleted_at IS NULL`).all(JSON.stringify(sessions));
  return (ref, field) => {
    const found = members.find((bot) => bot.id === ref) ?? members.find((bot) => bot.name === ref);
    if (!found) throw new HttpError(422, "invalid_args", `${field} "${ref}" is not a Bot in this plan's conversations`);
    return found.id;
  };
}

/**
 * The ticket a job opened with — named as the job, made when a desk's first effect opened it (or you
 * made a job of a line) — folded into the lead's layout when the layout leaves it out and nothing
 * was ever done on it: no hand-over, no file, no command, no open request. Left standing, it was a
 * third ticket nobody would hand in, owned by the lead, that the supervisor chased and that kept the
 * job from being delivered (2026-10-03). It is dropped, and a segment on it goes on the whole job.
 */
function foldOpeningTicket(ctx: StoreContext, input: { taskId: string; turnId: string; laidOut: readonly string[]; now: string }): string | null {
  const opened = ctx.db.query<{ ticket_id: string | null }, [string]>(`SELECT ticket_id FROM work_events WHERE task_id = ? AND kind = 'plan.opened'
    ORDER BY seq LIMIT 1`).get(input.taskId)?.ticket_id ?? null;
  if (!opened || input.laidOut.includes(opened)) return null;
  const ticket = getTicket(ctx, opened);
  const title = ctx.db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(input.taskId)?.title ?? "";
  if (ticket.title.trim() !== title.trim() || (ticket.status !== "todo" && ticket.status !== "doing")) return null;
  const touched = ctx.db.query(`SELECT 1 FROM submissions WHERE ticket_id = ?1
    UNION ALL SELECT 1 FROM messages m JOIN attachments a ON a.message_id = m.id WHERE m.ticket_id = ?1 AND m.kind = 'bot'
    UNION ALL SELECT 1 FROM turn_runs r JOIN turns t ON t.id = r.turn_id WHERE t.ticket_id = ?1
    UNION ALL SELECT 1 FROM delegations WHERE ticket_id = ?1 AND status = 'open' LIMIT 1`).get(opened);
  if (touched) return null;
  // Dropped, not parked: it reads 「作废」 on the board, not as work set aside that someone is on.
  setTicketStage(ctx, { ticketId: opened, stage: "dropped", source: "supervisor", now: input.now });
  liftToJob(ctx, input.taskId, opened);
  const turn = ctx.db.query<{ bot_id: string; session_id: string; ticket_id: string | null; work_item_id: string | null }, [string]>(
    "SELECT bot_id, session_id, ticket_id, work_item_id FROM turns WHERE id = ?").get(input.turnId);
  if (turn && turn.ticket_id === opened) {
    ctx.db.run("UPDATE turns SET ticket_id = NULL, work_item_id = NULL, updated_at = ? WHERE id = ?", [input.now, input.turnId]);
    const item = findOrCreateWorkItem(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId: input.taskId, ticketId: null });
    ctx.db.run("UPDATE turns SET work_item_id = ? WHERE id = ?", [item.id, input.turnId]);
    if (turn.work_item_id && turn.work_item_id !== item.id) closeWorkItemIfIdle(ctx, turn.work_item_id);
  }
  recordWorkEvent(ctx, { kind: "ticket.folded", actor: "app", taskId: input.taskId, ticketId: opened, turnId: input.turnId,
    payload: { into: input.laidOut } });
  return opened;
}

/**
 * What was filed under the opening ticket stands for the whole job it opened: your line, its quote
 * and any requirement read from it go up to the job. Left there, they held for a ticket nobody works
 * on — on 2026-10-04's walkthrough your opening line sat under the dropped ticket in its 归到哪件事,
 * and a requirement read from it (「每句不超过 12 个字」) would never reach the slogans.
 */
function liftToJob(ctx: StoreContext, taskId: string, ticketId: string): void {
  const lines = ctx.db.query<{ message_id: string; is_primary: number }, [string, string]>(
    "SELECT message_id, is_primary FROM message_filings WHERE task_id = ? AND ticket_id = ?").all(taskId, ticketId);
  for (const line of lines) {
    const already = ctx.db.query("SELECT 1 FROM message_filings WHERE message_id = ? AND task_id = ? AND ticket_id IS NULL AND part_key IS NULL")
      .get(line.message_id, taskId);
    if (already) {
      ctx.db.run("DELETE FROM message_filings WHERE message_id = ? AND task_id = ? AND ticket_id = ?", [line.message_id, taskId, ticketId]);
      if (line.is_primary) ctx.db.run("UPDATE message_filings SET is_primary = 1 WHERE message_id = ? AND task_id = ? AND ticket_id IS NULL AND part_key IS NULL", [line.message_id, taskId]);
    } else {
      ctx.db.run("UPDATE message_filings SET ticket_id = NULL, part_key = NULL WHERE message_id = ? AND task_id = ? AND ticket_id = ?", [line.message_id, taskId, ticketId]);
    }
  }
  // Its quote follows (`user_quotes_follow_filing`).
  ctx.db.run("UPDATE messages SET ticket_id = NULL WHERE task_id = ? AND ticket_id = ?", [taskId, ticketId]);
  ctx.db.run("UPDATE requirements SET scope = 'plan', scope_id = ? WHERE scope = 'ticket' AND scope_id = ?", [taskId, ticketId]);
}

export function planItems(ctx: StoreContext, input: { turnId: string; items: unknown }, now: string = isoNow()): PlanItemsResult {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.submissions) throw new HttpError(409, "conflict", "plan_items needs engine level 5");
  const turn = ctx.db.query<{ bot_id: string; task_id: string | null }, [string]>("SELECT bot_id, task_id FROM turns WHERE id = ?").get(input.turnId);
  if (!turn) throw new HttpError(404, "not_found", "turn not found");
  if (!turn.task_id) throw new HttpError(409, "conflict", "this turn is on no plan: work_on one first");
  const taskId = turn.task_id;
  const plan = ctx.db.query<{ session_id: string | null; status: string }, [string]>("SELECT session_id, status FROM tasks WHERE id = ?").get(taskId);
  if (!plan?.session_id) throw new HttpError(409, "conflict", "the plan has no conversation to work in");
  if (plan.status !== "active") throw new HttpError(409, "conflict", "the plan is not active");
  const lead = stableLead(ctx, taskId);
  if (!lead) throw new HttpError(403, "forbidden", "this plan has no confirmed lead: the user confirms one for the group, then that Bot lays out the tickets");
  if (lead !== turn.bot_id) throw new HttpError(403, "forbidden", "only the plan's lead lays out its tickets; ask the lead, or delegate to it");
  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(422, "invalid_args", "items must be a non-empty list");
  if (input.items.length > PLAN_ITEMS_MAX) throw new HttpError(422, "invalid_args", `at most ${PLAN_ITEMS_MAX} items in one call`);
  const member = memberResolver(ctx, taskId);
  const items: Item[] = input.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(422, "invalid_args", `item ${index + 1} must be an object`);
    const entry = raw as Record<string, unknown>;
    const owner = entry.owner === undefined || entry.owner === null ? null : member(text(entry.owner, "owner", 80), "owner");
    const reviewer = entry.reviewer === undefined || entry.reviewer === null ? null : member(text(entry.reviewer, "reviewer", 80), "reviewer");
    if (reviewer && reviewer === owner) throw new HttpError(422, "invalid_args", `item ${index + 1}: a ticket's reviewer cannot be its owner`);
    const rawParts = list(entry.parts, "parts");
    if (rawParts.length > PARTS_MAX) throw new HttpError(422, "invalid_args", `a ticket declares at most ${PARTS_MAX} parts`);
    // Two parts the numbering would make one are a mistake to say, not to merge quietly.
    const parts: Item["parts"] = [];
    const named = new Map<string, string>();
    for (const raw of rawParts) {
      const part = partKey(raw);
      const before = named.get(part.key);
      if (before !== undefined && before !== raw) throw new HttpError(422, "invalid_args", `item ${index + 1}: parts "${before}" and "${raw}" are both ${part.key}`);
      if (before === undefined) parts.push(part);
      named.set(part.key, raw);
    }
    return { title: text(entry.title, "title", 80), owner, reviewer, dependsOn: list(entry.depends_on, "depends_on"), parts };
  });
  const titles = items.map((item) => item.title.toLowerCase());
  if (new Set(titles).size !== titles.length) throw new HttpError(422, "invalid_args", "two items have the same title");

  return ctx.commit(() => {
    // Same title in the plan: the same ticket (rework never opens a second one).
    const existing = new Map(listTickets(ctx, taskId).map((ticket) => [ticket.title.toLowerCase(), ticket] as const));
    const made: Array<{ item: Item; ticket: Ticket; created: boolean }> = items.map((item, index) => {
      const found = existing.get(item.title.toLowerCase());
      if (found) {
        // Closed or through: not the lead's to lay out again — reopen it on the board.
        if (found.status === "done" || found.status === "parked" || found.stage === "approved") {
          throw new HttpError(409, "conflict", `item ${index + 1}: ticket ${String(found.seq).padStart(2, "0")} "${found.title}" is ${found.stage === "approved" ? "approved" : found.status}; the user reopens it on the board`);
        }
        return { item, ticket: found, created: false };
      }
      if (!item.owner) throw new HttpError(422, "invalid_args", `item ${index + 1}: a new ticket needs an owner`);
      return { item, ticket: createTicket(ctx, { taskId, title: item.title, worker: item.owner, now: new Date(now) }), created: true };
    });
    // Depends are named by another item's title, an existing ticket's title or id, or its number (「#02」, 2).
    const byRef = (ref: string): string => {
      const lower = ref.toLowerCase();
      const ofItem = made.find((row) => row.ticket.title.toLowerCase() === lower);
      if (ofItem) return ofItem.ticket.id;
      const all = listTickets(ctx, taskId);
      const seq = /^#?0*(\d{1,3})$/.exec(ref)?.[1];
      const found = all.find((ticket) => ticket.id === ref || ticket.title.toLowerCase() === lower || (seq !== undefined && ticket.seq === Number(seq)));
      if (!found) throw new HttpError(422, "invalid_args", `depends_on "${ref}" names no ticket of this plan`);
      return found.id;
    };
    const out: PlanItemsResult["tickets"] = [];
    for (const { item, ticket, created } of made) {
      const current = getTicket(ctx, ticket.id);
      const currentOwner = current.owner_bot_id ?? current.worker;
      const kept: Array<"owner" | "reviewer"> = [];
      const patch: Parameters<typeof patchTicket>[2] = {};
      // Only filled in: an owner or reviewer already set stays, whoever set it.
      // A hand-over already on its way to review keeps whoever reviews it now (a delegated reviewer too).
      const reviewing = Boolean(ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND state IN ('checking', 'submitted', 'in_review')").get(ticket.id));
      if (item.owner && item.owner !== currentOwner) {
        if (currentOwner) kept.push("owner");
        else if (item.owner === current.reviewer_bot_id) throw new HttpError(422, "invalid_args", `ticket "${current.title}": its reviewer cannot be its owner`);
        else patch.worker = item.owner;
      }
      if (item.reviewer && item.reviewer !== (current.reviewer_bot_id ?? null)) {
        if (current.reviewer_bot_id || reviewing) kept.push("reviewer");
        else patch.reviewerBotId = item.reviewer;
      }
      // Dependencies are added to what it already waits for, never taken away.
      const dependsOn = [...new Set([...(current.depends_on ?? []), ...item.dependsOn.map(byRef)])];
      if (dependsOn.length !== (current.depends_on ?? []).length) patch.dependsOn = dependsOn;
      if (Object.keys(patch).length > 0) patchTicket(ctx, ticket.id, patch, { now: new Date(now) });
      for (const part of item.parts) {
        ctx.db.run(`INSERT OR IGNORE INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES (?, ?, ?, ?, 'plan_items')`,
          [ulid(Date.parse(now)), ticket.id, part.key, part.title]);
      }
      const after = getTicket(ctx, ticket.id);
      out.push({ ticket_id: after.id, seq: after.seq, title: after.title, owner: after.owner_bot_id ?? after.worker, reviewer: after.reviewer_bot_id ?? null,
        depends_on: after.depends_on ?? [], parts: item.parts.map((part) => part.key), created, ...(kept.length > 0 ? { kept } : {}) });
    }
    const folded = foldOpeningTicket(ctx, { taskId, turnId: input.turnId, laidOut: out.map((row) => row.ticket_id), now });
    recordWorkEvent(ctx, { kind: "plan.items", actor: turn.bot_id, botId: turn.bot_id, taskId, turnId: input.turnId,
      payload: { created: out.filter((row) => row.created).map((row) => row.ticket_id), updated: out.filter((row) => !row.created).map((row) => row.ticket_id),
        ...(folded ? { folded } : {}) } });
    return { tickets: out, ...(folded ? { folded } : {}) };
  });
}
