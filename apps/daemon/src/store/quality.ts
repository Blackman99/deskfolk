/**
 * Quality events (ADR 0050, engine level 8): what went wrong with the work, filed under a category
 * the event's own type decides — never a model asked whether the model was at fault. They are a
 * projection of the work log: each event of a kind listed here, written while level 8 is on, adds
 * one row in the same transaction, with the Bot and model it is about. Clearing a conversation's
 * history keeps them and only drops the turn and message they came from.
 *
 * | event                                  | category                                   |
 * |----------------------------------------|--------------------------------------------|
 * | a reply that loops, declines, is cut   | model (the model report; never a memory)   |
 * | a render that failed or got lost, a    | pipeline                                   |
 * | part stuck at the capability ceiling   |                                            |
 * | checks failed, a reject, your rework,  | execution (the requirement was there)      |
 * | a search killed by its timeout         |                                            |
 * | an approval you overturned (by a       | review_miss (the reviewer's record)        |
 * | complaint or by sending it back)       |                                            |
 * | a requirement first said, in your      | unclear                                    |
 * | words, after a delivery; a check       |                                            |
 * | defined after it                       |                                            |
 * | a stall, a crash, a stop broken, a     | orchestration (for the maintainer only)    |
 * | stall the supervisor repairs           |                                            |
 */
import type { Database } from "bun:sqlite";
import { HttpError } from "../errors";
import { isoNow, isoPlus, ulid } from "../ids";
import { recordWorkEvent } from "./work-events";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { StoreContext } from "./shared";
import type { WorkEvent } from "./work-events";

export const QUALITY_CATEGORIES = ["model", "pipeline", "execution", "review_miss", "unclear", "orchestration"] as const;
export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];

