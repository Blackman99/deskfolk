/**
 * Lessons (ADR 0050, engine level 8): what the app learned from a failure, as a rule it checks
 * itself rather than a memory a Bot may or may not act on. This first version has one kind, the
 * failure-signature lesson: a command the shell's timeout killed becomes a `before_tool` lesson on
 * its kind (`commandSignature`: program, `-r` for a tree walk, the place), shared by every Bot of this
 * workspace (`scope` project, `scope_id` the workspace root). Only a search that walks a tree is
 * learned from: a render or a build that runs long is not a mistake to hold back.
 *
 * - **warn**: the first call of that kind in a turn is not run; the tool result says what happened
 *   last time and how to narrow it. Repeating the call in the same turn runs it — the Bot insists.
 * - **block**: an insisted call that timed out again (a recurrence) turns the lesson into a block,
 *   and that kind of call is refused from then on, whatever the turn.
 *
 * You can read every lesson, and retire it or bring it back (`updateLesson`).
 */
import type { Database } from "bun:sqlite";
import type { AcceptanceCheckInput, Locale, Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { learningOn } from "./quality";
import { removeCheckByUser } from "./acceptance-checks";
import { getMessage, setMessageControl } from "./messages";
import { updateNotificationActionState } from "./notifications";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

export type LessonAction = "warn" | "block" | "checklist" | "propose_check";
export type LessonStatus = "candidate" | "active" | "retired";

export type Lesson = {
  id: string;
  scope: "bot" | "role" | "project" | "tool" | "global";
  scope_id: string | null;
  hook: "before_tool" | "before_generate" | "before_submit" | "before_review";
  /** A shell lesson's kind of call; a reflection's (`tool` reflection) carries the check it proposes, and once adopted its id. */
  detector: { tool: string; signature: string; head: string; place: string; error: string; check?: AcceptanceCheckInput; check_id?: string };
  action: LessonAction;
  text: string;
  evidence: Array<{ turn_id: string | null; at: string; seconds?: number; recurrence?: boolean; quality_event_id?: string; ticket_id?: string }>;
  status: LessonStatus;
  hits: number;
  prevented: number;
  recurrences: number;
  created_by: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const LESSONS_SQL = `CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('bot', 'role', 'project', 'tool', 'global')),
  scope_id TEXT,
  hook TEXT NOT NULL CHECK (hook IN ('before_tool', 'before_generate', 'before_submit', 'before_review')),
  detector TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('warn', 'block', 'checklist', 'propose_check')),
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'retired')),
  hits INTEGER NOT NULL DEFAULT 0,
  prevented INTEGER NOT NULL DEFAULT 0,
  recurrences INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export function migrateLessons(db: Database): void {
  db.run(LESSONS_SQL);
  // An earlier draft's index ignored the workspace: a second workspace could not learn the same kind.
  db.run("DROP INDEX IF EXISTS lessons_live_signature");
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS lessons_live_scoped_signature ON lessons(hook, scope, scope_id, json_extract(detector, '$.signature'))
    WHERE status <> 'retired'`);
}

/** How many past occurrences a lesson keeps as its evidence. */
const EVIDENCE_KEPT = 10;

type LessonRow = Omit<Lesson, "detector" | "evidence"> & { detector: string; evidence: string };

function toLesson(row: LessonRow): Lesson {
  return { ...row, detector: JSON.parse(row.detector) as Lesson["detector"], evidence: JSON.parse(row.evidence) as Lesson["evidence"] };
}

export function getLesson(ctx: StoreContext, id: string): Lesson | null {
  const row = ctx.db.query<LessonRow, [string]>("SELECT * FROM lessons WHERE id = ?").get(id);
  return row ? toLesson(row) : null;
}

export function listLessons(ctx: StoreContext, filter: { status?: LessonStatus } = {}): Lesson[] {
  return ctx.db.query<LessonRow, [string | null]>("SELECT * FROM lessons WHERE (?1 IS NULL OR status = ?1) ORDER BY updated_at DESC, rowid DESC")
    .all(filter.status ?? null).map(toLesson);
}

