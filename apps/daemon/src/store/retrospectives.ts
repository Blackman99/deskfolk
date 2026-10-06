/**
 * The retrospective (完工复盘, ADR 0062, engine level 8): once a plan has been delivered and has
 * stayed delivered for half an hour, each Bot that made something in it looks back once — on its
 * own model, over the job's record (your words, what each hand-over came to, the requirements, the
 * quality events, its tool trouble), never the transcript — and says what tripped it up, what made
 * you send work back, and what to keep doing. What it concludes goes into its own memories and
 * skills, but the app does the writing: change by change, checked the way the Bot's own tools check
 * them, each kept with what it replaced, so any one can be taken back on the board. It asks you
 * nothing and posts nothing in the conversation (ADR 0058).
 *
 * When is decided here, not by a model: the scheduler's tick claims the oldest delivery still due,
 * one Bot at a time — none under a stop over the Bot or the plan, none for a routine's plan, none
 * once the day's retrospectives cost {@link RETRO_DAILY_USD}. A Bot nothing went wrong for in the
 * job (no hand-over sent back, no complaint, no requirement first said after a hand-over, no render
 * lost, no search timed out) is set aside without a call: there is nothing to learn from it.
 *
 * It amends ADR 0050 §7, which stopped the after-the-fact chain reviews: this asks no model whether
 * the model was at fault and files nothing about the model; it is the Bot reviewing its own conduct
 * over a job you accepted, and a memory or skill it writes is still its own (ADR 0021).
 */
import type { Database } from "bun:sqlite";
import { USER_MEMBER, type Retrospective, type RetrospectiveChange, type RetrospectiveSide, type RetrospectiveVerdict } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { codePointCount } from "../text";
import { holdsCovering } from "./holds";
import { MEMORY_MAX_PER_BOT, MEMORY_ROWS_PER_BOT, parseMemoryBody, parseMemorySubject } from "./memories";
import { learningOn } from "./quality";
import { SKILL_MAX_PER_BOT, parseSkillBody, parseSkillDescription, parseSkillName } from "./skills";
import type { MemoryRow, SkillRow, StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** A delivery is looked back on once it has stayed delivered this long: a complaint right after an approval reopens it first. */
export const RETRO_QUIET_MS = 30 * 60_000;
/** A delivery older than this is not looked back on any more. */
const RETRO_WITHIN_MS = 7 * 24 * 60 * 60_000;
/** The day's retrospectives stop once they cost this much (spend purpose `retrospect`). */
export const RETRO_DAILY_USD = 2;
/** At most this many a day, whatever they cost (a model with no price never reaches the cap in money). */
export const RETRO_DAILY_COUNT = 12;
/** A claimed one still pending after this long was cut off (a restart mid-call): it is failed, not retried. */
const PENDING_STALE_MS = 10 * 60_000;
/** The Bots that look back on one delivery: those that handed over the most in it. */
const BOTS_PER_DELIVERY = 3;
/** What one retrospective may change: a few conclusions, not a rewrite of everything the Bot knows. */
export const RETRO_REMEMBER_MAX = 3;
export const RETRO_FORGET_MAX = 3;
export const RETRO_SKILL_OPS_MAX = 2;
/** A skill it makes from nothing is a short procedure, not a manual. */
const CREATED_SKILL_MAX = 6000;
/** How much of the Bot's skill bodies the call reads; a skill past it is named, and can only be appended to. */
const SKILL_BODY_BUDGET = 16_000;
/** The lists it writes down: a few short lines each. */
const FINDINGS_MAX = 5;
const LINE_MAX = 200;

export const RETROSPECTIVES_SQL = `CREATE TABLE IF NOT EXISTS retrospectives (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  -- The delivery it looks back on (tasks.delivered_at when it was claimed): a plan reopened and
  -- delivered again gets another.
  delivered_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'skipped', 'failed')),
  model TEXT,
  summary TEXT,
  -- What it found (JSON): pitfalls, rework_causes, keep, and a verdict on its earlier conclusions.
  findings TEXT NOT NULL DEFAULT '{}',
  -- Each change to its memories and skills (JSON), with what it replaced, as RetrospectiveChange.
  changes TEXT NOT NULL DEFAULT '[]',
  -- Why it was set aside or failed, or that it changed nothing.
  note TEXT,
  -- The model's answer as it came, for the maintainer; never shown to a Bot.
  raw TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
)`;

export function migrateRetrospectives(db: Database): void {
  db.run(RETROSPECTIVES_SQL);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS retrospectives_once ON retrospectives(task_id, bot_id, delivered_at)");
  db.run("CREATE INDEX IF NOT EXISTS retrospectives_by_bot ON retrospectives(bot_id, created_at)");
  // Which retrospective last wrote a memory or a skill: its card says so, and a later write by a turn clears it.
  for (const table of ["memories", "skills"]) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (cols.length > 0 && !cols.includes("retrospective_id")) db.run(`ALTER TABLE ${table} ADD COLUMN retrospective_id TEXT`);
  }
}

type RetrospectiveRow = {
  id: string;
  task_id: string;
  bot_id: string;
  delivered_at: string;
  state: "pending" | "done" | "skipped" | "failed";
  model: string | null;
  summary: string | null;
  findings: string;
  changes: string;
  note: string | null;
  raw: string | null;
  created_at: string;
  finished_at: string | null;
};

