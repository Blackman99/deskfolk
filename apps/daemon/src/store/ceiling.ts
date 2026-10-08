/** The rework ceiling: a ticket that keeps failing the same way stops and asks you. */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { queueInboxItem, refreshHeldInbox } from "./inbox";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { waiveRequirement } from "./requirements";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import { cardPlace, gateFailed, toSubmission, yourDirectWith, type Submission, type SubmissionRow } from "./submission-rows";
import { setTicketStage, settlePlanStage, stagedTicket } from "./ticket-stage";
import { recordWorkEvent } from "./work-events";
import { queueWork } from "./work-items";

/** The capability ceiling (§6.6): this many hand-overs in a row failing the same requirement… */
export const CEILING_STREAK = 3;
/** …or more hand-overs than this since you last answered about it. */
export const CEILING_ATTEMPTS = 6;

export type CeilingAction = "another_way" | "another_plan" | "relax" | "accept";
const CEILING_ACTIONS: readonly CeilingAction[] = ["another_way", "another_plan", "relax", "accept"];

/** An open ceiling card on a ticket: about one of `partKeys`, or the ticket itself. Null when none waits. */
export function openCeiling(ctx: StoreContext, ticketId: string, partKeys: readonly string[]): { id: string; part_key: string | null } | null {
  const rows = ctx.db.query<{ id: string; part_key: string | null }, [string]>(`SELECT id, json_extract(control, '$.part_key') AS part_key FROM messages
    WHERE json_extract(control, '$.kind') = 'ceiling' AND json_extract(control, '$.ticket_id') = ?
      AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0 AND json_array_length(json_extract(control, '$.offer')) > 0
    ORDER BY created_at, rowid`).all(ticketId);
  // A hand-over of no part would let the ticket through around a stuck part: any open card holds it.
  if (partKeys.length === 0) return rows[0] ?? null;
  return rows.find((row) => row.part_key === null || partKeys.includes(row.part_key)) ?? null;
}

/** An open ceiling card on a ticket, about any of it: the ball is yours while it waits. */
export function ceilingCardOf(ctx: StoreContext, ticketId: string): string | null {
  return ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'ceiling'
    AND json_extract(control, '$.ticket_id') = ? AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0
    AND json_array_length(json_extract(control, '$.offer')) > 0 ORDER BY created_at, rowid LIMIT 1`).get(ticketId)?.id ?? null;
}

/** Since when a unit's hand-overs count towards the ceiling: your last answer about it. */
function ceilingSince(ctx: StoreContext, ticketId: string, partKey: string | null): string {
  return ctx.db.query<{ at: string }, [string, string]>(`SELECT at FROM work_events WHERE kind = 'ceiling.answered' AND ticket_id = ?
    AND IFNULL(json_extract(payload, '$.part_key'), '') = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(ticketId, partKey ?? "")?.at ?? "";
}

/** The requirement of yours a check stands on, when it was read from your words; else null. */
function requirementOfCheck(ctx: StoreContext, checkId: string): { id: string; quote: string } | null {
  return ctx.db.query<{ id: string; quote: string }, [string]>(`SELECT r.id, r.quote FROM acceptance_checks c
    JOIN requirements r ON r.status = 'open' AND (r.source_quote_id = c.quote_id
      OR r.id IN (SELECT requirement_id FROM requirement_mentions WHERE quote_id = c.quote_id))
    WHERE c.id = ? AND c.quote_id IS NOT NULL ORDER BY r.created_at LIMIT 1`).get(checkId) ?? null;
}

/** What a decided hand-over failed, keyed by the requirement it is about (a check on none: `check:<id>`), each with a label for the card. */
function failureKeys(ctx: StoreContext, submission: Submission): Map<string, string> {
  const keys = new Map<string, string>();
  for (const check of submission.checks) {
    if (!gateFailed(check) || check.outcome === "not_run") continue;
    const requirement = requirementOfCheck(ctx, check.check_id);
    keys.set(requirement ? requirement.id : `check:${check.check_id}`, requirement ? requirement.quote : check.item);
  }
  for (const review of submission.reviews) {
    if (review.outcome !== "reject") continue;
    for (const verdict of review.verdicts) {
      if (verdict.verdict !== "fail") continue;
      const quote = ctx.db.query<{ quote: string }, [string]>("SELECT quote FROM requirements WHERE id = ?").get(verdict.requirement_id)?.quote;
      if (quote !== undefined) keys.set(verdict.requirement_id, quote);
    }
  }
  return keys;
}

type CeilingHit = { reason: "streak"; key: string; label: string; times: number } | { reason: "attempts"; times: number };
/** After a failure: the units (part keys; null for the whole ticket) now stuck at the ceiling, and whether that is every unit it covered. */
export type CeilingOutcome = { cards: Message[]; stuck: Array<string | null>; all: boolean };
export const NO_CEILING: CeilingOutcome = { cards: [], stuck: [], all: false };