/** The live lesson on this kind of call in this workspace (a lesson is the workspace's: `scope` project, `scope_id` its root). */
function liveShellLesson(ctx: StoreContext, workspace: string, signature: string): Lesson | null {
  const row = ctx.db.query<LessonRow, [string, string]>(`SELECT * FROM lessons WHERE hook = 'before_tool' AND status = 'active' AND scope = 'project'
    AND scope_id = ? AND json_extract(detector, '$.tool') = 'shell' AND json_extract(detector, '$.signature') = ?`).get(workspace, signature);
  return row ? toLesson(row) : null;
}

/** Whether this turn already has an event of `kind` about this lesson: the counters move once per turn. */
function seenInTurn(ctx: StoreContext, kind: string, turnId: string | null, lessonId: string): boolean {
  if (!turnId) return false;
  return Boolean(ctx.db.query("SELECT 1 FROM work_events WHERE turn_id = ? AND kind = ? AND json_extract(payload, '$.lesson_id') = ?").get(turnId, kind, lessonId));
}

const PLACE = {
  zh: { home: "整个家目录", device: "整个磁盘（/）", workspace: "工作区根目录", task: "任务目录", inside: "工作区里", outside: "工作区外", unknown: "没法静态判断的位置" },
  en: { home: "your whole home folder", device: "the whole disk (/)", workspace: "the workspace root", task: "the task folder", inside: "inside the workspace",
    outside: "outside the workspace", unknown: "a place the app could not work out" },
} as const;

function placeText(lang: Locale, place: string): string {
  return (PLACE[lang] as Record<string, string>)[place] ?? place;
}

/** The lesson as you read it in its list. */
function lessonText(lang: Locale, head: string, place: string, seconds: number): string {
  return lang === "en"
    ? `"${head}" in ${placeText(lang, place)} ran into the ${seconds}s timeout and was killed. Narrow it first — a subfolder, a depth limit, a shorter run.`
    : `在${placeText(lang, place)}跑「${head}」这类命令，跑满 ${seconds} 秒超时被杀过。先缩小范围再跑：指定子目录、限制深度、或者拆短。`;
}

export type ShellLessonCheck = { refuse: string; lessonId: string } | { refuse: null; overriding: string | null };

/**
 * Before a shell call of this kind runs: refused by a block, refused once per turn by a warn (and
 * let through when the Bot repeats it in that turn), let through when no lesson covers it.
 */
