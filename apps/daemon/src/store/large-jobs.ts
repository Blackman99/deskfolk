/**
 * 大活 (large jobs, ADR 0060): a job too big to make well in one go is laid out before anything is
 * made — its units as tickets, one of them the sample, made first to the full standard — and the
 * sample is yours to approve before the rest start. Each later ticket's hand-over is then compared
 * with the sample (a standard check, 照样片), and the job's last hand-over is yours again. On
 * 2026-10-04 a 20-minute episode went as one ticket through nine segments and came back as 90% still
 * pictures under camera moves: nothing had asked for a first unit to look at, and the only checks
 * measured what was easy (length, loudness).
 *
 * This module is what that rests on: the plan's size as read (by the reader from your words, by the
 * signal of work going round on it with nothing through, or by you), its sample, what a ticket waits
 * for, the refusals a segment meets before the layout and on a ticket still waiting, the sample's
 * standard checks, and the sums the sample's card shows. From engine level 5, where tickets have
 * stages and `plan_items` exists.
 */
import type { PlanScale } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { patchTicket, ticketDependencies } from "./tickets";
import { recordWorkEvent } from "./work-events";

/** Work segments on a job that is not laid out, with nothing of it approved, before the signal asks whether it is a large one. */
export const SIGNAL_SEGMENTS = 3;

/** A ticket's stage as level 5 reads it (`STAGE_SQL` in submissions.ts, kept here so this module stands alone). */
const STAGE = (alias: string) => `COALESCE(${alias}.stage, CASE ${alias}.status WHEN 'todo' THEN 'todo' WHEN 'doing' THEN 'doing'
  WHEN 'review' THEN 'submitted' WHEN 'done' THEN 'approved' ELSE 'dropped' END)`;

const WHY_MAX = 200;
const UNIT_MAX = 24;

function on(ctx: StoreContext): boolean {
  return readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions;
}

function en(ctx: StoreContext): boolean {
  return settingsCached(ctx).locale === "en";
}

function clip(text: string | null | undefined, max: number): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const cut = takeCodePoints(trimmed, max);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

function nn(seq: number): string {
  return String(seq).padStart(2, "0");
}

type ScaleRow = { scale: "large" | "single" | null; scale_by: string | null; scale_at: string | null; scale_why: string | null; scale_unit: string | null };

/** The plan's size as the app goes by it; null when nothing has read it as either. */
export function planScale(ctx: StoreContext, taskId: string): PlanScale | null {
  const row = ctx.db.query<ScaleRow, [string]>("SELECT scale, scale_by, scale_at, scale_why, scale_unit FROM tasks WHERE id = ?").get(taskId);
  if (!row?.scale) return null;
  const by = row.scale_by === "signal" || row.scale_by === "user" ? row.scale_by : "reader";
  return { value: row.scale, by, at: row.scale_at ?? "", why: row.scale_why, unit: row.scale_unit };
}

/**
 * Writes down what a plan's size was read as. A reading (the reader's or the signal's) only ever
 * finds an unread plan large, once: it never takes back yours, never makes a plan single, and a
 * second reading changes nothing. Yours stands over theirs either way, and is the only way back to
 * single. Returns whether anything changed.
 */
export function markPlanScale(ctx: StoreContext, input: {
  taskId: string; value: "large" | "single"; by: PlanScale["by"]; why?: string | null; unit?: string | null; now?: string;
}): boolean {
  return ctx.commit(() => {
    const current = planScale(ctx, input.taskId);
    if (input.by !== "user") {
      if (input.value !== "large" || current) return false;
    } else if (current?.by === "user" && current.value === input.value) return false;
    const now = input.now ?? isoNow();
    const why = clip(input.why, WHY_MAX);
    const unit = clip(input.unit, UNIT_MAX);
    ctx.db.run("UPDATE tasks SET scale = ?, scale_by = ?, scale_at = ?, scale_why = ?, scale_unit = ? WHERE id = ?",
      [input.value, input.by, now, why, unit ?? (input.by === "user" ? current?.unit ?? null : null), input.taskId]);
    recordWorkEvent(ctx, { kind: "plan.scale", actor: input.by === "user" ? "user" : "app", taskId: input.taskId,
      payload: { value: input.value, by: input.by, why, unit } });
    return true;
  });
}