/**
 * After a hand-over failed (its checks, a review, or your send-back): each of its parts — else its
 * ticket — that has now failed the same requirement on {@link CEILING_STREAK} hand-overs in a row, or
 * been handed over more than {@link CEILING_ATTEMPTS} times, since your last answer about it, hits the
 * capability ceiling (§6.6): a part is blocked, nothing more is handed over for it, the ball is yours,
 * and a card asks how to go on. Once per unit while its card waits.
 */
export function checkCeiling(ctx: StoreContext, submission: Submission, now: string): CeilingOutcome {
  const cards: Message[] = [];
  const stuck: Array<string | null> = [];
  const units: Array<string | null> = submission.part_keys.length > 0 ? submission.part_keys : [null];
  for (const partKey of units) {
    if (unitStuck(ctx, submission.ticket_id, partKey)) {
      stuck.push(partKey);
      continue;
    }
    const since = ceilingSince(ctx, submission.ticket_id, partKey);
    // A part counts the hand-overs of it; the whole ticket counts only those of no part.
    const covering = ctx.db.query<SubmissionRow, [string, string]>(`SELECT * FROM submissions WHERE ticket_id = ? AND created_at > ?
      AND state <> 'superseded' ORDER BY created_at DESC, rowid DESC`).all(submission.ticket_id, since).map(toSubmission)
      .filter((row) => partKey === null ? row.part_keys.length === 0 : row.part_keys.includes(partKey));
    const decided = covering.filter((row) => row.state === "checks_failed" || row.state === "rejected" || row.state === "approved");
    let hit: CeilingHit | null = null;
    for (const [key, label] of decided[0] ? failureKeys(ctx, decided[0]) : new Map<string, string>()) {
      let times = 0;
      for (const row of decided) {
        if (!failureKeys(ctx, row).has(key)) break;
        times += 1;
      }
      if (times >= CEILING_STREAK) {
        hit = { reason: "streak", key, label, times };
        break;
      }
    }
    const failures = decided.filter((row) => row.state !== "approved").length;
    if (!hit && failures > CEILING_ATTEMPTS) hit = { reason: "attempts", times: failures };
    if (!hit) continue;
    stuck.push(partKey);
    if (partKey) {
      const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(submission.ticket_id, partKey);
      if (part && part.stage !== "blocked") {
        ctx.db.run("UPDATE ticket_parts SET stage = 'blocked' WHERE ticket_id = ? AND key = ?", [submission.ticket_id, partKey]);
        recordWorkEvent(ctx, { kind: "part.stage_changed", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
          payload: { part: partKey, before: part.stage, after: "blocked", submission_id: submission.id } });
      }
    }
    const card = ceilingCard(ctx, submission, partKey, hit);
    if (card) cards.push(card);
    recordWorkEvent(ctx, { kind: "ceiling.reached", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { part_key: partKey, submission_id: submission.id, card_id: card?.id ?? null, at: now, ...hit } });
  }
  return { cards, stuck, all: stuck.length === units.length };
}

/** Whether a unit already waits on an open ceiling card: its own, or (for a part) the whole ticket's. */
function unitStuck(ctx: StoreContext, ticketId: string, partKey: string | null): boolean {
  return ctx.db.query<{ part_key: string | null }, [string]>(`SELECT json_extract(control, '$.part_key') AS part_key FROM messages
    WHERE json_extract(control, '$.kind') = 'ceiling' AND json_extract(control, '$.ticket_id') = ?
      AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0 AND json_array_length(json_extract(control, '$.offer')) > 0`)
    .all(ticketId).some((row) => row.part_key === null || row.part_key === partKey);
}

/**
 * The ceiling cards still asking about a ticket stop asking: it closed another way (approved, or
 * your board edit). Each says why.
 */