export function checkShellLesson(ctx: StoreContext, input: { workspace: string; turnId: string | null; botId: string | null; signature: string }, now: string = isoNow()): ShellLessonCheck {
  if (!learningOn(ctx)) return { refuse: null, overriding: null };
  const lesson = liveShellLesson(ctx, input.workspace, input.signature);
  if (!lesson) return { refuse: null, overriding: null };
  const where = placeText("en", lesson.detector.place);
  if (lesson.action === "block") {
    // Each turn it holds back counts once, however often that turn retries.
    if (!seenInTurn(ctx, "lesson.blocked", input.turnId, lesson.id)) {
      ctx.db.run("UPDATE lessons SET hits = hits + 1, prevented = prevented + 1, updated_at = ? WHERE id = ?", [now, lesson.id]);
      recordWorkEvent(ctx, { kind: "lesson.blocked", actor: "app", botId: input.botId, turnId: input.turnId, payload: { lesson_id: lesson.id, signature: input.signature } });
    }
    return { lessonId: lesson.id, refuse: `refused by lesson ${lesson.id}: \`${lesson.detector.head}\` in ${where} ran into the shell's timeout again after a warning. It will not run as it is; narrow it — a subfolder, a depth limit (find -maxdepth, rg --max-depth), or a shorter run.` };
  }
  if (seenInTurn(ctx, "lesson.warned", input.turnId, lesson.id)) {
    // Repeated in the same turn: it runs, and the warning did not prevent this turn's call after all —
    // taken back once, however many more of the kind the turn runs.
    if (!seenInTurn(ctx, "lesson.overridden", input.turnId, lesson.id)) {
      ctx.db.run("UPDATE lessons SET prevented = MAX(prevented - 1, 0), updated_at = ? WHERE id = ?", [now, lesson.id]);
      recordWorkEvent(ctx, { kind: "lesson.overridden", actor: input.botId ?? "app", botId: input.botId, turnId: input.turnId, payload: { lesson_id: lesson.id } });
    }
    return { refuse: null, overriding: lesson.id };
  }
  ctx.db.run("UPDATE lessons SET hits = hits + 1, prevented = prevented + 1, updated_at = ? WHERE id = ?", [now, lesson.id]);
  recordWorkEvent(ctx, { kind: "lesson.warned", actor: "app", botId: input.botId, turnId: input.turnId, payload: { lesson_id: lesson.id, signature: input.signature } });
  return { lessonId: lesson.id, refuse: `not run, lesson ${lesson.id}: \`${lesson.detector.head}\` in ${where} ran into the shell's timeout before and was killed. Narrow it first — a subfolder, a depth limit (find -maxdepth, rg --max-depth), or a shorter run. If it really has to run as it is, call it again in this turn and it will run; should it time out again, this kind of call is refused from then on.` };
}

/**
 * A shell call the timeout killed: the first of its kind becomes a warn lesson; one the Bot insisted
 * on past a warning is a recurrence, and the lesson becomes a block.
 */
