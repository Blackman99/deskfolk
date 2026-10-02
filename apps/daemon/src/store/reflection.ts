/**
 * The narrowed reflection (ADR 0051, engine level 8): after an approval you overturned (a review
 * miss) or a part stuck at the capability ceiling — and only then — the Bot involved, on its own
 * model, reads what happened to the ticket (its work log, the requirements, the review verdicts; not
 * the transcript) and may propose one of two things: a checklist item for itself at one moment
 * (before reviewing, before handing over, before generating), or a check for the ticket. Either
 * waits on you: a card in the plan's conversation, [采用] [不要]. Nothing it proposes takes effect
 * before you adopt it, and it writes no memory.
 *
 * When is decided by the store, not a model: the scheduler's tick claims the oldest quality event of
 * those two kinds with no reflection yet — at most one per Bot and ticket a day, none under a stop
 * over the Bot or the plan, none once the day's reflections spent {@link REFLECT_DAILY_USD}.
 */
import type { Database } from "bun:sqlite";
import { USER_MEMBER, type AcceptanceCheckInput, type Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { createCheckByUser } from "./acceptance-checks";
import { holdsCovering } from "./holds";
import type { Lesson } from "./lessons";
import { getLesson } from "./lessons";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { learningOn } from "./quality";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** The day's reflections stop once they cost this much (spend purpose `reflect`). */
export const REFLECT_DAILY_USD = 2;
/** A Bot reflects on a ticket at most once in this long. */
const REFLECT_GAP_MS = 24 * 60 * 60_000;
/** An event older than this is not reflected on any more. */
const REFLECT_WITHIN_MS = 7 * 24 * 60 * 60_000;
/** At most this many reflections a day, whatever they cost (a model with no price would never reach the cap in money). */
export const REFLECT_DAILY_COUNT = 20;
/** A claimed reflection still pending after this long was cut off (a restart mid-call): it is failed, not left to block its ticket. */
const PENDING_STALE_MS = 10 * 60_000;

export const REFLECTIONS_SQL = `CREATE TABLE IF NOT EXISTS reflections (
  quality_event_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  ticket_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'skipped', 'failed')),
  lesson_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
)`;

export function migrateReflections(db: Database): void {
  db.run(REFLECTIONS_SQL);
  db.run("CREATE INDEX IF NOT EXISTS reflections_by_bot_ticket ON reflections(bot_id, ticket_id, created_at)");
}

export type ReflectionHook = "before_review" | "before_submit" | "before_generate";
export const REFLECTION_HOOKS: readonly ReflectionHook[] = ["before_review", "before_submit", "before_generate"];
/** The kinds of check a reflection may propose: the ones you could write on the board yourself. */
/** A command is not one: it would run on your machine at every hand-over, on words a model wrote (ADR 0051). */
export const PROPOSABLE_CHECKS = ["exists", "contains", "matches"] as const;

export type ReflectionOutcome =
  | { kind: "checklist"; hook: ReflectionHook; text: string }
  | { kind: "check"; check: AcceptanceCheckInput }
  | { kind: "none"; reason: string };

export type DueReflection = {
  qualityEventId: string;
  event: "review_miss" | "ceiling";
  botId: string;
  botName: string;
  model: string | null;
  taskId: string;
  ticketId: string;
  ticketTitle: string;
  ticketDir: string;
  planTitle: string;
  /** What you said, for a miss: the line that overturned the approval. */
  quote: string | null;
  requirements: string[];
  verdicts: string[];
  /** The ticket's work log, oldest first, one line each: when, what, who, the few facts that matter. */
  log: string[];
};

function locale(ctx: StoreContext): "zh" | "en" {
  return settingsCached(ctx).locale === "en" ? "en" : "zh";
}

/** What today's reflections have cost, in USD (local midnight is not worth the subtlety: the last 24 hours). */
export function reflectionSpendToday(ctx: StoreContext, now: string = isoNow()): number {
  const since = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  return ctx.db.query<{ usd: number | null }, [string]>(
    "SELECT SUM(COALESCE(cost_usd_ticks, estimated_cost_usd_ticks)) / 1e10 AS usd FROM spend WHERE purpose = 'reflect' AND created_at >= ?").get(since)?.usd ?? 0;
}

/**
 * The next reflection to run, claimed (a `pending` row) so a second tick does not run it too; null
 * when none is due. An event it will never run (under a stop, too soon after the last on that
 * ticket) is set aside as `skipped` rather than looked at on every tick.
 */
export function claimDueReflection(ctx: StoreContext, now: string = isoNow()): DueReflection | null {
  if (!learningOn(ctx)) return null;
  if (reflectionSpendToday(ctx, now) >= REFLECT_DAILY_USD) return null;
  const day = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  if (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM reflections WHERE state IN ('pending', 'done') AND created_at > ?").get(day)!.n >= REFLECT_DAILY_COUNT) return null;
  const since = new Date(Date.parse(now) - REFLECT_WITHIN_MS).toISOString();
  return ctx.commit(() => {
    ctx.db.run("UPDATE reflections SET state = 'failed', note = 'interrupted', finished_at = ? WHERE state = 'pending' AND created_at < ?",
      [now, new Date(Date.parse(now) - PENDING_STALE_MS).toISOString()]);
    // Every waiting one, oldest first: those under a stop are passed over, and must not crowd out the rest.
    const candidates = ctx.db.query<{ id: string; kind: "review_miss" | "ceiling"; bot_id: string; model: string | null; task_id: string; ticket_id: string;
      submission_id: string | null; message_id: string | null; created_at: string }, [string]>(
      `SELECT q.id, q.kind, q.bot_id, q.model, q.task_id, q.ticket_id, q.submission_id, q.message_id, q.created_at FROM quality_events q
       WHERE q.kind IN ('review_miss', 'ceiling') AND q.bot_id IS NOT NULL AND q.ticket_id IS NOT NULL AND q.task_id IS NOT NULL AND q.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM reflections r WHERE r.quality_event_id = q.id)
       ORDER BY q.created_at, q.rowid`).all(since);
    const skip = (event: { id: string; bot_id: string; ticket_id: string }, note: string) =>
      ctx.db.run("INSERT INTO reflections (quality_event_id, bot_id, ticket_id, state, note, created_at, finished_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)",
        [event.id, event.bot_id, event.ticket_id, note, now, now]);
    for (const event of candidates) {
      // Under a stop it waits: it runs once the stop is lifted.
      if (holdsCovering(ctx, { botId: event.bot_id, taskId: event.task_id, ticketId: event.ticket_id }).length > 0) continue;
      // One reflection on this ticket by this Bot a day is enough; one that failed does not count.
      const recent = ctx.db.query("SELECT 1 FROM reflections WHERE bot_id = ? AND ticket_id = ? AND state IN ('pending', 'done') AND created_at > ?")
        .get(event.bot_id, event.ticket_id, new Date(Date.parse(now) - REFLECT_GAP_MS).toISOString());
      if (recent) {
        skip(event, "once_a_day");
        continue;
      }
      const facts = reflectionFacts(ctx, event);
      if (!facts) {
        skip(event, "gone");
        continue;
      }
      // Nowhere to ask you: a proposal with no card could only ever be retired.
      if (!ctx.db.query("SELECT 1 FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?").get(event.task_id)) {
        skip(event, "no_conversation");
        continue;
      }
      ctx.db.run("INSERT INTO reflections (quality_event_id, bot_id, ticket_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)", [event.id, event.bot_id, event.ticket_id, now]);
      return facts;
    }
    return null;
  });
}

function reflectionFacts(ctx: StoreContext, event: { id: string; kind: "review_miss" | "ceiling"; bot_id: string; model: string | null; task_id: string;
  ticket_id: string; submission_id: string | null; message_id: string | null }): DueReflection | null {
  const ticket = ctx.db.query<{ title: string; dir: string; plan: string }, [string]>(
    "SELECT k.title, k.dir, t.title AS plan FROM tickets k JOIN tasks t ON t.id = k.task_id WHERE k.id = ?").get(event.ticket_id);
  const bot = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ? AND deleted_at IS NULL").get(event.bot_id);
  if (!ticket || !bot) return null;
  const quote = event.message_id ? ctx.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(event.message_id)?.body ?? null : null;
  const requirements = ctx.db.query<{ quote: string; restated: string | null; polarity: string }, [string, string]>(
    `SELECT quote, restated, polarity FROM requirements WHERE status = 'open'
       AND ((scope = 'ticket' AND scope_id = ?1) OR (scope = 'plan' AND scope_id = ?2)
         OR (scope = 'part' AND scope_id IN (SELECT id FROM ticket_parts WHERE ticket_id = ?1)))
     ORDER BY seq LIMIT 30`).all(event.ticket_id, event.task_id)
    .map((row) => `${row.polarity === "must_not" ? "✗ " : ""}${(row.restated ?? row.quote).slice(0, 200)}`);
  const verdicts: string[] = [];
  if (event.submission_id) {
    const reviews = ctx.db.query<{ reviews: string }, [string]>("SELECT reviews FROM submissions WHERE id = ?").get(event.submission_id)?.reviews;
    for (const review of reviews ? (JSON.parse(reviews) as Array<{ outcome?: string; note?: string | null; verdicts?: Array<{ item?: string; verdict?: string; evidence?: string }> }>) : []) {
      verdicts.push(`${review.outcome ?? "?"}${review.note ? `: ${review.note.slice(0, 200)}` : ""}`);
      for (const verdict of review.verdicts ?? []) verdicts.push(`  - ${verdict.item ?? ""}: ${verdict.verdict ?? ""}${verdict.evidence ? ` (${verdict.evidence.slice(0, 120)})` : ""}`);
    }
  }
  const log = ctx.db.query<{ at: string; kind: string; actor: string; payload: string }, [string]>(
    "SELECT at, kind, actor, payload FROM work_events WHERE ticket_id = ? ORDER BY seq DESC LIMIT 40").all(event.ticket_id).reverse()
    .map((row) => `${row.at.slice(5, 16)} ${row.kind} by ${row.actor}${logFacts(row.payload)}`);
  return { qualityEventId: event.id, event: event.kind, botId: event.bot_id, botName: bot.name, model: event.model, taskId: event.task_id,
    ticketId: event.ticket_id, ticketTitle: ticket.title, ticketDir: ticket.dir, planTitle: ticket.plan, quote: quote?.slice(0, 400) ?? null,
    requirements, verdicts, log };
}

/** The few payload fields a log line is worth: states, outcomes, reasons, labels — never file contents. */
function logFacts(raw: string): string {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const facts = ["state", "outcome", "stage", "reason", "label", "quote", "parts", "part_key"]
      .filter((key) => payload[key] !== undefined && payload[key] !== null)
      .map((key) => `${key}=${typeof payload[key] === "string" ? (payload[key] as string).slice(0, 80) : JSON.stringify(payload[key]).slice(0, 80)}`);
    return facts.length > 0 ? ` (${facts.join(", ")})` : "";
  } catch {
    return "";
  }
}

/**
 * What the reflection proposed, read strictly: one JSON object of one of three shapes. Anything
 * else is no proposal — a reflection that could not say something checkable says nothing.
 */
export function parseReflection(content: string): ReflectionOutcome {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return { kind: "none", reason: "unreadable" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { kind: "none", reason: "unreadable" };
  }
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  if (raw.kind === "checklist") {
    const hook = REFLECTION_HOOKS.find((name) => name === raw.hook);
    const item = text(raw.text, 160);
    return hook && item ? { kind: "checklist", hook, text: item } : { kind: "none", reason: "incomplete" };
  }
  if (raw.kind === "check") {
    const kind = PROPOSABLE_CHECKS.find((name) => name === raw.check_kind);
    const item = text(raw.item, 120);
    if (!kind || !item) return { kind: "none", reason: "incomplete" };
    const check: AcceptanceCheckInput = { item, kind };
    const path = text(raw.path, 300);
    if (!path) return { kind: "none", reason: "incomplete" };
    check.path = path;
    if (kind !== "exists") {
      const pattern = text(raw.pattern, 300);
      if (!pattern) return { kind: "none", reason: "incomplete" };
      check.pattern = pattern;
    }
    return { kind: "check", check };
  }
  return { kind: "none", reason: text(raw.reason, 200) || "nothing to propose" };
}

/** What a proposed check does, verbatim, so you see what you adopt: the kind, the path, the text or pattern. */
export function checkDefinition(check: AcceptanceCheckInput, lang: "zh" | "en"): string {
  // Quoted as JSON strings: a path or a pattern cannot pass for words around it.
  const path = JSON.stringify(check.path ?? "");
  if (check.kind === "exists") return lang === "en" ? `the file ${path} exists` : `文件 ${path} 存在`;
  const pattern = JSON.stringify(check.pattern ?? "");
  if (check.kind === "contains") return lang === "en" ? `${path} contains ${pattern}` : `${path} 里有 ${pattern}`;
  return lang === "en" ? `${path} matches the pattern ${pattern}` : `${path} 匹配正则 ${pattern}`;
}

const HOOK_LABEL = {
  zh: { before_review: "审查前", before_submit: "交付前", before_generate: "生成前" },
  en: { before_review: "before reviewing", before_submit: "before handing over", before_generate: "before generating" },
} as const;

/**
 * The reflection's result: nothing, or a candidate lesson and its card in the plan's conversation.
 * A failed call is recorded as such and not retried.
 */
export function recordReflection(ctx: StoreContext, due: DueReflection, outcome: ReflectionOutcome | null, now: string = isoNow()): { lesson: Lesson | null; message: Message | null } {
  return ctx.commit(() => {
    const finish = (state: "done" | "failed", lessonId: string | null, note: string | null) =>
      ctx.db.run("UPDATE reflections SET state = ?, lesson_id = ?, note = ?, finished_at = ? WHERE quality_event_id = ?", [state, lessonId, note, now, due.qualityEventId]);
    if (!outcome) {
      finish("failed", null, "call_failed");
      return { lesson: null, message: null };
    }
    if (outcome.kind === "none") {
      finish("done", null, outcome.reason);
      recordWorkEvent(ctx, { kind: "reflection.none", actor: due.botId, botId: due.botId, taskId: due.taskId, ticketId: due.ticketId,
        payload: { quality_event_id: due.qualityEventId, reason: outcome.reason } });
      return { lesson: null, message: null };
    }
    const lang = locale(ctx);
    const id = ulid(Date.parse(now));
    const hook: Lesson["hook"] = outcome.kind === "checklist" ? outcome.hook : due.event === "review_miss" ? "before_review" : "before_submit";
    const text = outcome.kind === "checklist" ? outcome.text : outcome.check.item;
    const detector = { tool: "reflection", signature: `reflection:${due.qualityEventId}`, head: hook, place: "", error: due.event,
      ...(outcome.kind === "check" ? { check: { ...outcome.check, ticket_id: due.ticketId } } : {}) };
    ctx.db.run(`INSERT INTO lessons (id, scope, scope_id, hook, detector, action, text, evidence, status, created_by, created_at, updated_at)
      VALUES (?, 'bot', ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
      [id, due.botId, hook, JSON.stringify(detector), outcome.kind === "checklist" ? "checklist" : "propose_check", text,
        JSON.stringify([{ turn_id: null, at: now, quality_event_id: due.qualityEventId, ticket_id: due.ticketId }]), due.botId, now, now]);
    finish("done", id, null);
    const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(due.taskId);
    let card: Message | null = null;
    if (plan?.session_id) {
      const looked = due.event === "review_miss"
        ? (lang === "en" ? `${due.botName} looked back at its approval of "${due.ticketTitle}" that you overturned` : `${due.botName}回看了被你推翻的那次放行（「${due.ticketTitle}」）`)
        : (lang === "en" ? `${due.botName} looked back at "${due.ticketTitle}", stuck at the capability ceiling` : `${due.botName}回看了卡在能力天花板上的「${due.ticketTitle}」`);
      const body = outcome.kind === "checklist"
        ? (lang === "en"
          ? `${looked}, and proposes a checklist item for itself, ${HOOK_LABEL.en[outcome.hook]}: ${outcome.text}`
          : `${looked}，给自己提了一条${HOOK_LABEL.zh[outcome.hook]}的清单：${outcome.text}`)
        : (lang === "en"
          ? `${looked}, and proposes a check for the ticket: ${outcome.check.item} — ${checkDefinition(outcome.check, "en")}`
          : `${looked}，提议给这张任务加一条检查：${outcome.check.item}——${checkDefinition(outcome.check, "zh")}`);
      const message = insertMessage(ctx, { sessionId: plan.session_id, kind: "system", author: USER_MEMBER, hiddenFromBots: true, body,
        control: { kind: "lesson", lesson_id: id, task_id: due.taskId, ticket_id: due.ticketId, offer: ["confirm", "decline"] } });
      createNotification(ctx, { semantic_key: `lesson:${message.id}`, kind: "ask", session_id: plan.session_id, message_id: message.id, action_state: "open" });
      card = message;
    }
    recordWorkEvent(ctx, { kind: "reflection.proposed", actor: due.botId, botId: due.botId, taskId: due.taskId, ticketId: due.ticketId,
      payload: { quality_event_id: due.qualityEventId, lesson_id: id, kind: outcome.kind } });
    return { lesson: getLesson(ctx, id), message: card };
  });
}

/**
 * Your answer on a reflection's card: 采用 makes a checklist item read in that Bot's situation, or
 * adds the proposed check to the ticket (as if you wrote it on the board); 不要 retires it.
 */
export function answerLessonCard(ctx: StoreContext, messageId: string, action: unknown, now: string = isoNow()): Message {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "lesson") throw new HttpError(422, "invalid_args", "this line is not a reflection's card");
    if (action !== "confirm" && action !== "decline") throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const lesson = getLesson(ctx, control.lesson_id);
    if (!lesson || lesson.status !== "candidate") throw new HttpError(409, "conflict", "this proposal was already decided");
    let result: string | undefined;
    if (action === "confirm") {
      if (lesson.action === "propose_check") {
        const proposed = (lesson.detector as Lesson["detector"] & { check?: AcceptanceCheckInput }).check;
        if (!proposed) throw new HttpError(409, "conflict", "the proposal carries no check");
        try {
          if (!(PROPOSABLE_CHECKS as readonly string[]).includes(proposed.kind)) throw new Error(locale(ctx) === "en" ? "not a kind a reflection may propose" : "反思不能提这种检查");
          const check = createCheckByUser(ctx, control.task_id, proposed, new Date(now));
          // A gate, but not yours: adopting a card is not writing it (it backs no approval until you edit it).
          ctx.db.run("UPDATE acceptance_checks SET origin = 'reflection' WHERE id = ?", [check.id]);
          ctx.db.run("UPDATE lessons SET detector = json_set(detector, '$.check_id', ?) WHERE id = ?", [check.id, lesson.id]);
        } catch (error) {
          result = locale(ctx) === "en" ? `The check could not be added: ${error instanceof Error ? error.message : "refused"}.` : `检查没加上：${error instanceof Error ? error.message : "被拒绝了"}。`;
        }
      }
      ctx.db.run("UPDATE lessons SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?", [result ? "retired" : "active", now, now, lesson.id]);
    } else {
      ctx.db.run("UPDATE lessons SET status = 'retired', updated_at = ? WHERE id = ?", [now, lesson.id]);
    }
    recordWorkEvent(ctx, { kind: action === "confirm" && !result ? "lesson.adopted" : "lesson.declined", actor: USER_MEMBER, botId: lesson.scope_id,
      taskId: control.task_id, ticketId: control.ticket_id, payload: { lesson_id: lesson.id } });
    updateNotificationActionState(ctx, `lesson:${messageId}`, "resolved", action, true);
    return setMessageControl(ctx, messageId, { ...control, acted: [action], ...(result ? { result } : {}) });
  });
}

/** The checklist items of this Bot's you adopted, for its situation at the moment they are for. */
export function checklistFor(ctx: StoreContext, botId: string, hooks: readonly ReflectionHook[]): Array<{ hook: ReflectionHook; text: string }> {
  if (!learningOn(ctx) || hooks.length === 0) return [];
  return ctx.db.query<{ hook: ReflectionHook; text: string }, [string]>(
    `SELECT hook, text FROM lessons WHERE scope = 'bot' AND scope_id = ? AND action = 'checklist' AND status = 'active'
       AND hook IN (${hooks.map((hook) => `'${hook}'`).join(", ")}) ORDER BY confirmed_at, rowid LIMIT 12`).all(botId);
}