type SampleRow = { id: string; seq: number; title: string; stage: string };

/** The plan's sample (样片): the ticket laid out with `sample: true`, unless dropped. */
export function sampleOf(ctx: StoreContext, taskId: string): SampleRow | null {
  return ctx.db.query<SampleRow, [string]>(`SELECT t.id, t.seq, t.title, ${STAGE("t")} AS stage FROM tickets t
    WHERE t.task_id = ? AND t.sample = 1 AND ${STAGE("t")} <> 'dropped' ORDER BY t.seq LIMIT 1`).get(taskId) ?? null;
}

/** The tickets of a plan that wait for `ticketId`, dropped ones aside. */
function waitingFor(ctx: StoreContext, taskId: string, ticketId: string): Array<{ id: string; seq: number; title: string; stage: string }> {
  return ctx.db.query<{ id: string; seq: number; title: string; stage: string }, [string, string]>(`SELECT t.id, t.seq, t.title, ${STAGE("t")} AS stage
    FROM tickets t WHERE t.task_id = ?1 AND t.id <> ?2 AND ${STAGE("t")} <> 'dropped' AND json_valid(t.depends_on)
      AND EXISTS (SELECT 1 FROM json_each(t.depends_on) d WHERE d.value = ?2) ORDER BY t.seq`).all(taskId, ticketId);
}

/**
 * A large plan not laid out yet: active, not a routine's, and with no sample that anything waits
 * for. Until it is, a segment on it is refused generating anything outside or handing anything over.
 */
export function layoutMissing(ctx: StoreContext, taskId: string): boolean {
  if (!on(ctx)) return false;
  const plan = ctx.db.query<{ status: string; stage: string | null; routine_id: string | null; scale: string | null }, [string]>(
    "SELECT status, stage, routine_id, scale FROM tasks WHERE id = ?").get(taskId);
  if (!plan || plan.scale !== "large" || plan.routine_id || plan.status !== "active" || (plan.stage !== null && plan.stage !== "active")) return false;
  const sample = sampleOf(ctx, taskId);
  return !sample || waitingFor(ctx, taskId, sample.id).length === 0;
}

export type Waited = { id: string; seq: number; title: string; sample: boolean };

/**
 * The first ticket this one waits for that is not through: the sample until it is approved; any
 * other until it was handed over (submitted, in review, approved, or back in rework after a
 * hand-over) — waiting for every approval would hold each next ticket on your card. A dropped or
 * parked ticket never holds anything: set aside, it would never come. Null when nothing holds it.
 */
export function waitingOn(ctx: StoreContext, ticketId: string): Waited | null {
  if (!on(ctx)) return null;
  const row = ctx.db.query<{ task_id: string; depends_on: string }, [string]>("SELECT task_id, depends_on FROM tickets WHERE id = ?").get(ticketId);
  if (!row) return null;
  for (const id of ticketDependencies(row.depends_on)) {
    const dep = ctx.db.query<{ id: string; seq: number; title: string; sample: number; stage: string }, [string, string]>(
      `SELECT t.id, t.seq, t.title, t.sample, ${STAGE("t")} AS stage FROM tickets t WHERE t.id = ? AND t.task_id = ?`).get(id, row.task_id);
    if (!dep) continue;
    const through = dep.stage === "approved" || dep.stage === "dropped"
      || (dep.sample !== 1 && (dep.stage === "submitted" || dep.stage === "in_review" || dep.stage === "rework"));
    if (!through) return { id: dep.id, seq: dep.seq, title: dep.title, sample: dep.sample === 1 };
  }
  return null;
}