export function noteShellTimeout(
  ctx: StoreContext,
  input: { workspace: string; turnId: string | null; botId: string | null; signature: string; head: string; place: string; seconds: number; overriding: string | null },
  now: string = isoNow(),
): Lesson | null {
  if (!learningOn(ctx)) return null;
  const existing = liveShellLesson(ctx, input.workspace, input.signature);
  if (existing) {
    if (input.overriding !== existing.id) return existing;
    const evidence = [...existing.evidence, { turn_id: input.turnId, at: now, seconds: input.seconds, recurrence: true }].slice(-EVIDENCE_KEPT);
    ctx.db.run("UPDATE lessons SET recurrences = recurrences + 1, action = 'block', evidence = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(evidence), now, existing.id]);
    recordWorkEvent(ctx, { kind: "lesson.recurred", actor: "app", botId: input.botId, turnId: input.turnId, payload: { lesson_id: existing.id, signature: input.signature } });
    return getLesson(ctx, existing.id);
  }
  const id = ulid(Date.parse(now));
  ctx.db.run(`INSERT INTO lessons (id, scope, scope_id, hook, detector, action, text, evidence, status, created_by, created_at, updated_at)
    VALUES (?, 'project', ?, 'before_tool', ?, 'warn', ?, ?, 'active', 'app', ?, ?)`,
    [id, input.workspace, JSON.stringify({ tool: "shell", signature: input.signature, head: input.head, place: input.place, error: "timeout" }),
      lessonText(localeOf(ctx), input.head, input.place, input.seconds), JSON.stringify([{ turn_id: input.turnId, at: now, seconds: input.seconds }]), now, now]);
  recordWorkEvent(ctx, { kind: "tool.timeout", actor: "app", botId: input.botId, turnId: input.turnId,
    payload: { lesson_id: id, signature: input.signature, seconds: input.seconds } });
  return getLesson(ctx, id);
}

/** Your edit of a lesson: retire it, bring it back, set warn or block, reword it. */
export function updateLesson(ctx: StoreContext, id: string, patch: { status?: "active" | "retired"; action?: "warn" | "block"; text?: string }, now: string = isoNow()): Lesson {
  const lesson = getLesson(ctx, id);
  if (!lesson) throw new HttpError(404, "not_found", "lesson not found");
  // A reflection's proposal is adopted on its card, where an adopted check is added; here it can only
  // be retired, or — a checklist item — brought back. Warn and block are a shell lesson's.
  if (lesson.detector.tool !== "shell") {
    if (patch.action !== undefined) throw new HttpError(409, "conflict", "only a lesson on a kind of call warns or blocks");
    if (patch.status === "active" && (lesson.status === "candidate" || lesson.action !== "checklist")) {
      throw new HttpError(409, "conflict", "a proposal is adopted on its card");
    }
  }
  if (patch.status === "active" && lesson.status !== "active" && lesson.scope_id && liveShellLesson(ctx, lesson.scope_id, lesson.detector.signature)) {
    throw new HttpError(409, "conflict", "another lesson on this kind of call is already active");
  }
  const text = patch.text?.trim();
  const confirmed = lesson.detector.tool === "shell" ? now : lesson.confirmed_at;
  ctx.db.run("UPDATE lessons SET status = ?, action = ?, text = ?, confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?",
    [patch.status ?? lesson.status, patch.action ?? lesson.action, text && text.length > 0 ? text : lesson.text, confirmed, now, id]);
  if (patch.status === "retired" && lesson.status !== "retired") settleReflection(ctx, lesson, now);
  recordWorkEvent(ctx, { kind: "lesson.edited", actor: "user", payload: { lesson_id: id, ...patch } });
  return getLesson(ctx, id)!;
}

/**
 * Retiring a reflection's lesson in Settings: a proposal still waiting closes its card (as 不要), and
 * an adopted check proposal takes its check off the ticket.
 */
function settleReflection(ctx: StoreContext, lesson: Lesson, now: string): void {
  if (lesson.detector.tool !== "reflection") return;
  if (lesson.status === "candidate") {
    const card = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'lesson'
      AND json_extract(control, '$.lesson_id') = ? AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0`).get(lesson.id);
    if (card) {
      const control = getMessage(ctx, card.id).control;
      if (control?.kind === "lesson") setMessageControl(ctx, card.id, { ...control, acted: ["decline"] });
      updateNotificationActionState(ctx, `lesson:${card.id}`, "resolved", "decline", true);
    }
  }
  // Only while it is still the reflection's: one you edited on the board is yours, and stays.
  const check = lesson.action === "propose_check" && lesson.detector.check_id
    ? ctx.db.query<{ id: string }, [string]>("SELECT id FROM acceptance_checks WHERE id = ? AND origin = 'reflection' AND removed_at IS NULL").get(lesson.detector.check_id)
    : null;
  if (check) removeCheckByUser(ctx, check.id, new Date(now));
}

/** A reflection's card for this lesson, if there is one: what a retire in Settings settles. */
export function lessonCard(ctx: StoreContext, lessonId: string): Message | null {
  const row = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'lesson'
    AND json_extract(control, '$.lesson_id') = ?`).get(lessonId);
  return row ? getMessage(ctx, row.id) : null;
}

/** Clearing a conversation's history keeps its lessons, without the turns they were learned from. */
export function forgetLessonSources(ctx: StoreContext, sessionId: string): void {
  const turns = new Set(ctx.db.query<{ id: string }, [string]>("SELECT id FROM turns WHERE session_id = ?").all(sessionId).map((row) => row.id));
  if (turns.size === 0) return;
  for (const lesson of ctx.db.query<{ id: string; evidence: string }, []>("SELECT id, evidence FROM lessons").all()) {
    const evidence = JSON.parse(lesson.evidence) as Lesson["evidence"];
    if (!evidence.some((entry) => entry.turn_id && turns.has(entry.turn_id))) continue;
    ctx.db.run("UPDATE lessons SET evidence = ? WHERE id = ?",
      [JSON.stringify(evidence.map((entry) => (entry.turn_id && turns.has(entry.turn_id) ? { ...entry, turn_id: null } : entry))), lesson.id]);
  }
}