export type QualityEvent = {
  id: string;
  kind: string;
  category: QualityCategory;
  task_id: string | null;
  ticket_id: string | null;
  part_key: string | null;
  submission_id: string | null;
  requirement_id: string | null;
  bot_id: string | null;
  model: string | null;
  turn_id: string | null;
  message_id: string | null;
  work_event_seq: number | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export const QUALITY_EVENTS_SQL = `CREATE TABLE IF NOT EXISTS quality_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('model', 'pipeline', 'execution', 'review_miss', 'unclear', 'orchestration')),
  task_id TEXT,
  ticket_id TEXT,
  part_key TEXT,
  submission_id TEXT,
  requirement_id TEXT,
  bot_id TEXT,
  model TEXT,
  turn_id TEXT,
  message_id TEXT,
  work_event_seq INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`;

export function migrateQuality(db: Database): void {
  db.run(QUALITY_EVENTS_SQL);
  db.run("CREATE INDEX IF NOT EXISTS quality_events_by_bot ON quality_events(bot_id, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_by_ticket ON quality_events(ticket_id, created_at)");
  // An earlier draft's one-column index would drop a second event of the same work event.
  db.run("DROP INDEX IF EXISTS quality_events_by_work_event");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS quality_events_per_work_event ON quality_events(work_event_seq, kind, bot_id) WHERE work_event_seq IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_by_turn ON quality_events(turn_id, kind)");
}

export function learningOn(ctx: StoreContext): boolean {
  try {
    return readEngineLevel(ctx.db) >= ENGINE_LEVELS.learning;
  } catch {
    return false;
  }
}

/** How a turn's reply failed, by the shape it took: the model's doing. */
export const MODEL_FAIL_SHAPES: ReadonlySet<string> = new Set(["repeat", "declined", "truncated", "overtime", "incomplete"]);
/** A turn that stopped making progress or broke: the app's doing, not the Bot's or its model's. */
const ORCHESTRATION_FAILS = new Set(["stuck", "crashed", "agent_exited", "agent_unguarded"]);
/** The supervisor's repairs: work that stalled, a wait on nothing, a segment that ended without a word. */
const SUPERVISOR_REPAIRS: Record<string, string> = {
  "supervisor.notice": "notice",
  "supervisor.wait_invalid": "wait_invalid",
  "supervisor.lost_segment": "lost_segment",
};
/** A requirement in your words (said, answered, annotated, written on the board); not one imported or a Bot's you accepted. */
const YOUR_WORDS = new Set(["message", "ask_answer", "annotation", "board"]);

type Projected = Omit<QualityEvent, "id" | "created_at" | "work_event_seq" | "task_id" | "ticket_id" | "turn_id"> & {
  task_id?: string | null;
  ticket_id?: string | null;
  turn_id?: string | null;
};

type SubmissionFacts = { id: string; bot_id: string; model: string | null; created_at: string; part_keys: string; ticket_id: string; task_id: string; reviews: string };

function submissionFacts(ctx: StoreContext, id: unknown): SubmissionFacts | null {
  if (typeof id !== "string") return null;
  return ctx.db.query<SubmissionFacts, [string]>("SELECT id, bot_id, model, created_at, part_keys, ticket_id, task_id, reviews FROM submissions WHERE id = ?")
    .get(id) ?? null;
}

function turnModel(ctx: StoreContext, turnId: string | null): string | null {
  if (!turnId) return null;
  return ctx.db.query<{ model: string | null }, [string]>("SELECT model FROM turn_route_decisions WHERE turn_id = ?").get(turnId)?.model ?? null;
}

function firstPart(facts: SubmissionFacts | null): string | null {
  if (!facts) return null;
  try {
    const keys = JSON.parse(facts.part_keys) as unknown;
    return Array.isArray(keys) && typeof keys[0] === "string" ? keys[0] : null;
  } catch {
    return null;
  }
}

/** The reviews that approved this hand-over: whoever you overturn by sending it back. */
function approvingReviews(facts: SubmissionFacts | null): Array<{ reviewer_bot_id: string; reviewer_model: string | null }> {
  if (!facts) return [];
  try {
    const reviews = JSON.parse(facts.reviews) as Array<{ reviewer_bot_id?: unknown; reviewer_model?: unknown; outcome?: unknown }>;
    return reviews.filter((review) => review.outcome === "approve" && typeof review.reviewer_bot_id === "string")
      .map((review) => ({ reviewer_bot_id: review.reviewer_bot_id as string, reviewer_model: typeof review.reviewer_model === "string" ? review.reviewer_model : null }));
  } catch {
    return [];
  }
}

/** The newest hand-over before `at` that a requirement in this scope would have applied to. */
function deliveredBefore(ctx: StoreContext, scope: unknown, scopeId: unknown, at: string): { id: string; bot_id: string; model: string | null; ticket_id: string; task_id: string } | null {
  if (typeof scopeId !== "string") return null;
  const where = scope === "plan" ? "task_id = ?" : scope === "ticket" ? "ticket_id = ?" : scope === "part" ? "ticket_id = (SELECT ticket_id FROM ticket_parts WHERE id = ?)" : null;
  if (!where) return null;
  return ctx.db.query<{ id: string; bot_id: string; model: string | null; ticket_id: string; task_id: string }, [string, string]>(
    `SELECT id, bot_id, model, ticket_id, task_id FROM submissions WHERE ${where} AND origin <> 'organizer' AND created_at < ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(scopeId, at) ?? null;
}

const base = { part_key: null, submission_id: null, requirement_id: null, bot_id: null, model: null, message_id: null, detail: {} };

/** The quality events a work event amounts to: none for most, one for most of the rest. */
function project(ctx: StoreContext, event: WorkEvent): Projected[] {
  const p = event.payload;
  switch (event.kind) {
    case "submission.gates_failed": {
      const facts = submissionFacts(ctx, p.submission_id);
      const failures = Array.isArray(p.failures) ? p.failures.filter((id): id is string => typeof id === "string") : [];
      // A check that was there before the hand-over was a requirement it missed; one defined only
      // after it is a requirement that first came up after the delivery.
      const before = facts && failures.length > 0 ? ctx.db.query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM acceptance_checks WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(defined_at, created_at) <= ?",
      ).get(JSON.stringify(failures), facts.created_at) : null;
      return [{ ...base, kind: "checks_failed", category: before && before.n === 0 ? "unclear" : "execution", submission_id: String(p.submission_id),
        part_key: firstPart(facts), bot_id: facts?.bot_id ?? event.bot_id, model: facts?.model ?? null, detail: { failures } }];
    }
    case "review.recorded": {
      if (p.outcome !== "reject") return [];
      const facts = submissionFacts(ctx, p.submission_id);
      const byUser = p.by === "user";
      const rejected: Projected = { ...base, kind: byUser ? "user_rejected" : "review_rejected", category: "execution", submission_id: String(p.submission_id),
        part_key: firstPart(facts), bot_id: facts?.bot_id ?? null, model: facts?.model ?? null, detail: { reviewer: byUser ? "user" : event.actor } };
      // Your send-back of what a reviewer approved overturns that approval.
      const overturned = byUser ? approvingReviews(facts).map((review): Projected => ({ ...base, kind: "review_miss", category: "review_miss",
        submission_id: String(p.submission_id), bot_id: review.reviewer_bot_id, model: review.reviewer_model, detail: { by: "send_back" } })) : [];
      return [rejected, ...overturned];
    }
    case "review.miss":
      return [{ ...base, kind: "review_miss", category: "review_miss", submission_id: typeof p.submission_id === "string" ? p.submission_id : null,
        bot_id: typeof p.reviewer_bot_id === "string" ? p.reviewer_bot_id : event.bot_id, model: typeof p.reviewer_model === "string" ? p.reviewer_model : null,
        message_id: typeof p.message_id === "string" ? p.message_id : null, detail: { card_id: p.card_id ?? null } }];
    case "ceiling.reached": {
      const facts = submissionFacts(ctx, p.submission_id);
      return [{ ...base, kind: "ceiling", category: "pipeline", submission_id: typeof p.submission_id === "string" ? p.submission_id : null,
        part_key: typeof p.part_key === "string" ? p.part_key : null, bot_id: facts?.bot_id ?? event.bot_id, model: facts?.model ?? null }];
    }
    case "complaint.rework": {
      const latest = event.ticket_id ? ctx.db.query<{ bot_id: string; model: string | null; id: string }, [string]>(
        "SELECT bot_id, model, id FROM submissions WHERE ticket_id = ? AND origin <> 'organizer' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(event.ticket_id) : null;
      return [{ ...base, kind: "complaint", category: "execution", submission_id: latest?.id ?? null,
        part_key: Array.isArray(p.parts) && typeof p.parts[0] === "string" ? p.parts[0] : null,
        bot_id: typeof p.producer === "string" ? p.producer : latest?.bot_id ?? null, model: latest?.model ?? null,
        message_id: typeof p.message_id === "string" ? p.message_id : null, detail: { card_id: p.card_id ?? null } }];
    }
    case "requirement.add":
    case "requirement.confirm": {
      // Said for the first time, in your words, once the work had been handed over: the request was not
      // clear yet. A proposal counts once you confirm it, not when it is put to you; a complaint the
      // scribe caught is the complaint's (execution), not this.
      if (event.kind === "requirement.add" && p.status !== "open") return [];
      // Dated from your words when it stands on them, not from when it was filed.
      const entry = typeof p.requirement === "string" ? ctx.db.query<{ scope: string; scope_id: string | null; source_kind: string; added_by: string; created_at: string },
        [string]>(`SELECT r.scope, r.scope_id, r.source_kind, r.added_by, COALESCE(q.created_at, r.created_at) AS created_at FROM requirements r
          LEFT JOIN user_quotes q ON q.id = r.source_quote_id WHERE r.id = ?`).get(p.requirement) : null;
      if (!entry || !YOUR_WORDS.has(entry.source_kind) || entry.added_by === "import" || entry.added_by === "capture") return [];
      const delivered = deliveredBefore(ctx, entry.scope, entry.scope_id, entry.created_at);
      if (!delivered) return [];
      return [{ ...base, kind: "requirement_after_delivery", category: "unclear", task_id: delivered.task_id, ticket_id: delivered.ticket_id,
        submission_id: delivered.id, bot_id: delivered.bot_id, model: delivered.model, requirement_id: p.requirement as string }];
    }
    case "job.failed":
    case "job.lost":
      return [{ ...base, kind: event.kind === "job.failed" ? "job_failed" : "job_lost", category: "pipeline", bot_id: event.bot_id,
        detail: { job_id: p.job_id ?? null } }];
    case "tool.timeout":
      return [{ ...base, kind: "tool_timeout", category: "execution", bot_id: event.bot_id, model: turnModel(ctx, event.turn_id),
        detail: { signature: p.signature ?? null, lesson_id: p.lesson_id ?? null } }];
    case "lesson.recurred":
      return [{ ...base, kind: "lesson_recurred", category: "execution", bot_id: event.bot_id, model: turnModel(ctx, event.turn_id),
        detail: { lesson_id: p.lesson_id ?? null } }];
    case "hold.violation":
      return [{ ...base, kind: "hold_violation", category: "orchestration", bot_id: event.bot_id }];
    case "turn.failed": {
      const reason = typeof p.fail_kind === "string" ? p.fail_kind : "";
      if (MODEL_FAIL_SHAPES.has(reason)) return [{ ...base, kind: `failure_shape:${reason}`, category: "model", bot_id: event.bot_id, model: turnModel(ctx, event.turn_id) }];
      // An endpoint that could not be reached, was busy or refused is nobody's quality.
      if (ORCHESTRATION_FAILS.has(reason)) return [{ ...base, kind: `cut_off:${reason}`, category: "orchestration", bot_id: event.bot_id, model: turnModel(ctx, event.turn_id) }];
      return [];
    }
    case "work.needs_attention":
      return p.reason === "filing_budget" ? [{ ...base, kind: "cut_off:filing_budget", category: "orchestration", bot_id: event.bot_id }] : [];
    case "supervisor.notice":
    case "supervisor.wait_invalid":
    case "supervisor.lost_segment": {
      const what = event.kind === "supervisor.notice" && typeof p.code === "string" ? p.code : SUPERVISOR_REPAIRS[event.kind];
      return [{ ...base, kind: `supervisor:${what}`, category: "orchestration", bot_id: event.bot_id }];
    }
    case "model.marked":
      return [{ ...base, kind: "marked_model", category: "model", bot_id: event.bot_id, model: typeof p.model === "string" ? p.model : turnModel(ctx, event.turn_id) }];
    default:
      return [];
  }
}

/**
 * Called by the work log for every event it writes: its quality events when level 8 is on. Taking
 * a complaint back takes back what it filed — the producer's complaint and the reviewers' misses.
 */
export function projectQuality(ctx: StoreContext, event: WorkEvent): void {
  if (!learningOn(ctx)) return;
  if (event.kind === "complaint.rework_undone" && typeof event.payload.card_id === "string") {
    ctx.db.run("DELETE FROM quality_events WHERE kind IN ('complaint', 'review_miss') AND json_extract(detail, '$.card_id') = ?", [event.payload.card_id]);
    return;
  }
  for (const [index, row] of project(ctx, event).entries()) {
    ctx.db.run(
      `INSERT OR IGNORE INTO quality_events (id, kind, category, task_id, ticket_id, part_key, submission_id, requirement_id, bot_id, model, turn_id,
         message_id, work_event_seq, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${ulid(Date.parse(event.at) || Date.now())}${index > 0 ? `-${index}` : ""}`, row.kind, row.category, row.task_id ?? event.task_id,
        row.ticket_id ?? event.ticket_id, row.part_key, row.submission_id, row.requirement_id, row.bot_id, row.model, row.turn_id ?? event.turn_id,
        row.message_id, event.seq, JSON.stringify(row.detail), event.at || isoNow()],
    );
  }
}

type QualityRow = Omit<QualityEvent, "detail"> & { detail: string };

export function listQualityEvents(ctx: StoreContext, filter: { botId?: string; ticketId?: string; category?: QualityCategory; since?: string; limit?: number } = {}): QualityEvent[] {
  const rows = ctx.db.query<QualityRow, [string | null, string | null, string | null, string, number]>(
    `SELECT * FROM quality_events WHERE (?1 IS NULL OR bot_id = ?1) AND (?2 IS NULL OR ticket_id = ?2) AND (?3 IS NULL OR category = ?3)
       AND created_at >= ?4 ORDER BY created_at DESC, rowid DESC LIMIT ?5`,
  ).all(filter.botId ?? null, filter.ticketId ?? null, filter.category ?? null, filter.since ?? "", Math.min(500, Math.max(1, filter.limit ?? 100)));
  return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

/** The report's column each counted kind adds to. */
const REPORTED: Record<string, "review_rejected" | "user_rejected" | "checks_failed" | "complaints" | "review_misses"> = {
  review_rejected: "review_rejected",
  user_rejected: "user_rejected",
  checks_failed: "checks_failed",
  complaint: "complaints",
  review_miss: "review_misses",
};

export type QualityReportRow = {
  bot_id: string;
  bot_name: string | null;
  model: string | null;
  plan_kind: string | null;
  hand_overs: number;
  approved: number;
  /** Turned back by a reviewer, by you, or by checks: each over the hand-overs. */
  review_rejected: number;
  user_rejected: number;
  checks_failed: number;
  /** Your complaints about delivered work. */
  complaints: number;
  /** Replies that looped, declined or were cut. */
  failure_shapes: number;
  /** Approvals by this Bot as a reviewer that you overturned. */
  review_misses: number;
  /** Spend on this Bot's turns on this model in the window, and per approved hand-over. */
  cost_usd: number | null;
  cost_per_approved: number | null;
};

/**
 * The offline report (ADR 0050): per Bot × model × plan kind, how its hand-overs fared and what the
 * work cost, over the last `days`. Nothing here changes what runs: a suggestion only takes effect
 * once you pin a model.
 */
export function qualityReport(ctx: StoreContext, opts: { days?: number; now?: string } = {}): QualityReportRow[] {
  // Below level 8 turn-backs, complaints and misses are not filed: zeros there would read as counts.
  if (!learningOn(ctx)) return [];
  const since = isoPlus(opts.now ?? isoNow(), -(Math.max(1, opts.days ?? 7) * 86_400_000));
  const rows = new Map<string, QualityReportRow>();
  const row = (botId: string, model: string | null, kind: string | null): QualityReportRow => {
    const key = JSON.stringify([botId, model, kind]);
    let found = rows.get(key);
    if (!found) {
      const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ? AND deleted_at IS NULL").get(botId)?.name ?? null;
      found = { bot_id: botId, bot_name: name, model, plan_kind: kind, hand_overs: 0, approved: 0, review_rejected: 0, user_rejected: 0, checks_failed: 0, complaints: 0,
        failure_shapes: 0, review_misses: 0, cost_usd: null, cost_per_approved: null };
      rows.set(key, found);
    }
    return found;
  };
  for (const s of ctx.db.query<{ bot_id: string; model: string | null; kind: string | null; state: string; n: number }, [string]>(
    `SELECT s.bot_id, s.model, t.kind, s.state, COUNT(*) AS n FROM submissions s LEFT JOIN tasks t ON t.id = s.task_id
     WHERE s.created_at >= ? AND s.origin <> 'organizer' GROUP BY s.bot_id, s.model, t.kind, s.state`).all(since)) {
    const target = row(s.bot_id, s.model, s.kind);
    target.hand_overs += s.n;
    if (s.state === "approved") target.approved += s.n;
  }
  for (const q of ctx.db.query<{ bot_id: string; model: string | null; kind: string | null; event: string; n: number }, [string]>(
    `SELECT q.bot_id, q.model, t.kind, q.kind AS event, COUNT(*) AS n FROM quality_events q LEFT JOIN tasks t ON t.id = q.task_id
     WHERE q.created_at >= ? AND q.bot_id IS NOT NULL GROUP BY q.bot_id, q.model, t.kind, q.kind`).all(since)) {
    const counted = q.event.startsWith("failure_shape:") ? "failure_shapes" : REPORTED[q.event];
    // Only what the report counts makes a row: an orchestration event is not the Bot's.
    if (counted) row(q.bot_id, q.model, q.kind)[counted] += q.n;
  }
  for (const c of ctx.db.query<{ bot_id: string; model: string | null; kind: string | null; cost: number | null }, [string]>(
    `SELECT sp.bot_id, sp.model, t.kind, SUM(COALESCE(sp.cost_usd_ticks, sp.estimated_cost_usd_ticks)) / 1e10 AS cost FROM spend sp LEFT JOIN turns tu ON tu.id = sp.turn_id LEFT JOIN tasks t ON t.id = tu.task_id
     WHERE sp.created_at >= ? AND sp.bot_id IS NOT NULL GROUP BY sp.bot_id, sp.model, t.kind`).all(since)) {
    const key = JSON.stringify([c.bot_id, c.model, c.kind]);
    const target = rows.get(key);
    if (!target || c.cost == null) continue;
    target.cost_usd = c.cost;
    target.cost_per_approved = target.approved > 0 ? c.cost / target.approved : null;
  }
  return [...rows.values()].sort((a, b) => b.hand_overs - a.hand_overs || a.bot_id.localeCompare(b.bot_id));
}

/** Whether you marked this turn's trouble as the model's (`markTurnModel`). */
export function turnMarkedModel(ctx: StoreContext, turnId: string): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM quality_events WHERE turn_id = ? AND kind = 'marked_model'").get(turnId));
}

/**
 * Your 「记为模型问题」 on a board card (ADR 0050): a quality event in the model category for that
 * turn, or, unmarked, gone again. It feeds the model report and nothing else — no memory, no pick.
 */
export function markTurnModel(ctx: StoreContext, turnId: string, marked: boolean): { turn_id: string; marked: boolean } {
  if (!learningOn(ctx)) throw new HttpError(409, "conflict", "marking a model needs engine level 8");
  const turn = ctx.db.query<{ bot_id: string; session_id: string; task_id: string | null; ticket_id: string | null }, [string]>(
    "SELECT bot_id, session_id, task_id, ticket_id FROM turns WHERE id = ?").get(turnId);
  if (!turn) throw new HttpError(404, "not_found", "turn not found");
  const already = turnMarkedModel(ctx, turnId);
  if (marked && !already) {
    recordWorkEvent(ctx, { kind: "model.marked", actor: "user", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId,
      sessionId: turn.session_id, payload: { model: turnModel(ctx, turnId) } });
  } else if (!marked && already) {
    ctx.db.run("DELETE FROM quality_events WHERE turn_id = ? AND kind = 'marked_model'", [turnId]);
    recordWorkEvent(ctx, { kind: "model.unmarked", actor: "user", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId,
      sessionId: turn.session_id, payload: {} });
  }
  return { turn_id: turnId, marked };
}

/** Clearing a conversation's history keeps its quality events, without the turns and messages they came from. */
export function forgetQualitySources(ctx: StoreContext, sessionId: string): void {
  ctx.db.run("UPDATE quality_events SET turn_id = NULL WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)", [sessionId]);
  ctx.db.run("UPDATE quality_events SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)", [sessionId]);
}