export function closeCeilingCards(ctx: StoreContext, ticketId: string, why: string): void {
  const open = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'ceiling'
    AND json_extract(control, '$.ticket_id') = ? AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0
    AND json_array_length(json_extract(control, '$.offer')) > 0`).all(ticketId);
  for (const row of open) {
    const control = getMessage(ctx, row.id).control;
    if (control?.kind !== "ceiling") continue;
    setMessageControl(ctx, row.id, { ...control, offer: [], result: why });
    updateNotificationActionState(ctx, `ceiling:${row.id}`, "resolved", "closed", true);
  }
}

function ceilingCard(ctx: StoreContext, submission: Submission, partKey: string | null, hit: CeilingHit): Message | null {
  const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(submission.task_id);
  if (!plan?.session_id) return null;
  const ticket = stagedTicket(ctx, submission.ticket_id);
  const en = localeOf(ctx) === "en";
  const number = String(ticket.seq).padStart(2, "0");
  const unit = partKey ? (en ? ` part ${partKey}` : `分件 ${partKey} `) : "";
  const why = hit.reason === "streak"
    ? (en ? `"${hit.label}" failed ${hit.times} hand-overs in a row` : `「${hit.label}」连续 ${hit.times} 次没过`)
    : (en ? `${hit.times} hand-overs failed` : `已经交了 ${hit.times} 次都没过`);
  const requirementId = hit.reason === "streak" && !hit.key.startsWith("check:") ? hit.key : null;
  const place = cardPlace(ctx, submission, plan.session_id);
  const message = insertMessage(ctx, {
    sessionId: place, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
    body: en
      ? `Ticket ${number} "${ticket.title}"${unit} of ${plan.title} is stuck: ${why}. Trying again the same way is unlikely to help — how should it go on?`
      : `${plan.title} 的任务 ${number}「${ticket.title}」${unit}卡住了：${why}，照原样再试多半还是不过。要怎么办？`,
    control: { kind: "ceiling", task_id: submission.task_id, ticket_id: submission.ticket_id, part_key: partKey, requirement_id: requirementId,
      offer: ["another_way", "another_plan", ...(requirementId ? ["relax" as const] : []), "accept"] },
  });
  createNotification(ctx, { semantic_key: `ceiling:${message.id}`, kind: "ask", session_id: place, message_id: message.id, action_state: "open" });
  return message;
}

/**
 * Your answer on a ceiling card (§6.6). Another way or another plan: the unit goes back to rework,
 * its producer is told which, and its count starts over. Relax: the requirement no longer holds for
 * this plan (waived — your press is the confirmation), then the same. Accept: the part is approved
 * as it is; a ticket whose every part is then approved or waived (or that has none) is approved,
 * and the plan may be delivered.
 */
export function answerCeilingCard(ctx: StoreContext, messageId: string, action: unknown): Message {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "ceiling") throw new HttpError(422, "invalid_args", "this line is not a ceiling card");
    if (!CEILING_ACTIONS.includes(action as CeilingAction)) throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action as CeilingAction)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const chosen = action as CeilingAction;
    const now = isoNow();
    const ticket = stagedTicket(ctx, control.ticket_id);
    const partKey = control.part_key;
    if (chosen === "relax" && control.requirement_id) waiveRequirement(ctx, control.requirement_id, { taskId: control.task_id, action: messageId, now });
    const accepted = chosen === "accept";
    if (partKey) {
      const stage = accepted ? "approved" : "rework";
      const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(ticket.id, partKey);
      if (part && part.stage !== stage) {
        ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ?", [stage, ticket.id, partKey]);
        recordWorkEvent(ctx, { kind: "part.stage_changed", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
          payload: { part: partKey, before: part.stage, after: stage, message_id: messageId } });
      }
    }
    if (accepted && ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_parts WHERE ticket_id = ? AND stage NOT IN ('approved', 'waived')").get(ticket.id)!.n === 0) {
      setTicketStage(ctx, { ticketId: ticket.id, stage: "approved", source: "user", now });
      settlePlanStage(ctx, ticket.task_id, now);
    }
    recordWorkEvent(ctx, { kind: "ceiling.answered", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
      payload: { part_key: partKey, action: chosen, requirement_id: control.requirement_id, card_id: messageId } });
    const producer = ticket.owner_bot_id ?? ticket.worker;
    const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(ticket.task_id);
    if (producer && plan?.session_id && ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(producer)) {
      const en = localeOf(ctx) === "en";
      const unit = partKey ? (en ? ` (part ${partKey})` : `（分件 ${partKey}）`) : "";
      const said: Record<CeilingAction, string> = en
        ? { another_way: "do it another way — a different method or tool, not the same attempt again", another_plan: "change the plan to get around the problem",
          relax: "that requirement no longer holds for this plan", accept: "accept it as it is" }
        : { another_way: "换一种做法——换方法或工具，别再照原样试", another_plan: "改方案，绕开这个问题", relax: "那条要求在这件事里不再要了", accept: "就用现在的" };
      const body = en
        ? `(app) On the ceiling card for ticket "${ticket.title}"${unit} the user chose: ${said[chosen]}.${accepted ? "" : " Go on from there and hand it over again."}`
        : `（应用）任务「${ticket.title}」${unit}的天花板卡片上，用户选了：${said[chosen]}。${accepted ? "" : "照这个方向做完再交。"}`;
      if (accepted) {
        const work = ctx.db.query<{ id: string }, [string, string, string]>(`SELECT id FROM work_items WHERE bot_id = ? AND task_id = ? AND ticket_id = ?
          AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(producer, ticket.task_id, ticket.id);
        if (work) queueInboxItem(ctx, { botId: producer, sessionId: yourDirectWith(ctx, message.session_id, producer) ?? plan.session_id, turnId: null, workItemId: work.id, taskId: ticket.task_id, ticketId: ticket.id,
          messageId: null, author: "app", body, source: "review", kind: "result", priority: 2, wakes: false, now });
      } else {
        queueWork(ctx, { botId: producer, sessionId: yourDirectWith(ctx, message.session_id, producer) ?? plan.session_id, taskId: ticket.task_id, ticketId: ticket.id, messageId: null, author: "app",
          body, source: "review", kind: "result", priority: 2, notice: false });
      }
      refreshHeldInbox(ctx, { botId: producer });
    }
    updateNotificationActionState(ctx, `ceiling:${messageId}`, "resolved", chosen, true);
    return setMessageControl(ctx, messageId, { ...control, acted: [chosen] });
  });
}