/** One line of the job's record the call reads; every field is short and none is a file's content. */
export type DueRetrospective = {
  id: string;
  taskId: string;
  botId: string;
  botName: string;
  deliveredAt: string;
  sessionId: string | null;
  plan: { title: string; brief: string | null; kind: string | null };
  tickets: Array<{ title: string; stage: string; yours: boolean; hand_overs: number }>;
  /** Your words on the job, oldest first: what you asked, what you corrected. */
  yourWords: Array<{ at: string; via: string; text: string }>;
  /** Every hand-over, oldest first, and what became of it. */
  handOvers: Array<{ at: string; ticket: string; by: string; state: string; note: string | null; answer: string | null;
    checks_failed: string[]; reviews: string[]; user_note: string | null }>;
  /** What you said was wrong after it had been accepted, each of which sent work back. */
  complaints: Array<{ at: string; text: string }>;
  requirements: Array<{ n: string; quote: string; restated: string | null; must_not: boolean; times_said: number; first_said_after_a_hand_over: boolean }>;
  trouble: {
    quality: Record<string, number>;
    tool_failures: Array<{ tool: string; error: string; times: number }>;
    model_stepped_up: number;
    endings_sent_back: number;
    turns: number;
  };
  memories: Array<{ subject: string; body: string; updated_at: string }>;
  memoriesOff: Array<{ subject: string; body: string }>;
  memoryRoom: number;
  /** Its own skills; a null body is one past the reading budget, which it may only append to. */
  skills: Array<{ name: string; description: string; body: string | null }>;
  skillsOff: string[];
  projectSkills: Array<{ name: string; description: string }>;
  checklist: Array<{ moment: string; text: string }>;
  /** Its last few retrospectives (this job's earlier delivery included) and what became of their changes. */
  earlier: Array<{ at: string; plan: string; summary: string | null; changes: Array<{ what: string; label: string; status: string }> }>;
  /** The trouble that made this one due. */
  signals: string[];
};

export type RetrospectiveMemoryOp =
  | { op: "remember"; subject: string; body: string; replaces: string[]; why: string }
  | { op: "forget"; subject: string; why: string };

/**
 * One edit to a skill's body: added at the end, added right after a passage found exactly once, or
 * one sentence found exactly once corrected. Nothing longer is rewritten: a passage rewritten whole
 * loses what the rewrite forgot to carry over (「一句台词一个文件」 went that way on the first real run).
 */
export type RetrospectiveSkillEdit =
  | { kind: "append"; text: string }
  | { kind: "insert"; after: string; text: string }
  | { kind: "replace"; old: string; text: string };

export type RetrospectiveSkillOp =
  | { op: "edit"; name: string; description: string | null; edits: RetrospectiveSkillEdit[]; why: string }
  | { op: "create"; name: string; description: string; body: string; why: string };

export type RetrospectiveOutcome = {
  summary: string;
  pitfalls: string[];
  rework_causes: string[];
  keep: string[];
  earlier: RetrospectiveVerdict[];
  memory: RetrospectiveMemoryOp[];
  skills: RetrospectiveSkillOp[];
};