export type LargeJobRefusal = { code: "layout_first" | "waits_for"; message: string };

/**
 * What a segment is refused, before it generates anything through a server (an MCP call with side
 * effects) or hands anything over: on a large job not laid out yet, the layout; on a ticket still
 * waiting, the ticket it waits for. Reading, writing notes and scripts and running local commands go
 * on. Null when nothing is refused.
 */
export function largeJobRefusal(ctx: StoreContext, turnId: string): LargeJobRefusal | null {
  if (!on(ctx)) return null;
  const turn = ctx.db.query<{ task_id: string | null; ticket_id: string | null }, [string]>("SELECT task_id, ticket_id FROM turns WHERE id = ?").get(turnId);
  if (!turn?.task_id) return null;
  if (layoutMissing(ctx, turn.task_id)) {
    const scale = planScale(ctx, turn.task_id);
    const sample = sampleOf(ctx, turn.task_id);
    return { code: "layout_first", message: `this job is a large one${scale?.why ? ` (from the user's words: 「${scale.why}」)` : ""}. `
      + (sample
        ? `Its sample, ticket #${nn(sample.seq)} "${sample.title}", has nothing waiting for it yet: the plan's lead lays out the rest of the units with plan_items. `
        : `Before anything is generated or handed over, the plan's lead lays it out with plan_items: the units${scale?.unit ? ` (${scale.unit} each)` : ""}, `
          + "one of them marked sample: true — made first, to the full standard, for the user to approve — the rest waiting for it, and the last one putting them together. ")
      + "Reading files, writing notes and scripts and running local commands go on as usual; if you are not the lead, end your turn saying so." };
  }
  if (turn.ticket_id) {
    const dep = waitingOn(ctx, turn.ticket_id);
    if (dep) {
      return { code: "waits_for", message: dep.sample
        ? `this ticket waits for the sample, ticket #${nn(dep.seq)} "${dep.title}", which the user has not approved yet: nothing is generated or handed over on it until they do. Work on the sample, or end your turn.`
        : `this ticket waits for ticket #${nn(dep.seq)} "${dep.title}", which has not been handed over yet: nothing is generated or handed over on it until it is. Work on that one, or end your turn.` };
    }
  }
  return null;
}

/**
 * Lays the rest of a plan out behind its sample: every ticket that is not the sample, not something
 * the sample itself waits for (however far back), and not through, waits for it. Tickets laid out
 * later are put behind it the same way. Returns the tickets that now wait for it.
 */
export function waitOnSample(ctx: StoreContext, taskId: string, now: string = isoNow()): string[] {
  const sample = sampleOf(ctx, taskId);
  if (!sample) return [];
  const tickets = ctx.db.query<{ id: string; depends_on: string; stage: string }, [string]>(
    `SELECT t.id, t.depends_on, ${STAGE("t")} AS stage FROM tickets t WHERE t.task_id = ?`).all(taskId);
  const deps = new Map(tickets.map((ticket) => [ticket.id, ticketDependencies(ticket.depends_on)] as const));
  const before = new Set<string>();
  const stack = [...(deps.get(sample.id) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (before.has(id)) continue;
    before.add(id);
    stack.push(...(deps.get(id) ?? []));
  }
  const changed: string[] = [];
  for (const ticket of tickets) {
    if (ticket.id === sample.id || before.has(ticket.id) || ticket.stage === "dropped" || ticket.stage === "approved") continue;
    const current = deps.get(ticket.id) ?? [];
    if (current.includes(sample.id)) continue;
    patchTicket(ctx, ticket.id, { dependsOn: [...current, sample.id] }, { now: new Date(now) });
    changed.push(ticket.id);
  }
  return changed;
}

/**
 * Once the sample is approved, each ticket waiting for it is held to it: a standard check (照样片)
 * on the ticket, which compares what it hands over with the sample's approved hand-over. Made by the
 * app from your approval, so it is yours (`source = 'user'`, `origin = 'sample'`); you can delete one
 * on the board like any check. Returns the checks made.
 */
export function syncStandardChecks(ctx: StoreContext, taskId: string, now: string = isoNow()): string[] {
  const sample = sampleOf(ctx, taskId);
  if (!sample || sample.stage !== "approved") return [];
  const made: string[] = [];
  for (const unit of waitingFor(ctx, taskId, sample.id)) {
    if (unit.stage === "approved") continue;
    // One per ticket and sample, ever: one you deleted stays deleted.
    if (ctx.db.query("SELECT 1 FROM acceptance_checks WHERE ticket_id = ? AND standard_of = ?").get(unit.id, sample.id)) continue;
    const id = ulid(Date.parse(now));
    const item = en(ctx) ? `Holds to the standard of sample #${nn(sample.seq)} "${sample.title}"` : `达到样片 #${nn(sample.seq)}「${sample.title}」的水准`;
    ctx.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, negate, source, created_at, updated_at, defined_at, origin, standard_of)
      VALUES (?, ?, ?, ?, 'continuity', 0, 'user', ?, ?, ?, 'sample', ?)`, [id, taskId, unit.id, item, now, now, now, sample.id]);
    made.push(id);
  }
  if (made.length > 0) recordWorkEvent(ctx, { kind: "plan.standard_checks", actor: "app", taskId, ticketId: sample.id, payload: { checks: made } });
  return made;
}

/**
 * Whose approval a hand-over of this ticket needs in a large job, past any reviewer: yours, when it
 * is the sample (the standard is yours to set), or when it is the last ticket of a laid-out large
 * job left to approve (approving it delivers the job). Null otherwise.
 */
export function yoursToApprove(ctx: StoreContext, ticketId: string): "sample" | "last" | null {
  if (!on(ctx)) return null;
  const ticket = ctx.db.query<{ task_id: string; sample: number }, [string]>("SELECT task_id, sample FROM tickets WHERE id = ?").get(ticketId);
  if (!ticket) return null;
  const plan = ctx.db.query<{ scale: string | null; routine_id: string | null }, [string]>("SELECT scale, routine_id FROM tasks WHERE id = ?").get(ticket.task_id);
  if (!plan || plan.routine_id) return null;
  if (ticket.sample === 1) return "sample";
  if (plan.scale !== "large" || !sampleOf(ctx, ticket.task_id)) return null;
  const others = ctx.db.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM tickets t WHERE t.task_id = ? AND t.id <> ?
    AND ${STAGE("t")} NOT IN ('approved', 'dropped')`).get(ticket.task_id, ticketId)!.n;
  return others === 0 ? "last" : null;
}

export type SampleSums = {
  /** Minutes of work segments on the sample. */
  minutes: number;
  segments: number;
  /** Model spend on the sample, in USD; external services (images, video) are not in it. Null when no row carries a cost (an endpoint that reports none). */
  modelUsd: number | null;
  /** Calls with side effects to an MCP server (generating images or video, say): their cost is the server's to say. */
  externalCalls: number;
  /** Tickets waiting for the sample, not through. */
  remaining: number;
};

/** What the sample took, for its card: the sums of its segments, and how many tickets wait for it. */
export function sampleSums(ctx: StoreContext, sampleId: string): SampleSums {
  const ticket = ctx.db.query<{ task_id: string }, [string]>("SELECT task_id FROM tickets WHERE id = ?").get(sampleId);
  const segments = ctx.db.query<{ created_at: string; updated_at: string }, [string]>(`SELECT created_at, updated_at FROM turns
    WHERE ticket_id = ? AND IFNULL(mode, 'work') <> 'readonly'`).all(sampleId);
  const ms = segments.reduce((sum, row) => sum + Math.max(0, Date.parse(row.updated_at) - Date.parse(row.created_at)), 0);
  const usd = ctx.db.query<{ usd: number | null }, [string]>(`SELECT SUM(COALESCE(sp.cost_usd_ticks, sp.estimated_cost_usd_ticks)) / 1e10 AS usd
    FROM spend sp JOIN turns t ON t.id = sp.turn_id WHERE t.ticket_id = ?`).get(sampleId)?.usd ?? null;
  const external = ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tool_executions WHERE ticket_id = ? AND side_effect = 1
    AND tool LIKE 'mcp\\_%' ESCAPE '\\' AND outcome = 'succeeded'`).get(sampleId)!.n;
  const remaining = ticket ? waitingFor(ctx, ticket.task_id, sampleId).filter((row) => row.stage !== "approved").length : 0;
  return { minutes: Math.round(ms / 60_000), segments: segments.length, modelUsd: usd, externalCalls: external, remaining };
}

/** The sample card's lines on what it took and what the rest would, at that size. */
export function sampleSumsLines(sums: SampleSums, locale: "zh" | "en"): string {
  const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`;
  // An endpoint that reports no cost leaves the model's share unsaid rather than "$0.00".
  const cost = sums.modelUsd !== null && sums.modelUsd > 0 ? sums.modelUsd : null;
  const k = sums.remaining;
  if (locale === "en") {
    const took = `The sample took about ${sums.minutes} min of work (${sums.segments} segment${sums.segments === 1 ? "" : "s"})`
      + (cost !== null ? `, ${usd(cost)} of model use` : "")
      + (sums.externalCalls > 0 ? ` and ${sums.externalCalls} generating call${sums.externalCalls === 1 ? "" : "s"} (images, video and the like — their cost is the service's)` : "") + ".";
    return k > 0
      ? `${took} At that size the other ${k} would take about ${sums.minutes * k} min${cost !== null ? ` and ${usd(cost * k)}` : ""}${sums.externalCalls > 0 ? `, with about ${sums.externalCalls * k} generating calls` : ""}.`
      : took;
  }
  const took = `样片做了约 ${sums.minutes} 分钟（${sums.segments} 段）`
    + (cost !== null ? `、模型费约 ${usd(cost)}` : "")
    + (sums.externalCalls > 0 ? `、出图出视频这类外部调用 ${sums.externalCalls} 次（费用以各服务为准）` : "") + "。";
  return k > 0
    ? `${took}按样片的规模粗算，剩下 ${k} 件约 ${sums.minutes * k} 分钟${cost !== null ? `、模型费约 ${usd(cost * k)}` : ""}${sums.externalCalls > 0 ? `、外部调用约 ${sums.externalCalls * k} 次` : ""}。`
    : took;
}

/**
 * The signal (运行信号): a job not read either way, not laid out, with at least
 * {@link SIGNAL_SEGMENTS} work segments ended on it and nothing of it approved yet — work going round
 * on it with nothing through. The reader is then asked once more, with these facts beside your words.
 */
export function signalFacts(ctx: StoreContext, taskId: string): { segments: number; handedBack: number } | null {
  if (!on(ctx) || planScale(ctx, taskId)) return null;
  const plan = ctx.db.query<{ status: string; routine_id: string | null }, [string]>("SELECT status, routine_id FROM tasks WHERE id = ?").get(taskId);
  if (!plan || plan.status !== "active" || plan.routine_id || sampleOf(ctx, taskId)) return null;
  if (ctx.db.query(`SELECT 1 FROM tickets t WHERE t.task_id = ? AND ${STAGE("t")} = 'approved'`).get(taskId)) return null;
  const segments = ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM turns WHERE task_id = ? AND work_item_id IS NOT NULL
    AND IFNULL(mode, 'work') = 'work' AND status IN ('completed', 'interrupted', 'stopped')`).get(taskId)!.n;
  if (segments < SIGNAL_SEGMENTS) return null;
  const handedBack = ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND state IN ('rejected', 'checks_failed')").get(taskId)!.n;
  return { segments, handedBack };
}

/**
 * What a standard check compares: the sample's approved hand-over (its newest) and the ticket's
 * newest hand-over not superseded or sent back by its checks. Null when the check is no standard
 * check or the sample has nothing approved; `current` null when the ticket has handed nothing over.
 */
export function standardSides(ctx: StoreContext, checkId: string): { sample: { label: string; paths: string[] }; current: { label: string; paths: string[] } | null } | null {
  const check = ctx.db.query<{ ticket_id: string | null; standard_of: string | null }, [string]>(
    "SELECT ticket_id, standard_of FROM acceptance_checks WHERE id = ?").get(checkId);
  if (!check?.standard_of || !check.ticket_id) return null;
  const label = (ticketId: string) => {
    const row = ctx.db.query<{ seq: number; title: string }, [string]>("SELECT seq, title FROM tickets WHERE id = ?").get(ticketId);
    return row ? `#${nn(row.seq)} ${row.title}` : ticketId;
  };
  const paths = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as Array<{ path?: unknown }>;
      return Array.isArray(parsed) ? parsed.flatMap((entry) => typeof entry?.path === "string" ? [entry.path] : []) : [];
    } catch {
      return [];
    }
  };
  const sample = ctx.db.query<{ artifacts: string }, [string]>(`SELECT artifacts FROM submissions WHERE ticket_id = ? AND state = 'approved'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(check.standard_of);
  if (!sample) return null;
  const current = ctx.db.query<{ artifacts: string }, [string]>(`SELECT artifacts FROM submissions WHERE ticket_id = ?
    AND state IN ('checking', 'submitted', 'in_review', 'approved') AND artifacts <> '[]' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(check.ticket_id);
  return { sample: { label: label(check.standard_of), paths: paths(sample.artifacts) },
    current: current ? { label: label(check.ticket_id), paths: paths(current.artifacts) } : null };
}

