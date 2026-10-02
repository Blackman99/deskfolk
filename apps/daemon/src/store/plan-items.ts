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
import { filenamePartNumbers } from "./filing";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { StoreContext } from "./shared";
import { createTicket, getTicket, listTickets, patchTicket } from "./tickets";
import { recordWorkEvent } from "./work-events";

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
};

type Item = { title: string; owner: string | null; reviewer: string | null; dependsOn: string[]; parts: Array<{ key: string; title: string }> };

/**
 * The lead plan_items listens to: the plan's stored lead, else the group lead you confirmed, else the
 * one Bot of a direct — each while it can still work there. Never the Bot that happened to run most,
 * which would move under you (`planLead` keeps that for whom the supervisor calls back).
 */
function stableLead(ctx: StoreContext, taskId: string): string | null {
  const plan = ctx.db.query<{ session_id: string | null; lead_bot_id: string | null }, [string]>("SELECT session_id, lead_bot_id FROM tasks WHERE id = ?").get(taskId);
  if (!plan?.session_id) return null;
  const sessionId = plan.session_id;
  const eligible = (botId: string | null | undefined) => botId ? ctx.db.query<{ id: string }, [string, string]>(`SELECT b.id FROM bots b
    JOIN session_participants p ON p.member = b.id AND p.session_id = ? AND p.left_at IS NULL WHERE b.id = ? AND b.archived_at IS NULL AND b.deleted_at IS NULL`)
    .get(sessionId, botId)?.id ?? null : null;
  const confirmed = ctx.db.query<{ member: string }, [string]>(`SELECT member FROM session_participants WHERE session_id = ? AND is_lead = 1
    AND left_at IS NULL ORDER BY joined_at, member LIMIT 1`).get(plan.session_id)?.member;
  const kind = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(plan.session_id)?.kind;
  const directBots = kind === "direct" ? ctx.db.query<{ member: string }, [string]>(`SELECT p.member FROM session_participants p JOIN bots b ON b.id = p.member
    WHERE p.session_id = ? AND p.left_at IS NULL`).all(plan.session_id) : [];
  return eligible(plan.lead_bot_id) ?? eligible(confirmed) ?? (directBots.length === 1 ? eligible(directBots[0]!.member) : null);
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
function memberResolver(ctx: StoreContext, sessionId: string): (ref: string, field: string) => string {
  const members = ctx.db.query<{ id: string; name: string }, [string]>(`SELECT b.id, b.name FROM bots b
    JOIN session_participants sp ON sp.member = b.id AND sp.left_at IS NULL AND sp.session_id = ?
    WHERE b.archived_at IS NULL AND b.deleted_at IS NULL`).all(sessionId);
  return (ref, field) => {
    const found = members.find((bot) => bot.id === ref) ?? members.find((bot) => bot.name === ref);
    if (!found) throw new HttpError(422, "invalid_args", `${field} "${ref}" is not a Bot in this plan's conversation`);
    return found.id;
  };
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
  const member = memberResolver(ctx, plan.session_id);
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
    recordWorkEvent(ctx, { kind: "plan.items", actor: turn.bot_id, botId: turn.bot_id, taskId, turnId: input.turnId,
      payload: { created: out.filter((row) => row.created).map((row) => row.ticket_id), updated: out.filter((row) => !row.created).map((row) => row.ticket_id) } });
    return { tickets: out };
  });
}