function clip(text: string | null | undefined, max: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (codePointCount(value) <= max) return value;
  return `${[...value].slice(0, max - 1).join("")}…`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRetrospective(row: RetrospectiveRow): Retrospective {
  const findings = parseJson<{ pitfalls?: string[]; rework_causes?: string[]; keep?: string[]; earlier?: RetrospectiveVerdict[] }>(row.findings, {});
  return {
    id: row.id,
    task_id: row.task_id,
    bot_id: row.bot_id,
    delivered_at: row.delivered_at,
    state: row.state === "skipped" ? "failed" : row.state,
    model: row.model,
    summary: row.summary,
    pitfalls: findings.pitfalls ?? [],
    rework_causes: findings.rework_causes ?? [],
    keep: findings.keep ?? [],
    earlier: findings.earlier ?? [],
    changes: parseJson<RetrospectiveChange[]>(row.changes, []),
    note: row.note,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

export function getRetrospective(ctx: StoreContext, id: string): Retrospective {
  const row = ctx.db.query<RetrospectiveRow, [string]>("SELECT * FROM retrospectives WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "retrospective not found");
  return toRetrospective(row);
}

/** A plan's retrospectives for its board: the ones that ran or are running, oldest first; none set aside. */
export function listRetrospectives(ctx: StoreContext, taskId: string): Retrospective[] {
  return ctx.db.query<RetrospectiveRow, [string]>(
    "SELECT * FROM retrospectives WHERE task_id = ? AND state IN ('pending', 'done', 'failed') ORDER BY created_at, rowid").all(taskId).map(toRetrospective);
}

/** What the last 24 hours of retrospectives cost, in USD. */
export function retrospectSpendToday(ctx: StoreContext, now: string = isoNow()): number {
  const since = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  return ctx.db.query<{ usd: number | null }, [string]>(
    "SELECT SUM(COALESCE(cost_usd_ticks, estimated_cost_usd_ticks)) / 1e10 AS usd FROM spend WHERE purpose = 'retrospect' AND created_at >= ?").get(since)?.usd ?? 0;
}

/** The categories of quality event that say the Bot's own work went wrong; a model's failure shape and the app's own stalls do not. */
const SIGNAL_CATEGORIES = "('execution', 'unclear', 'pipeline', 'review_miss')";

/**
 * What went wrong for this Bot in this job since `since` (the delivery an earlier retrospective of
 * it already looked back on): its quality events by kind, and a ticket it had to hand over again.
 * Empty when nothing did.
 */
function troubleSignals(ctx: StoreContext, taskId: string, botId: string, since: string | null): string[] {
  const after = since ?? "";
  const kinds = ctx.db.query<{ kind: string; n: number }, [string, string, string]>(
    `SELECT kind, COUNT(*) AS n FROM quality_events WHERE task_id = ? AND bot_id = ? AND category IN ${SIGNAL_CATEGORIES} AND created_at > ?
     GROUP BY kind ORDER BY kind`).all(taskId, botId, after).map((row) => `${row.kind}×${row.n}`);
  const again = ctx.db.query<{ n: number }, [string, string, string]>(
    `SELECT COUNT(*) AS n FROM (SELECT ticket_id FROM submissions WHERE task_id = ? AND bot_id = ? AND created_at > ? GROUP BY ticket_id HAVING COUNT(*) > 1)`)
    .get(taskId, botId, after)!.n;
  return again > 0 ? [...kinds, `handed_over_again×${again}`] : kinds;
}

/**
 * The next retrospective to run, claimed (a `pending` row) so a second tick does not run it too;
 * null when none is due. A delivery it will never run for — a deleted Bot, nothing that went wrong
 * — is set aside as `skipped` rather than looked at on every tick; one under a stop waits.
 */
export function claimDueRetrospective(ctx: StoreContext, now: string = isoNow()): DueRetrospective | null {
  if (!learningOn(ctx)) return null;
  if (retrospectSpendToday(ctx, now) >= RETRO_DAILY_USD) return null;
  const day = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  if (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM retrospectives WHERE state IN ('pending', 'done') AND created_at > ?").get(day)!.n >= RETRO_DAILY_COUNT) {
    return null;
  }
  const quietBefore = new Date(Date.parse(now) - RETRO_QUIET_MS).toISOString();
  const since = new Date(Date.parse(now) - RETRO_WITHIN_MS).toISOString();
  return ctx.commit(() => {
    ctx.db.run("UPDATE retrospectives SET state = 'failed', note = 'interrupted', finished_at = ? WHERE state = 'pending' AND created_at < ?",
      [now, new Date(Date.parse(now) - PENDING_STALE_MS).toISOString()]);
    // A routine's plan runs unattended by design and is approved by its gates: no delivery of yours to look back on.
    const plans = ctx.db.query<{ id: string; delivered_at: string }, [string, string]>(
      `SELECT id, delivered_at FROM tasks WHERE stage = 'delivered' AND delivered_at IS NOT NULL AND delivered_at <= ? AND delivered_at >= ?
         AND routine_id IS NULL ORDER BY delivered_at, rowid`).all(quietBefore, since);
    const skip = (taskId: string, botId: string, deliveredAt: string, note: string) =>
      ctx.db.run(`INSERT INTO retrospectives (id, task_id, bot_id, delivered_at, state, note, created_at, finished_at)
        VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?)`, [ulid(Date.parse(now)), taskId, botId, deliveredAt, note, now, now]);
    for (const plan of plans) {
      // The Bots that handed something over in it, the busiest first.
      const makers = ctx.db.query<{ bot_id: string }, [string, number]>(
        "SELECT bot_id FROM submissions WHERE task_id = ? GROUP BY bot_id ORDER BY COUNT(*) DESC, MIN(created_at) LIMIT ?").all(plan.id, BOTS_PER_DELIVERY);
      for (const { bot_id: botId } of makers) {
        if (ctx.db.query("SELECT 1 FROM retrospectives WHERE task_id = ? AND bot_id = ? AND delivered_at = ?").get(plan.id, botId, plan.delivered_at)) continue;
        const bot = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ? AND deleted_at IS NULL").get(botId);
        if (!bot) {
          skip(plan.id, botId, plan.delivered_at, "gone");
          continue;
        }
        // Under a stop it waits: it runs once the stop is lifted.
        if (holdsCovering(ctx, { botId, taskId: plan.id }).length > 0) continue;
        const looked = ctx.db.query<{ delivered_at: string }, [string, string]>(
          "SELECT delivered_at FROM retrospectives WHERE task_id = ? AND bot_id = ? AND state = 'done' ORDER BY delivered_at DESC LIMIT 1").get(plan.id, botId);
        const signals = troubleSignals(ctx, plan.id, botId, looked?.delivered_at ?? null);
        if (signals.length === 0) {
          skip(plan.id, botId, plan.delivered_at, "nothing_to_learn");
          continue;
        }
        const id = ulid(Date.parse(now));
        ctx.db.run(`INSERT INTO retrospectives (id, task_id, bot_id, delivered_at, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
          [id, plan.id, botId, plan.delivered_at, now]);
        return retrospectiveFacts(ctx, { id, taskId: plan.id, botId, botName: bot.name, deliveredAt: plan.delivered_at, signals, now });
      }
    }
    return null;
  });
}

/** The job's record, as the call reads it. */
export function retrospectiveFacts(ctx: StoreContext, input: { id: string; taskId: string; botId: string; botName: string; deliveredAt: string; signals: string[]; now?: string }): DueRetrospective {
  const { taskId, botId } = input;
  const plan = ctx.db.query<{ title: string; brief: string | null; kind: string | null; session_id: string | null }, [string]>(
    "SELECT title, brief, kind, session_id FROM tasks WHERE id = ?").get(taskId)!;
  const names = new Map(ctx.db.query<{ id: string; name: string }, []>("SELECT id, name FROM bots").all().map((row) => [row.id, row.name] as const));
  const who = (id: string | null) => (id === botId ? "you" : id ? names.get(id) ?? "a Bot" : "nobody");
  const tickets = ctx.db.query<{ id: string; title: string; stage: string | null; status: string; owner_bot_id: string | null; worker: string | null }, [string]>(
    "SELECT id, title, stage, status, owner_bot_id, worker FROM tickets WHERE task_id = ? ORDER BY seq").all(taskId);
  const handOverCount = new Map(ctx.db.query<{ ticket_id: string; n: number }, [string, string]>(
    "SELECT ticket_id, COUNT(*) AS n FROM submissions WHERE task_id = ? AND bot_id = ? GROUP BY ticket_id").all(taskId, botId).map((row) => [row.ticket_id, row.n] as const));
  const titles = new Map(tickets.map((ticket) => [ticket.id, ticket.title] as const));

  // Your words on the job, oldest first: the opening ask and every correction. A long job keeps its head and its latest lines.
  const quotes = ctx.db.query<{ created_at: string; via: string; body: string }, [string]>(
    "SELECT created_at, via, body FROM user_quotes WHERE task_id = ? AND redacted_at IS NULL AND length(trim(body)) > 0 ORDER BY created_at, rowid").all(taskId);
  const kept = quotes.length > 40 ? [...quotes.slice(0, 8), ...quotes.slice(-32)] : quotes;
  const yourWords = kept.map((row) => ({ at: row.created_at.slice(0, 16), via: row.via, text: clip(row.body, 300) }));

  // What you said with each send-back, by the hand-over it sent back.
  const sendBacks = new Map<string, string>();
  for (const row of ctx.db.query<{ payload: string }, [string, string]>(
    "SELECT payload FROM work_events WHERE task_id = ? AND kind = 'review.recorded' AND actor = ? ORDER BY seq").all(taskId, USER_MEMBER)) {
    const payload = parseJson<{ submission_id?: unknown; outcome?: unknown; note?: unknown }>(row.payload, {});
    if (payload.outcome === "reject" && typeof payload.submission_id === "string") sendBacks.set(payload.submission_id, typeof payload.note === "string" ? payload.note : "");
  }
  const submissions = ctx.db.query<{ id: string; ticket_id: string; bot_id: string; origin: string; state: string; note: string | null; content: string | null;
    checks: string; reviews: string; created_at: string }, [string]>(
    "SELECT id, ticket_id, bot_id, origin, state, note, content, checks, reviews, created_at FROM submissions WHERE task_id = ? ORDER BY created_at, rowid").all(taskId);
  const handOvers = submissions.slice(-24).map((row) => {
    const checks = parseJson<Array<{ item?: string; gate?: boolean; outcome?: string; detail?: string | null }>>(row.checks, []);
    const reviews = parseJson<Array<{ reviewer_bot_id?: string; outcome?: string; note?: string | null; verdicts?: Array<{ item?: string; verdict?: string }> }>>(row.reviews, []);
    const said = sendBacks.get(row.id);
    return {
      at: row.created_at.slice(0, 16),
      ticket: titles.get(row.ticket_id) ?? "",
      by: who(row.bot_id),
      // How it was handed over is part of what happened: the organizer reading a ticket as done is not a hand-over of files.
      state: row.origin === "organizer" ? `${row.state} (read as done by the organizer, nothing handed over)` : row.state,
      note: row.note ? clip(row.note, 300) : null,
      answer: row.origin === "answer" && row.content ? clip(row.content, 200) : null,
      checks_failed: checks.filter((check) => check.gate && (check.outcome === "fail" || check.outcome === "error"))
        .map((check) => clip(`${check.item ?? ""}${check.detail ? `: ${check.detail}` : ""}`, 160)),
      reviews: reviews.map((review) => clip(`${who(review.reviewer_bot_id ?? null)} ${review.outcome ?? "?"}${review.note ? `: ${review.note}` : ""}${
        (review.verdicts ?? []).filter((verdict) => verdict.verdict === "fail").map((verdict) => `; failed: ${verdict.item ?? ""}`).join("")}`, 240)),
      user_note: said === undefined ? null : clip(said, 300) || "(sent back without a word)",
    };
  });

  // A complaint you took back is not one.
  const undone = new Set(ctx.db.query<{ message_id: string | null }, [string]>(
    "SELECT json_extract(payload, '$.message_id') AS message_id FROM work_events WHERE task_id = ? AND kind = 'complaint.rework_undone'").all(taskId)
    .map((row) => row.message_id).filter((id): id is string => Boolean(id)));
  const complaints = ctx.db.query<{ at: string; message_id: string | null }, [string]>(
    "SELECT at, json_extract(payload, '$.message_id') AS message_id FROM work_events WHERE task_id = ? AND kind = 'complaint.rework' ORDER BY seq").all(taskId)
    .filter((row) => row.message_id && !undone.has(row.message_id))
    .map((row) => ({ at: row.at.slice(0, 16), text: clip(ctx.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(row.message_id!)?.body ?? "", 300) }))
    .filter((row) => row.text.length > 0);

  // The requirements said in this job or holding for it, with how often you said them and whether you only said them after a hand-over.
  const late = new Set(ctx.db.query<{ requirement_id: string }, [string]>(
    "SELECT requirement_id FROM quality_events WHERE task_id = ? AND kind = 'requirement_after_delivery' AND requirement_id IS NOT NULL").all(taskId)
    .map((row) => row.requirement_id));
  const requirements = ctx.db.query<{ id: string; seq: number | null; quote: string; restated: string | null; polarity: string; times_raised: number }, [string]>(
    `SELECT id, seq, quote, restated, polarity, times_raised FROM requirements r WHERE status = 'open' AND length(quote) > 0 AND (
       r.origin_task_id = ?1 OR (r.scope = 'plan' AND r.scope_id = ?1)
       OR (r.scope = 'ticket' AND r.scope_id IN (SELECT id FROM tickets WHERE task_id = ?1))
       OR (r.scope = 'part' AND r.scope_id IN (SELECT p.id FROM ticket_parts p JOIN tickets k ON k.id = p.ticket_id WHERE k.task_id = ?1)))
     ORDER BY seq, created_at LIMIT 40`).all(taskId)
    .map((row) => ({ n: row.seq ? `R-${row.seq}` : "", quote: clip(row.quote, 200), restated: row.restated ? clip(row.restated, 160) : null,
      must_not: row.polarity === "must_not", times_said: row.times_raised, first_said_after_a_hand_over: late.has(row.id) }));

  const quality = Object.fromEntries(ctx.db.query<{ kind: string; n: number }, [string, string]>(
    `SELECT kind, COUNT(*) AS n FROM quality_events WHERE task_id = ? AND bot_id = ? AND category <> 'orchestration' GROUP BY kind ORDER BY kind`).all(taskId, botId)
    .map((row) => [row.kind, row.n] as const));
  const failures = new Map<string, { tool: string; error: string; times: number }>();
  let turns = 0;
  for (const row of ctx.db.query<{ tool_failures: string | null }, [string, string]>(
    `SELECT d.tool_failures FROM turns t LEFT JOIN turn_route_decisions d ON d.turn_id = t.id WHERE t.task_id = ? AND t.bot_id = ?`).all(taskId, botId)) {
    turns += 1;
    for (const failure of parseJson<Array<{ tool?: string; error?: string }>>(row.tool_failures, [])) {
      const tool = clip(failure.tool ?? "", 40);
      const error = clip(failure.error ?? "", 140);
      const key = `${tool}\u0000${error}`;
      const seen = failures.get(key);
      if (seen) seen.times += 1;
      else failures.set(key, { tool, error, times: 1 });
    }
  }
  const countEvents = (kind: string) => ctx.db.query<{ n: number }, [string, string, string]>(
    "SELECT COUNT(*) AS n FROM work_events WHERE task_id = ? AND bot_id = ? AND kind = ?").get(taskId, botId, kind)!.n;

  const memories = ctx.db.query<MemoryRow, [string]>("SELECT * FROM memories WHERE bot_id = ? ORDER BY updated_at, id").all(botId);
  const on = memories.filter((row) => row.enabled === 1);
  const skills = ctx.db.query<SkillRow, [string]>("SELECT * FROM skills WHERE bot_id = ? ORDER BY updated_at DESC, id").all(botId);
  let budget = SKILL_BODY_BUDGET;
  const ownSkills = skills.filter((row) => row.enabled === 1).map((row) => {
    const size = codePointCount(row.body);
    const fits = size <= budget;
    if (fits) budget -= size;
    return { name: row.name, description: row.description, body: fits ? row.body : null };
  });
  const projectSkills = ctx.db.query<{ name: string; description: string }, []>("SELECT name, description FROM shared_skills WHERE enabled = 1 ORDER BY name").all()
    .map((row) => ({ name: row.name, description: clip(row.description, 200) }));
  const checklist = ctx.db.query<{ hook: string; text: string }, [string]>(
    "SELECT hook, text FROM lessons WHERE scope = 'bot' AND scope_id = ? AND action = 'checklist' AND status = 'active' ORDER BY confirmed_at, rowid LIMIT 12").all(botId)
    .map((row) => ({ moment: row.hook, text: row.text }));
  // This job's earlier delivery, or ones at least a day old: a conclusion written a minute ago on another job has not been put to any test yet.
  const settled = new Date(Date.parse(input.now ?? isoNow()) - 24 * 60 * 60_000).toISOString();
  const earlier = ctx.db.query<RetrospectiveRow & { plan: string | null }, [string, string, string, string]>(
    `SELECT r.*, t.title AS plan FROM retrospectives r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.bot_id = ? AND r.state = 'done' AND r.id <> ?
       AND (r.task_id = ? OR r.finished_at < ?)
     ORDER BY r.created_at DESC LIMIT 3`).all(botId, input.id, taskId, settled).reverse()
    .map((row) => ({ at: row.created_at.slice(0, 10), plan: row.plan ?? "", summary: row.summary,
      changes: parseJson<RetrospectiveChange[]>(row.changes, []).filter((change) => change.status !== "not_applied")
        .map((change) => ({ what: `${change.kind} ${change.op}`, label: change.label,
          // Taken back by you: you did not want it, and it should not come back as it was.
          status: change.status === "undone" ? "undone by the user" : "kept" })) }));

  return {
    id: input.id,
    taskId,
    botId,
    botName: input.botName,
    deliveredAt: input.deliveredAt,
    sessionId: plan.session_id,
    plan: { title: plan.title, brief: plan.brief ? clip(plan.brief, 400) : null, kind: plan.kind },
    tickets: tickets.map((ticket) => ({ title: ticket.title, stage: ticket.stage ?? ticket.status,
      yours: (ticket.owner_bot_id ?? ticket.worker) === botId, hand_overs: handOverCount.get(ticket.id) ?? 0 })),
    yourWords,
    handOvers,
    complaints,
    requirements,
    trouble: {
      quality,
      tool_failures: [...failures.values()].sort((a, b) => b.times - a.times).slice(0, 8),
      model_stepped_up: countEvents("model.escalated"),
      endings_sent_back: countEvents("end.rejected"),
      turns,
    },
    memories: on.map((row) => ({ subject: row.subject, body: row.body, updated_at: row.updated_at.slice(0, 10) })),
    memoriesOff: memories.filter((row) => row.enabled !== 1).map((row) => ({ subject: row.subject, body: row.body })),
    memoryRoom: Math.max(0, MEMORY_MAX_PER_BOT - on.length),
    skills: ownSkills,
    skillsOff: skills.filter((row) => row.enabled !== 1).map((row) => row.name),
    projectSkills,
    checklist,
    earlier,
    signals: input.signals,
  };
}

/**
 * What the retrospective concluded, read strictly: one JSON object, parsed whole. Anything that does
 * not parse is no answer at all — an answer cut off mid-way must not write half of what it meant.
 * Fields it got wrong are dropped one by one; the caps are applied when the changes are written.
 */
export function parseRetrospective(content: string): RetrospectiveOutcome | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw.summary !== "string" && !Array.isArray(raw.memory) && !Array.isArray(raw.skills)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const lines = (value: unknown) => (Array.isArray(value) ? value : []).map((item) => clip(text(item), LINE_MAX)).filter(Boolean).slice(0, FINDINGS_MAX);
  const list = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const earlier = list(raw.earlier).flatMap((item): RetrospectiveVerdict[] => {
    const verdict = item.verdict;
    const conclusion = clip(text(item.conclusion), LINE_MAX);
    return conclusion && (verdict === "held" || verdict === "recurred" || verdict === "obsolete") ? [{ conclusion, verdict }] : [];
  }).slice(0, FINDINGS_MAX);
  const memory = list(raw.memory).flatMap((item): RetrospectiveMemoryOp[] => {
    const why = clip(text(item.why), LINE_MAX);
    if (item.op === "remember") {
      const subject = text(item.subject);
      const body = text(item.body);
      if (!subject || !body) return [];
      const replaces = (Array.isArray(item.replaces) ? item.replaces : []).map(text).filter(Boolean).slice(0, 5);
      return [{ op: "remember", subject, body, replaces, why }];
    }
    if (item.op === "forget") {
      const subject = text(item.subject);
      return subject ? [{ op: "forget", subject, why }] : [];
    }
    return [];
  });
  const skills = list(raw.skills).flatMap((item): RetrospectiveSkillOp[] => {
    const why = clip(text(item.why), LINE_MAX);
    const name = text(item.name);
    if (!name) return [];
    if (item.op === "edit") {
      const edits = list(item.edits).flatMap((edit): RetrospectiveSkillEdit[] => {
        const after = typeof edit.after === "string" ? edit.after : "";
        const old = typeof edit.old === "string" ? edit.old : "";
        const added = typeof edit.add === "string" ? edit.add : typeof edit.new === "string" ? edit.new : "";
        if (after.length > 0) return added.trim() ? [{ kind: "insert", after, text: added }] : [];
        if (old.length > 0) return [{ kind: "replace", old, text: added }];
        return added.trim() ? [{ kind: "append", text: added }] : [];
      });
      const description = text(item.description) || null;
      return edits.length > 0 || description ? [{ op: "edit", name, description, edits, why }] : [];
    }
    if (item.op === "create") {
      const description = text(item.description);
      const body = text(item.body);
      return description && body ? [{ op: "create", name, description, body, why }] : [];
    }
    return [];
  });
  return {
    summary: clip(text(raw.summary), LINE_MAX),
    pitfalls: lines(raw.pitfalls),
    rework_causes: lines(raw.rework_causes),
    keep: lines(raw.keep),
    earlier,
    memory,
    skills,
  };
}

function memoryBySubject(ctx: StoreContext, botId: string, subject: string): MemoryRow | null {
  return ctx.db.query<MemoryRow, [string, string]>("SELECT * FROM memories WHERE bot_id = ? AND lower(subject) = lower(?) LIMIT 1").get(botId, subject.trim()) ?? null;
}

function skillByName(ctx: StoreContext, botId: string, name: string): SkillRow | null {
  return ctx.db.query<SkillRow, [string, string]>("SELECT * FROM skills WHERE bot_id = ? AND lower(name) = lower(?) LIMIT 1").get(botId, name.trim()) ?? null;
}

function projectSkillNamed(ctx: StoreContext, name: string): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM shared_skills WHERE lower(name) = lower(?)").get(name.trim()));
}

function enabledMemories(ctx: StoreContext, botId: string): number {
  return ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM memories WHERE bot_id = ? AND enabled = 1").get(botId)!.n;
}

/**
 * What a skill's procedure cannot lose without breaking: a name in backticks (a field, a command, a
 * parameter), a file name, a link, an environment variable. A passage rewritten for a better rule
 * still has to carry these over — on 2026-10-06's first real run a sharper 「配音」 step quietly
 * dropped `voice`, `shot`, `offset` and edl.json from the skill it improved.
 */
export function protectedTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // A name in backticks is kept as written, backticks and all: `voice` is not kept by voices.json.
  for (const match of text.matchAll(/`[^`\n]+`/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/[A-Za-z0-9_\-./]+\.(?:py|json|jsonl|md|mp4|mov|mp3|wav|m4a|srt|ass|txt|ts|js|sh|yaml|yml|toml|csv|png|jpe?g|webp|gif|pdf|html)\b/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/https?:\/\/[^\s)\]'"`，。；]+/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) tokens.add(match[0]);
  tokens.delete("");
  return tokens;
}

/** How many times `needle` occurs in `haystack`, not overlapping. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * A refusal while applying one change: it stops that change only, and says why on the board — as
 * a code the window words in your language (`RetrospectiveChange.reason`), not as English.
 */
class NotApplied extends Error {}

function why(error: unknown): string {
  if (error instanceof NotApplied) return error.message;
  // The memory and skill stores' own checks: a field too long, or missing.
  if (error instanceof HttpError) {
    const long = /^(\w+) must be at most/.exec(error.message);
    if (long) return `too_long:${long[1]}`;
    const missing = /^(\w+) is required/.exec(error.message);
    if (missing) return `required:${missing[1]}`;
  }
  return "refused";
}

/**
 * The retrospective's result: its findings kept, and its changes written one by one — each checked
 * the way the Bot's own memory and skill tools check them, each in a savepoint so one refused does
 * not take the others with it, each kept with what it replaced. A failed call (`outcome` null) is
 * recorded as such and not retried; it writes nothing.
 */
export function recordRetrospective(ctx: StoreContext, due: Pick<DueRetrospective, "id" | "taskId" | "botId" | "sessionId" | "skills">, outcome: RetrospectiveOutcome | null,
  opts: { model?: string | null; note?: string | null; raw?: string | null } = {}, now: string = isoNow()): Retrospective {
  return ctx.commit(() => {
    const raw = opts.raw ? opts.raw.slice(0, 20_000) : null;
    if (!outcome) {
      ctx.db.run("UPDATE retrospectives SET state = 'failed', model = ?, note = ?, raw = ?, finished_at = ? WHERE id = ?",
        [opts.model ?? null, opts.note ?? "call_failed", raw, now, due.id]);
      return getRetrospective(ctx, due.id);
    }
    const changes: RetrospectiveChange[] = [];
    // One change, inside its own savepoint: a refusal rolls back only what that change began.
    const attempt = (base: Omit<RetrospectiveChange, "status" | "target_id" | "before" | "after">, apply: () => { target_id: string | null; before: RetrospectiveSide | null; after: RetrospectiveSide | null; extra?: RetrospectiveChange[] }) => {
      ctx.db.run("SAVEPOINT retrospective_change");
      try {
        const done = apply();
        ctx.db.run("RELEASE retrospective_change");
        changes.push({ ...base, status: "applied", target_id: done.target_id, before: done.before, after: done.after }, ...(done.extra ?? []));
      } catch (error) {
        ctx.db.run("ROLLBACK TO retrospective_change");
        ctx.db.run("RELEASE retrospective_change");
        changes.push({ ...base, status: "not_applied", target_id: null, before: null, after: null, reason: why(error) });
      }
    };
    const forgets = outcome.memory.filter((op): op is Extract<RetrospectiveMemoryOp, { op: "forget" }> => op.op === "forget");
    const remembers = outcome.memory.filter((op): op is Extract<RetrospectiveMemoryOp, { op: "remember" }> => op.op === "remember");
    const forgetOne = (subject: string): { id: string; before: RetrospectiveSide } => {
      const row = memoryBySubject(ctx, due.botId, subject);
      if (!row) throw new NotApplied("missing");
      // One you turned off is yours: the Bot does not delete it behind you.
      if (row.enabled !== 1) throw new NotApplied("off");
      ctx.db.run("DELETE FROM memories WHERE id = ?", [row.id]);
      return { id: row.id, before: { subject: row.subject, body: row.body } };
    };
    // Forgets first: a merge or a correction frees the room the new conclusion needs.
    forgets.forEach((op, index) => {
      const base = { kind: "memory" as const, op: "forget" as const, label: clip(op.subject, 40), why: op.why };
      if (index >= RETRO_FORGET_MAX) {
        changes.push({ ...base, status: "not_applied", target_id: null, before: null, after: null, reason: "over_cap" });
        return;
      }
      attempt(base, () => {
        const gone = forgetOne(op.subject);
        return { target_id: gone.id, before: gone.before, after: null };
      });
    });
    remembers.forEach((op, index) => {
      const base = { kind: "memory" as const, op: "remember" as const, label: clip(op.subject, 40), why: op.why };
      if (index >= RETRO_REMEMBER_MAX) {
        changes.push({ ...base, status: "not_applied", target_id: null, before: null, after: null, reason: "over_cap" });
        return;
      }
      attempt(base, () => {
        const subject = parseMemorySubject(op.subject);
        const body = parseMemoryBody(op.body);
        const existing = memoryBySubject(ctx, due.botId, subject);
        if (existing && existing.enabled !== 1) throw new NotApplied("off");
        if (existing && existing.subject === subject && existing.body === body) throw new NotApplied("unchanged");
        // What it merges or corrects, other than itself: deleted once it is written.
        const merged = op.replaces.map((name) => memoryBySubject(ctx, due.botId, name))
          .filter((row): row is MemoryRow => Boolean(row) && row!.enabled === 1 && row!.id !== existing?.id)
          .filter((row, at, all) => all.findIndex((other) => other.id === row.id) === at);
        if (!existing && enabledMemories(ctx, due.botId) - merged.length + 1 > MEMORY_MAX_PER_BOT) throw new NotApplied("full");
        const extra: RetrospectiveChange[] = merged.map((row) => {
          ctx.db.run("DELETE FROM memories WHERE id = ?", [row.id]);
          return { kind: "memory", op: "forget", label: row.subject, target_id: row.id, before: { subject: row.subject, body: row.body }, after: null,
            why: `merged into "${subject}"`, status: "applied" };
        });
        if (existing) {
          ctx.db.run(`UPDATE memories SET subject = ?, body = ?, source_session_id = ?, source_message_id = NULL, learned_chain_id = NULL,
            retrospective_id = ?, updated_at = ? WHERE id = ?`, [subject, body, due.sessionId, due.id, now, existing.id]);
          return { target_id: existing.id, before: { subject: existing.subject, body: existing.body }, after: { subject, body }, extra };
        }
        if (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM memories WHERE bot_id = ?").get(due.botId)!.n >= MEMORY_ROWS_PER_BOT) throw new NotApplied("full");
        const id = ulid(Date.parse(now));
        ctx.db.run(`INSERT INTO memories (id, bot_id, subject, body, source_session_id, source_message_id, learned_chain_id, retrospective_id, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`, [id, due.botId, subject, body, due.sessionId, due.id, now, now]);
        return { target_id: id, before: null, after: { subject, body }, extra };
      });
    });
    let creates = 0;
    outcome.skills.forEach((op, index) => {
      const base = { kind: "skill" as const, op: op.op, label: clip(op.name, 64), why: op.why };
      if (index >= RETRO_SKILL_OPS_MAX || (op.op === "create" && creates >= 1)) {
        changes.push({ ...base, status: "not_applied", target_id: null, before: null, after: null, reason: "over_cap" });
        return;
      }
      if (op.op === "create") creates += 1;
      attempt(base, () => {
        if (op.op === "edit") {
          const row = skillByName(ctx, due.botId, op.name);
          // Another Bot's skill, shared with every Bot, is read here but never changed (ADR 0052).
          if (!row) throw new NotApplied(projectSkillNamed(ctx, op.name) ? "project_skill" : "missing");
          if (row.enabled !== 1) throw new NotApplied("off");
          // Past the reading budget the call never saw the body: it may add to its end, not rewrite what it did not read.
          const unread = !due.skills.some((skill) => skill.body !== null && skill.name.toLowerCase() === row.name.toLowerCase());
          let body = row.body;
          op.edits.forEach((edit, at) => {
            if (edit.kind === "append") {
              body = `${body.trimEnd()}\n\n${edit.text.trim()}`;
              return;
            }
            if (unread) throw new NotApplied(`edit_unread:${at + 1}`);
            const anchor = edit.kind === "insert" ? edit.after : edit.old;
            const found = occurrences(body, anchor);
            if (found !== 1) throw new NotApplied(found === 0 ? `edit_missing:${at + 1}` : `edit_repeated:${at + 1}:${found}`);
            if (edit.kind === "insert") {
              const end = body.indexOf(anchor) + anchor.length;
              // Two words of Latin script run together without a space between them; Chinese does not need one.
              const joiner = /[A-Za-z0-9.,;:!?)]$/.test(anchor) && /^[A-Za-z0-9(]/.test(edit.text) ? " " : "";
              body = `${body.slice(0, end)}${joiner}${edit.text}${body.slice(end)}`;
              return;
            }
            // A correction is one sentence: more than that, and what the rewrite leaves out is lost without a word.
            const sentence = edit.old.trim();
            if (/\n/.test(sentence) || /[。！？；!?]/.test(sentence.slice(0, -1)) || codePointCount(sentence) > 200) {
              throw new NotApplied(`edit_not_one_sentence:${at + 1}`);
            }
            body = body.replace(edit.old, () => edit.text);
          });
          // What a rewritten passage dropped that the skill no longer says anywhere: refused, the whole change with it.
          const lost = [...protectedTokens(row.body)].filter((token) => !body.includes(token));
          if (lost.length > 0) throw new NotApplied(`drops:${lost.slice(0, 6).join(" ")}`);
          const description = op.description ? parseSkillDescription(op.description) : row.description;
          body = parseSkillBody(body);
          if (body === row.body && description === row.description) throw new NotApplied("unchanged");
          ctx.db.run("UPDATE skills SET body = ?, description = ?, learned_chain_id = NULL, retrospective_id = ?, updated_at = ? WHERE id = ?",
            [body, description, due.id, now, row.id]);
          return { target_id: row.id, before: { name: row.name, description: row.description, body: row.body }, after: { name: row.name, description, body } };
        }
        const name = parseSkillName(op.name);
        if (skillByName(ctx, due.botId, name)) throw new NotApplied("name_taken");
        // Its own skill of that name would stand in front of the shared one for it alone.
        if (projectSkillNamed(ctx, name)) throw new NotApplied("project_name");
        if (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM skills WHERE bot_id = ?").get(due.botId)!.n >= SKILL_MAX_PER_BOT) throw new NotApplied("full");
        if (codePointCount(op.body) > CREATED_SKILL_MAX) throw new NotApplied("too_long:body");
        const description = parseSkillDescription(op.description);
        const body = parseSkillBody(op.body);
        const id = ulid(Date.parse(now));
        ctx.db.run(`INSERT INTO skills (id, bot_id, name, description, body, uses, enabled, retrospective_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)`, [id, due.botId, name, description, body, due.id, now, now]);
        return { target_id: id, before: null, after: { name, description, body } };
      });
    });
    const applied = changes.filter((change) => change.status === "applied").length;
    ctx.db.run(`UPDATE retrospectives SET state = 'done', model = ?, summary = ?, findings = ?, changes = ?, note = ?, raw = ?, finished_at = ? WHERE id = ?`, [
      opts.model ?? null, outcome.summary || null,
      JSON.stringify({ pitfalls: outcome.pitfalls, rework_causes: outcome.rework_causes, keep: outcome.keep, earlier: outcome.earlier }),
      JSON.stringify(changes), applied === 0 ? "nothing_changed" : null, raw, now, due.id]);
    recordWorkEvent(ctx, { kind: "retrospective.done", actor: due.botId, botId: due.botId, taskId: due.taskId,
      payload: { retrospective_id: due.id, applied, not_applied: changes.length - applied } });
    return getRetrospective(ctx, due.id);
  });
}

function sameSide(current: { subject?: string; name?: string; description?: string; body: string }, side: RetrospectiveSide | null): boolean {
  if (!side) return false;
  return current.body === side.body && (side.subject === undefined || current.subject === side.subject)
    && (side.description === undefined || current.description === side.description);
}

/**
 * Your 撤销 on one change, from the board: puts back what it replaced — but only while what it
 * wrote is still there as it wrote it. One changed since (by you, or by the Bot in a turn) is not
 * undone behind that change: 409.
 */
export function undoRetrospectiveChange(ctx: StoreContext, id: string, index: number, now: string = isoNow()): Retrospective {
  return ctx.commit(() => {
    const row = ctx.db.query<RetrospectiveRow, [string]>("SELECT * FROM retrospectives WHERE id = ?").get(id);
    if (!row) throw new HttpError(404, "not_found", "retrospective not found");
    const changes = parseJson<RetrospectiveChange[]>(row.changes, []);
    const change = Number.isInteger(index) ? changes[index] : undefined;
    if (!change) throw new HttpError(404, "not_found", "no such change");
    if (change.status !== "applied") throw new HttpError(409, "conflict", change.status === "undone" ? "already undone" : "this change was not made");
    const changedSince = () => new HttpError(409, "conflict", "changed since the retrospective made it");
    if (change.kind === "memory") {
      if (change.op === "forget") {
        const before = change.before;
        if (!before?.subject) throw changedSince();
        if (memoryBySubject(ctx, row.bot_id, before.subject)) throw new HttpError(409, "conflict", "a memory with that subject is there again");
        if (enabledMemories(ctx, row.bot_id) >= MEMORY_MAX_PER_BOT) throw new HttpError(422, "failed", `a bot can have at most ${MEMORY_MAX_PER_BOT} memories`);
        ctx.db.run(`INSERT INTO memories (id, bot_id, subject, body, source_session_id, source_message_id, learned_chain_id, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)`, [change.target_id ?? ulid(Date.parse(now)), row.bot_id, before.subject, before.body, now, now]);
      } else {
        const current = change.target_id ? ctx.db.query<MemoryRow, [string]>("SELECT * FROM memories WHERE id = ?").get(change.target_id) : null;
        if (!current || !sameSide(current, change.after)) throw changedSince();
        if (!change.before) ctx.db.run("DELETE FROM memories WHERE id = ?", [current.id]);
        else ctx.db.run("UPDATE memories SET subject = ?, body = ?, retrospective_id = NULL, updated_at = ? WHERE id = ?",
          [change.before.subject ?? current.subject, change.before.body, now, current.id]);
      }
    } else {
      const current = change.target_id ? ctx.db.query<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?").get(change.target_id) : null;
      if (!current || !sameSide(current, change.after)) throw changedSince();
      if (change.op === "create" || !change.before) ctx.db.run("DELETE FROM skills WHERE id = ?", [current.id]);
      else ctx.db.run("UPDATE skills SET body = ?, description = ?, retrospective_id = NULL, updated_at = ? WHERE id = ?",
        [change.before.body, change.before.description ?? current.description, now, current.id]);
    }
    changes[index] = { ...change, status: "undone", undone_at: now };
    ctx.db.run("UPDATE retrospectives SET changes = ? WHERE id = ?", [JSON.stringify(changes), id]);
    recordWorkEvent(ctx, { kind: "retrospective.undone", actor: USER_MEMBER, botId: row.bot_id, taskId: row.task_id,
      payload: { retrospective_id: id, index, kind: change.kind, op: change.op, label: change.label } });
    return getRetrospective(ctx, id);
  });
}