/**
 * What a reading of a job's size reads: its name and goal, your words about it (your lines, your
 * answers to its questions, what you wrote on its board) oldest first, and its conversation for the
 * spend. Null for a plan large jobs do not apply to: below level 5, a routine's, not active, or
 * already read either way.
 */
export function scaleInputs(ctx: StoreContext, taskId: string): { title: string; goal: string | null; said: string[]; sessionId: string | null } | null {
  if (!on(ctx) || planScale(ctx, taskId)) return null;
  const plan = ctx.db.query<{ title: string; spec: string | null; session_id: string | null; status: string; routine_id: string | null }, [string]>(
    "SELECT title, spec, session_id, status, routine_id FROM tasks WHERE id = ?").get(taskId);
  if (!plan || plan.status !== "active" || plan.routine_id) return null;
  let goal: string | null = null;
  try {
    const spec = plan.spec ? JSON.parse(plan.spec) as { goal?: unknown } : null;
    goal = typeof spec?.goal === "string" && spec.goal.trim() ? spec.goal.trim() : null;
  } catch {
    goal = null;
  }
  const said = ctx.db.query<{ body: string }, [string]>(`SELECT body FROM user_quotes WHERE task_id = ? AND redacted_at IS NULL
    AND via IN ('message', 'ask_answer', 'board') ORDER BY created_at, id`).all(taskId).map((row) => row.body);
  return { title: plan.title, goal, said, sessionId: plan.session_id };
}

/** Active plans the signal may ask about now (see {@link signalFacts}). */
export function signalledPlans(ctx: StoreContext): Array<{ taskId: string; segments: number; handedBack: number }> {
  if (!on(ctx)) return [];
  return ctx.db.query<{ id: string }, []>(`SELECT id FROM tasks WHERE status = 'active' AND scale IS NULL AND routine_id IS NULL
    AND dormant_since IS NULL`).all().flatMap((row) => {
    const facts = signalFacts(ctx, row.id);
    return facts ? [{ taskId: row.id, ...facts }] : [];
  });
}
