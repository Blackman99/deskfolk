/**
 * A plan (规划) and its work dir.
 *
 * The `tasks` table is the plan; the name is the one it shipped with, when a job was only a work
 * dir. A plan is the thing a conversation is pushing forward: it keeps the request that opened it
 * (`brief`), the spec the organizer maintains (`spec`: goal, acceptance, rules, process, progress),
 * a kind for finding precedents, a status, and a folder under `work/`. Tickets (任务) nest under it
 * (`store/tickets.ts`), each with its own folder inside the plan's.
 *
 * It is still not a scheduler entity: no assignee, no steps, no plan DAG. Its identity is the turn
 * tree — a handoff arrives as a message some turn produced, so the woken turn inherits that turn's
 * plan and ticket, and the folder follows the work across Bots and sessions without anyone routing
 * it. A session holds at most one current plan; the organizer, not a clock, decides when a user
 * message starts or resumes another. A routine's standing plan is never the current one.
 *
 * The trace is that same tree read back: one card per turn, edges from who woke whom, files from
 * the attachments those turns already cited. Nothing is inferred and nothing is written.
 */
import {
  INTERRUPT_NOTE_BODY,
  USER_MEMBER,
  type SessionTaskSummary,
  type TaskTrace,
  type TaskTraceNode,
  type TicketStatus,
  type TurnStatus,
} from "@real-bot/protocol";
import { askTranscriptText, readAskAnswer, readAskSpec } from "../ask";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { notCheckBackLine } from "./check-backs";
import { parsePlanSpec, type PlanSpec, type PlanStatus } from "./plan-shape";
import { sessionRow, type MessageRow, type StoreContext } from "./shared";

export type { PlanSpec, PlanStatus } from "./plan-shape";

export type Task = {
  id: string;
  /** Null once the session it was opened in is deleted; the dir and its turns stay. */
  session_id: string | null;
  title: string;
  dir: string;
  /**
   * The request that opened the plan: the body of the message (or the routine's instruction) that
   * started its first turn, clipped to {@link BRIEF_MAX}. Null only on plans older than the column
   * whose first turn no longer exists.
   */
  brief: string | null;
  /** The organizer's label for what kind of plan this is; precedents are plans of the same kind. */
  kind: string | null;
  /** The spec as JSON; read it with {@link parsePlanSpec}. Null until the organizer first ran. */
  spec: string | null;
  status: PlanStatus;
  spec_updated_at: string | null;
  /** Set on a routine's standing plan, which every fire of that routine adds a ticket to. */
  routine_id: string | null;
  created_at: string;
  /** Set once the plan is no longer its session's current one. */
  closed_at: string | null;
};

/** The reserved root every work dir lives under, so the workspace top level stays the user's. */
export const WORK_ROOT = "work";

/** Reserved subdirs inside a plan or ticket dir. Nothing written here is ever cited as an artifact. */
export const RESERVED_SUBDIRS = ["tool-results", "scratch"] as const;

/** The app-rendered mirror of a plan's spec and ticket index, at the plan dir's root. */
export const PLAN_MAP_FILE = "map.md";
/** The app-rendered mirror of one ticket, at that ticket dir's root. */
export const TICKET_FILE = "ticket.md";

/** As much of the opening request as a plan keeps; the transcript already clips lines to this. */
export const BRIEF_MAX = 4000;

const TITLE_MAX = 40;
const SLUG_MAX = 12;
/** Path separators, the Windows-reserved set, and control characters. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

export function taskTitle(body: string): string {
  return takeCodePoints(body.replace(/\s+/g, " ").trim(), TITLE_MAX).text;
}

/**
 * `work/导出季度报表-7f3k`. CJK is kept as-is because the workspace is APFS, not a URL. The id
 * suffix is what actually keeps two plans with the same opening words apart. Plans from before
 * this carry a date prefix; they keep it.
 */
export function taskDirName(input: { title: string; id: string; suffixLength?: number }): string {
  const parts: string[] = [];
  const slug = slugify(input.title);
  if (slug) parts.push(slug);
  parts.push(idSuffix(input.id, input.suffixLength ?? 4));
  return `${WORK_ROOT}/${parts.join("-")}`;
}

/** A ticket dir sits directly under the plan dir as `NN-slug/`; the segment is optional so one test covers both levels. */
const TICKET_SEGMENT = "(?:\\d{2,}(?:-[^/]*)?/)?";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a workspace-relative path is one of the app's own files inside a plan or ticket dir:
 * the spill and scratch subdirs at either level, the plan's `map.md`, a ticket's `ticket.md`.
 * `base` may be the plan dir or a ticket dir.
 */
export function isReservedTaskPath(base: string, relpath: string): boolean {
  const root = escapeRegExp(base);
  const reserved = new RegExp(`^${root}/${TICKET_SEGMENT}(?:${RESERVED_SUBDIRS.join("|")})/`);
  if (reserved.test(relpath)) return true;
  if (relpath === `${base}/${PLAN_MAP_FILE}`) return true;
  return new RegExp(`^${root}/${TICKET_SEGMENT}${escapeRegExp(TICKET_FILE)}$`).test(relpath);
}

export function getTask(ctx: StoreContext, id: string): Task {
  const row = ctx.db.query<Task, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "task not found");
  return row;
}

export function taskOfTurn(ctx: StoreContext, turnId: string): string | null {
  const row = ctx.db
    .query<{ task_id: string | null }, [string]>(`SELECT task_id FROM turns WHERE id = ?`)
    .get(turnId);
  return row?.task_id ?? null;
}

/**
 * The dir a turn works in: its ticket's when it has one, else its plan's. Null on turns from
 * before work dirs. This is the shell's default cwd and where the daemon spills tool results.
 */
export function turnWorkDir(ctx: StoreContext, turnId: string): string | null {
  const row = ctx.db
    .query<{ task_id: string | null; ticket_id: string | null }, [string]>(
      `SELECT task_id, ticket_id FROM turns WHERE id = ?`,
    )
    .get(turnId);
  if (!row?.task_id) return null;
  if (row.ticket_id) {
    const ticket = ctx.db
      .query<{ dir: string }, [string]>(`SELECT dir FROM tickets WHERE id = ?`)
      .get(row.ticket_id);
    if (ticket) return ticket.dir;
  }
  try {
    return getTask(ctx, row.task_id).dir;
  } catch {
    return null;
  }
}

/** The plan dir a turn belongs to, whichever ticket it works in. */
export function turnPlanDir(ctx: StoreContext, turnId: string): string | null {
  const taskId = taskOfTurn(ctx, turnId);
  if (!taskId) return null;
  try {
    return getTask(ctx, taskId).dir;
  } catch {
    return null;
  }
}

/** The session's current plan: open, not a routine's, newest. Null when the session has none. */
export function sessionCurrentTask(ctx: StoreContext, sessionId: string): Task | null {
  return (
    ctx.db
      .query<Task, [string]>(
        `SELECT * FROM tasks
         WHERE session_id = ? AND closed_at IS NULL AND routine_id IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId) ?? null
  );
}

/**
 * Whether another turn already belongs to this plan. The plan's first turn has the brief as its
 * trigger, so it is the one turn that can still ask what the request meant before doing it.
 */
export function taskHasEarlierTurns(ctx: StoreContext, taskId: string, turnId: string): boolean {
  const row = ctx.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM turns WHERE task_id = ? AND id != ? LIMIT 1`,
    )
    .get(taskId, turnId);
  return Boolean(row);
}

export function taskLiveTurnCount(ctx: StoreContext, taskId: string): number {
  const row = ctx.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM turns
       WHERE task_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')`,
    )
    .get(taskId);
  return row?.n ?? 0;
}

export type TaskArtifact = {
  path: string;
  last_cited_at: string;
  turn_id: string | null;
  ticket_id: string | null;
};

/**
 * Relevance is "somebody cited it", not "it sits in the work dir" and not "this turn wrote it".
 * Listing the folder would hand back the daemon's spill and every throwaway; listing one turn
 * would drop whatever the Bot before the handoff produced. The union of what this plan's messages
 * cited is the set a reader actually wants, and it is already recorded.
 *
 * A cited file that has since been deleted is left out (`present` says which are still there):
 * the list is for opening files, and a row that can only answer "file is gone" is not one. The
 * app's own mirror files are left out too. The cap counts what survives, so deleted files never
 * crowd live ones out of it.
 */
export function taskArtifacts(
  ctx: StoreContext,
  taskId: string,
  present: (path: string) => boolean,
  limit = 200,
): TaskArtifact[] {
  const task = getTask(ctx, taskId);
  const cited = ctx.db
    .query<TaskArtifact, [string]>(
      `SELECT a.workspace_relpath AS path,
              MAX(m.created_at) AS last_cited_at,
              MAX(m.turn_id) AS turn_id,
              MAX(m.ticket_id) AS ticket_id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.task_id = ?
       GROUP BY a.workspace_relpath
       ORDER BY last_cited_at DESC, path ASC`,
    )
    .all(taskId);
  const out: TaskArtifact[] = [];
  for (const row of cited) {
    if (out.length >= limit) break;
    if (isReservedTaskPath(task.dir, row.path)) continue;
    if (present(row.path)) out.push(row);
  }
  return out;
}

/**
 * Files this plan's messages cited after `since`, for the organizer to file under tickets: the
 * newest `limit`, listed oldest first. Taking the oldest instead froze the window at the plan's
 * start once more than `limit` had piled up, so recent files were never filed.
 */
export function taskArtifactsSince(
  ctx: StoreContext,
  taskId: string,
  since: string,
  limit = 30,
): Array<{ path: string; author: string; turn_id: string | null; ticket_id: string | null; cited_at: string }> {
  const task = getTask(ctx, taskId);
  return ctx.db
    .query<{ path: string; author: string; turn_id: string | null; ticket_id: string | null; cited_at: string }, [string, string, number]>(
      `SELECT path, author, turn_id, ticket_id, cited_at FROM (
         SELECT a.workspace_relpath AS path, m.author, m.turn_id, m.ticket_id, m.created_at AS cited_at, a.id AS attachment_id
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.task_id = ? AND m.created_at > ?
         ORDER BY m.created_at DESC, a.id DESC
         LIMIT ?
       ) ORDER BY cited_at ASC, attachment_id ASC`,
    )
    .all(taskId, since, limit)
    .filter((row) => !isReservedTaskPath(task.dir, row.path));
}

/**
 * What was said about this plan after `since`: its own messages, plus the user's lines in the
 * session it lives in, which may not carry the plan yet. The newest `limit`, listed oldest first —
 * taking the oldest left a plan with no revision yet showing the organizer its first hour forever.
 */
export function taskMessagesSince(
  ctx: StoreContext,
  taskId: string,
  since: string,
  limit = 30,
): Array<{ id: string; author: string; kind: string; body: string; ticket_id: string | null; created_at: string }> {
  const task = getTask(ctx, taskId);
  // A question you answered since counts as new, and reads with its choices and your answer: the
  // answer is written onto the question, not posted as a message of yours.
  return ctx.db
    .query<MessageRow, [string, string | null, string, string, number]>(
      `SELECT * FROM (
         SELECT id, author, kind, body, ticket_id, created_at, ask_spec, ask_answer FROM messages
         WHERE (task_id = ? OR (session_id = ? AND kind = 'user'))
           AND (created_at > ? OR (kind = 'ask' AND json_extract(ask_answer, '$.answered_at') > ?))
           AND kind IN ('user', 'bot', 'ask', 'system')
           AND ${notCheckBackLine()}
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId, task.session_id, since, since, limit)
    .map((row) => ({
      id: row.id,
      author: row.author,
      kind: row.kind,
      body: row.kind === "ask"
        ? askTranscriptText({ body: row.body, ask: readAskSpec(row.ask_spec), ask_answer: readAskAnswer(row.ask_answer) })
        : row.body,
      ticket_id: row.ticket_id ?? null,
      created_at: row.created_at,
    }));
}

export function openTask(
  ctx: StoreContext,
  input: {
    sessionId: string;
    title: string;
    brief?: string;
    kind?: string | null;
    spec?: PlanSpec | null;
    /** A routine's standing plan: it never becomes the session's current plan and closes nothing. */
    routineId?: string | null;
    now?: Date;
  },
): Task {
  sessionRow(ctx, input.sessionId);
  const at = input.now ?? new Date();
  const now = isoNow();
  const id = ulid(at.getTime());
  const title = taskTitle(input.title);
  const brief = takeCodePoints((input.brief ?? input.title).trim(), BRIEF_MAX).text;
  const spec = input.spec ?? null;
  const kind = spec?.kind ?? input.kind ?? null;
  const status: PlanStatus = spec?.status ?? "active";
  ctx.db.transaction(() => {
    if (!input.routineId) {
      // One current plan per session: the new one takes over, and the one it displaces is parked
      // unless it was already done. A resume can bring it back.
      ctx.db.run(
        `UPDATE tasks SET closed_at = ?, status = CASE WHEN status = 'active' THEN 'parked' ELSE status END
         WHERE session_id = ? AND closed_at IS NULL AND routine_id IS NULL`,
        [now, input.sessionId],
      );
    }
    ctx.db.run(
      `INSERT INTO tasks (id, session_id, title, dir, brief, kind, spec, status, spec_updated_at, routine_id, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        input.sessionId,
        title,
        uniqueDir(ctx, { title, id }),
        brief,
        kind,
        spec ? JSON.stringify(spec) : null,
        status,
        spec ? now : null,
        input.routineId ?? null,
        now,
      ],
    );
  })();
  return getTask(ctx, id);
}

/**
 * Writes what the organizer or the user decided the plan is. Done and parked take the plan out of
 * the current slot; active puts it back when nothing else has taken the slot meanwhile.
 */
export function setTaskSpec(ctx: StoreContext, taskId: string, spec: PlanSpec, now: string = isoNow()): Task {
  const task = getTask(ctx, taskId);
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE tasks SET spec = ?, kind = ?, status = ?, spec_updated_at = ? WHERE id = ?`,
      [JSON.stringify(spec), spec.kind, spec.status, now, taskId],
    );
    if (spec.status !== "active") {
      ctx.db.run(`UPDATE tasks SET closed_at = COALESCE(closed_at, ?) WHERE id = ?`, [now, taskId]);
    } else if (task.closed_at && task.session_id && !task.routine_id) {
      const current = sessionCurrentTask(ctx, task.session_id);
      if (!current) ctx.db.run(`UPDATE tasks SET closed_at = NULL WHERE id = ?`, [taskId]);
    }
  })();
  return getTask(ctx, taskId);
}

/** The standing plan a routine's fires add tickets to. */
export function routineTask(ctx: StoreContext, routineId: string): Task | null {
  return (
    ctx.db
      .query<Task, [string]>(`SELECT * FROM tasks WHERE routine_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(routineId) ?? null
  );
}

/** Kind labels in use, most recently confirmed first, for the organizer to pick from. */
export function distinctTaskKinds(ctx: StoreContext, limit = 50): string[] {
  return ctx.db
    .query<{ kind: string }, [number]>(
      `SELECT kind FROM tasks WHERE kind IS NOT NULL AND kind != ''
       GROUP BY kind ORDER BY MAX(COALESCE(spec_updated_at, created_at)) DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => row.kind);
}

/** Plans of the same kind that were finished, newest first, roster-wide: what "last time" looked like. */
export function precedentTasks(ctx: StoreContext, kind: string, excludeTaskId: string | null, limit = 3): Task[] {
  return ctx.db
    .query<Task, [string, string, number]>(
      `SELECT * FROM tasks
       WHERE kind = ? AND status = 'done' AND spec IS NOT NULL AND id != ?
       ORDER BY COALESCE(spec_updated_at, created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(kind, excludeTaskId ?? "", limit);
}

/**
 * Work dirs whose plan ended long enough ago that the daemon's own spill in them is dead weight.
 * Only `tool-results/` is ever collected — everything else in the folder is the user's to delete.
 */
export function tasksClosedBefore(ctx: StoreContext, before: string, limit = 50): Task[] {
  return ctx.db
    .query<Task, [string, number]>(
      `SELECT * FROM tasks WHERE closed_at IS NOT NULL AND closed_at < ?
       ORDER BY closed_at DESC LIMIT ?`,
    )
    .all(before, limit);
}

export function closeTask(ctx: StoreContext, id: string): void {
  ctx.db.run(
    `UPDATE tasks SET closed_at = ?, status = CASE WHEN status = 'active' THEN 'done' ELSE status END
     WHERE id = ? AND closed_at IS NULL`,
    [isoNow(), id],
  );
}

/**
 * Plans no surviving turn or message of this session belongs to, once those rows are gone: their
 * revisions and tickets first, since both reference the plan.
 */
export function dropUnreferencedTasks(ctx: StoreContext, sessionId: string): void {
  const gone = ctx.db
    .query<{ id: string }, [string]>(
      `SELECT id FROM tasks
       WHERE session_id = ?
         AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.task_id = tasks.id)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.task_id = tasks.id)`,
    )
    .all(sessionId)
    .map((row) => row.id);
  for (const id of gone) {
    ctx.db.run(`DELETE FROM task_spec_revisions WHERE task_id = ?`, [id]);
    ctx.db.run(`DELETE FROM tickets WHERE task_id = ?`, [id]);
    ctx.db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
}

/** One line on a card. A paragraph would turn the board into the transcript it points at. */
const SUMMARY_MAX = 80;

type TraceTurnRow = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  partial_text: string | null;
  ticket_id: string | null;
  created_at: string;
  trigger_body: string;
  trigger_created_at: string;
  trigger_turn_id: string | null;
  trigger_author: string;
  trigger_kind: string;
};

type TraceMessageRow = {
  id: string;
  turn_id: string;
  kind: string;
  body: string;
  created_at: string;
};

type TraceAttachmentRow = {
  id: string;
  message_id: string;
  turn_id: string;
  path: string;
  created_at: string;
};

type TraceApprovalRow = {
  turn_id: string;
  message_id: string | null;
  summary: string | null;
};

/**
 * The turns that share this plan, oldest first, each with what it handed over.
 *
 * A card is a turn. The edge into it is the turn that wrote its trigger; a trigger nobody's turn
 * wrote is you, so the trace grows a card for that message and points the woken turns at it.
 * A Bot woken by another Bot grows no such card — the waking turn is already on the board — and
 * neither does a routine firing, whose trigger is the app's system line.
 */
export function taskTrace(ctx: StoreContext, taskId: string): TaskTrace {
  const task = getTask(ctx, taskId);
  const turns = ctx.db
    .query<TraceTurnRow, [string]>(
      `SELECT t.id, t.session_id, t.bot_id, t.status, t.trigger_message_id, t.partial_text, t.ticket_id, t.created_at,
              m.body AS trigger_body, m.created_at AS trigger_created_at,
              m.turn_id AS trigger_turn_id, m.author AS trigger_author, m.kind AS trigger_kind
       FROM turns t
       JOIN messages m ON m.id = t.trigger_message_id
       WHERE t.task_id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
    )
    .all(taskId);
  const turnIds = new Set(turns.map((turn) => turn.id));

  const spoken = ctx.db
    .query<TraceMessageRow, [string]>(
      `SELECT id, turn_id, kind, body, created_at FROM messages
       WHERE task_id = ? AND turn_id IS NOT NULL AND kind IN ('bot', 'ask', 'system')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId);
  const lastWord = new Map<string, TraceMessageRow>();
  const askByTurn = new Map<string, TraceMessageRow>();
  // The 中断 line is what a cut turn leaves behind. It is written after the last word, so a
  // card that still points at that word lands one row above the note it is about.
  const interruptByTurn = new Map<string, TraceMessageRow>();
  for (const row of spoken) {
    if (!turnIds.has(row.turn_id)) continue;
    if (row.kind === "bot") lastWord.set(row.turn_id, row);
    else if (row.kind === "ask") askByTurn.set(row.turn_id, row);
    else if (row.body === INTERRUPT_NOTE_BODY) interruptByTurn.set(row.turn_id, row);
  }

  const attachments = ctx.db
    .query<TraceAttachmentRow, [string]>(
      // Keyed off this plan's turns rather than the message's own plan: a message written before
      // plans existed carries none, and its files would vanish from the card that produced them.
      `SELECT a.id, a.message_id, m.turn_id AS turn_id, a.workspace_relpath AS path, a.created_at
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN turns t ON t.id = m.turn_id
       WHERE t.task_id = ?
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(taskId);
  const filesByTurn = new Map<string, TaskTraceNode["artifacts"]>();
  // What you attached to the message that opened a stage belongs on your card, not on nobody's.
  const yourFiles = ctx.db
    .query<TraceAttachmentRow, [string]>(
      `SELECT a.id, a.message_id, m.turn_id AS turn_id, a.workspace_relpath AS path, a.created_at
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.turn_id IS NULL AND m.id IN (
         SELECT trigger_message_id FROM turns WHERE task_id = ?
       )
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(taskId);
  const filesByMessage = new Map<string, TaskTraceNode["artifacts"]>();
  for (const row of yourFiles) {
    const list = filesByMessage.get(row.message_id) ?? [];
    if (list.some((file) => file.path === row.path)) continue;
    list.push({ path: row.path, message_id: row.message_id, attachment_id: row.id });
    filesByMessage.set(row.message_id, list);
  }
  for (const row of attachments) {
    if (!turnIds.has(row.turn_id)) continue;
    if (isReservedTaskPath(task.dir, row.path)) continue;
    const list = filesByTurn.get(row.turn_id) ?? [];
    if (list.some((file) => file.path === row.path)) continue;
    list.push({ path: row.path, message_id: row.message_id, attachment_id: row.id });
    filesByTurn.set(row.turn_id, list);
  }

  const approvals = ctx.db
    .query<TraceApprovalRow, [string]>(
      `SELECT a.turn_id, a.message_id, a.summary
       FROM approvals a
       JOIN turns t ON t.id = a.turn_id
       WHERE t.task_id = ? AND a.status = 'pending' AND t.status = 'waiting_approval'
       ORDER BY a.created_at ASC`,
    )
    .all(taskId);
  const approvalByTurn = new Map<string, TraceApprovalRow>();
  for (const row of approvals) if (!approvalByTurn.has(row.turn_id)) approvalByTurn.set(row.turn_id, row);

  const watched = passersByMessage(ctx, turns.map((turn) => turn.trigger_message_id));

  const nodes: TaskTraceNode[] = [];
  const userCards = new Map<string, string>();
  /**
   * Who sent the message decides whose card this is — not whether its turn happens to be on this
   * board. A handoff from a plan that is not on screen used to be drawn as a line you wrote.
   */
  const sentByYou = (turn: TraceTurnRow) => turn.trigger_author === USER_MEMBER;
  for (const turn of turns) {
    const fromYou = sentByYou(turn);
    if (fromYou && !userCards.has(turn.trigger_message_id)) {
      userCards.set(turn.trigger_message_id, `user:${turn.trigger_message_id}`);
      nodes.push({
        turn_id: `user:${turn.trigger_message_id}`,
        session_id: turn.session_id,
        actor: USER_MEMBER,
        status: "completed",
        woken_by_turn_id: null,
        woken_elsewhere: null,
        trigger_message_id: turn.trigger_message_id,
        focus_message_id: turn.trigger_message_id,
        summary: oneLine(turn.trigger_body),
        created_at: turn.trigger_created_at,
        artifacts: filesByMessage.get(turn.trigger_message_id) ?? [],
        ask: null,
        approval: null,
        passed: watched.get(turn.trigger_message_id) ?? 0,
        ticket_id: null,
      });
    }
  }
  for (const turn of turns) {
    const fromYou = sentByYou(turn);
    const onBoard = Boolean(turn.trigger_turn_id && turnIds.has(turn.trigger_turn_id));
    const wokenBy = fromYou
      ? (userCards.get(turn.trigger_message_id) ?? null)
      : onBoard
        ? turn.trigger_turn_id
        : null;
    // A system line no turn wrote is the app waking the Bot (a routine firing): nobody handed it over.
    const byApp = turn.trigger_kind === "system" && !turn.trigger_turn_id;
    // Woken by someone whose turn belongs to another plan: say so rather than inventing a card.
    const elsewhere = fromYou || onBoard || byApp
      ? null
      : { actor: turn.trigger_author, message_id: turn.trigger_message_id };
    const word = lastWord.get(turn.id);
    const ask = turn.status === "waiting_ask" ? askByTurn.get(turn.id) : undefined;
    const pending = turn.status === "waiting_approval" ? approvalByTurn.get(turn.id) : undefined;
    const cut = turn.status === "interrupted" ? interruptByTurn.get(turn.id) : undefined;
    // Only a turn still writing shows its partial. Waiting on you already has a sentence to show.
    const summary = turn.status === "running" && turn.partial_text?.trim()
      ? oneLine(turn.partial_text)
      : word
        ? oneLine(word.body)
        : oneLine(turn.trigger_body);
    nodes.push({
      turn_id: turn.id,
      session_id: turn.session_id,
      actor: turn.bot_id,
      status: turn.status,
      woken_by_turn_id: wokenBy,
      woken_elsewhere: elsewhere,
      trigger_message_id: turn.trigger_message_id,
      focus_message_id: cut?.id ?? ask?.id ?? word?.id ?? turn.trigger_message_id,
      summary,
      created_at: turn.created_at,
      artifacts: filesByTurn.get(turn.id) ?? [],
      ask: ask ? { message_id: ask.id, question: oneLine(ask.body) } : null,
      approval: pending ? { message_id: pending.message_id, summary: oneLine(pending.summary ?? "") } : null,
      passed: fromYou ? 0 : (watched.get(turn.trigger_message_id) ?? 0),
      ticket_id: turn.ticket_id ?? null,
    });
  }
  nodes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.turn_id.localeCompare(b.turn_id));
  return {
    id: task.id,
    dir: task.dir,
    title: task.title,
    session_id: task.session_id,
    closed_at: task.closed_at,
    nodes,
  };
}

/** How many Bots watched a trigger instead of joining. A message nobody judged returns nothing. */
function passersByMessage(ctx: StoreContext, messageIds: string[]): Map<string, number> {
  const unique = [...new Set(messageIds)];
  const counts = new Map<string, number>();
  if (unique.length === 0) return counts;
  const marks = unique.map(() => "?").join(", ");
  const rows = ctx.db
    .query<{ message_id: string; n: number }, string[]>(
      `SELECT message_id, COUNT(*) AS n FROM judgements
       WHERE decision = 'pass' AND message_id IN (${marks})
       GROUP BY message_id`,
    )
    .all(...unique);
  for (const row of rows) counts.set(row.message_id, row.n);
  return counts;
}

type SummaryRow = Task & { last_activity_at: string };

const TICKET_STATUSES_FOR_COUNTS: readonly TicketStatus[] = ["todo", "doing", "review", "done", "parked"];

function emptyTicketCounts(): Record<TicketStatus, number> {
  return { todo: 0, doing: 0, review: 0, done: 0, parked: 0 };
}

/** How many tickets each plan has in each state, for the switcher rows and the plan events. */
export function ticketCountsFor(ctx: StoreContext, taskIds: readonly string[]): Map<string, Record<TicketStatus, number>> {
  const out = new Map<string, Record<TicketStatus, number>>();
  const unique = [...new Set(taskIds)];
  for (const id of unique) out.set(id, emptyTicketCounts());
  if (unique.length === 0) return out;
  const marks = unique.map(() => "?").join(", ");
  const rows = ctx.db
    .query<{ task_id: string; status: TicketStatus; n: number }, string[]>(
      `SELECT task_id, status, COUNT(*) AS n FROM tickets WHERE task_id IN (${marks}) GROUP BY task_id, status`,
    )
    .all(...unique);
  for (const row of rows) {
    const counts = out.get(row.task_id);
    if (counts && (TICKET_STATUSES_FOR_COUNTS as readonly string[]).includes(row.status)) counts[row.status] = row.n;
  }
  return out;
}

/** The switcher row for one plan: the stored row plus what the organizer says it is for. */
export function taskSummary(ctx: StoreContext, task: Task, lastActivityAt: string, counts?: Record<TicketStatus, number>): SessionTaskSummary {
  const spec = parsePlanSpec(task.spec);
  return {
    id: task.id,
    dir: task.dir,
    title: task.title,
    session_id: task.session_id,
    closed_at: task.closed_at,
    last_activity_at: lastActivityAt,
    goal: spec?.goal ?? null,
    kind: task.kind,
    status: task.status,
    ticket_counts: counts ?? ticketCountsFor(ctx, [task.id]).get(task.id) ?? emptyTicketCounts(),
  };
}

/** When a plan last moved: its newest turn, else its creation. */
export function taskLastActivityAt(ctx: StoreContext, taskId: string): string {
  const row = ctx.db
    .query<{ at: string | null }, [string]>(`SELECT MAX(last_activity_at) AS at FROM turns WHERE task_id = ?`)
    .get(taskId);
  return row?.at ?? getTask(ctx, taskId).created_at;
}

/**
 * The plans a session took part in, newest activity first: a turn here, or a message here, carries
 * the plan even when it was opened in some other session.
 */
export function sessionTasks(ctx: StoreContext, sessionId: string): SessionTaskSummary[] {
  sessionRow(ctx, sessionId);
  const rows = ctx.db
    .query<SummaryRow, [string, string]>(
      `SELECT t.*,
              COALESCE(
                (SELECT MAX(last_activity_at) FROM turns WHERE turns.task_id = t.id),
                t.created_at
              ) AS last_activity_at
       FROM tasks t
       WHERE EXISTS (SELECT 1 FROM turns WHERE turns.task_id = t.id AND turns.session_id = ?)
          OR EXISTS (SELECT 1 FROM messages WHERE messages.task_id = t.id AND messages.session_id = ?)
       ORDER BY last_activity_at DESC, t.id DESC`,
    )
    .all(sessionId, sessionId);
  const counts = ticketCountsFor(ctx, rows.map((row) => row.id));
  return rows.map((row) => taskSummary(ctx, row, row.last_activity_at, counts.get(row.id)));
}

/** Plans this session could go back to: the ones it took part in, minus routine plans and the current one. */
export function sessionRecentTasks(ctx: StoreContext, sessionId: string, limit = 8): Task[] {
  const current = sessionCurrentTask(ctx, sessionId);
  const out: Task[] = [];
  for (const summary of sessionTasks(ctx, sessionId)) {
    if (summary.id === current?.id) continue;
    let task: Task;
    try {
      task = getTask(ctx, summary.id);
    } catch {
      continue;
    }
    if (task.routine_id) continue;
    out.push(task);
    if (out.length >= limit) break;
  }
  return out;
}

function oneLine(body: string): string {
  // A card is one sentence. A markdown link would spend it on the address.
  const flat = body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  const cut = takeCodePoints(flat, SUMMARY_MAX);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

/**
 * Which plan and ticket a turn about to be opened belongs to.
 *
 * Named outright (a check-back, a batch of annotations) wins. A trigger some turn produced carries
 * that turn's plan and ticket: handoff, mention, a judgement that joined, a Bot↔Bot direct, the
 * interrupt note. A user message the organizer already filed carries its own stamp. Otherwise the
 * turn joins the session's current plan, and only when there is none does it open one — no clock
 * ever closes a plan; the organizer does.
 */
export function resolveTurnTask(
  ctx: StoreContext,
  input: {
    sessionId: string;
    trigger: { id?: string; body: string; turn_id: string | null; task_id?: string | null; ticket_id?: string | null };
    /**
     * The plan this turn continues, named outright: a batch of annotations wakes the Bot to fix
     * the delivery, so the turn works in the folder the artifact came from — however long the
     * session has been quiet, and even if that plan was closed since.
     */
    taskId?: string | null;
    ticketId?: string | null;
    now?: Date;
  },
): { taskId: string; ticketId: string | null } {
  const at = input.now ?? new Date();
  if (input.taskId) {
    reopenTask(ctx, input.taskId, input.sessionId);
    return { taskId: input.taskId, ticketId: input.ticketId ?? null };
  }
  if (input.trigger.turn_id) {
    const inherited = ctx.db
      .query<{ task_id: string | null; ticket_id: string | null }, [string]>(
        `SELECT task_id, ticket_id FROM turns WHERE id = ?`,
      )
      .get(input.trigger.turn_id);
    if (inherited?.task_id) return { taskId: inherited.task_id, ticketId: inherited.ticket_id ?? null };
  }
  if (input.trigger.task_id) {
    const stamped = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE id = ?`).get(input.trigger.task_id);
    if (stamped) return { taskId: input.trigger.task_id, ticketId: input.trigger.ticket_id ?? null };
  }
  const current = sessionCurrentTask(ctx, input.sessionId);
  if (current) return { taskId: current.id, ticketId: null };
  return {
    taskId: openTask(ctx, {
      sessionId: input.sessionId,
      title: input.trigger.body,
      brief: input.trigger.body,
      now: at,
    }).id,
    ticketId: null,
  };
}

/**
 * Put a plan back in front for a turn that continues it. In the plan's own session it stops being
 * closed and is active again, and that session's other current plan is parked the way it would be
 * when a new one opens — one current plan per session. A turn in another session (a batch on a
 * routed Bot↔Bot delivery wakes a turn in your direct with that Bot) works in the plan through its
 * own id and reopens nothing. A routine's standing plan is never the current one, so it is left as
 * it is. A closed plan only has its closing moved to now, so the tool-results sweep leaves the
 * turn's files.
 */
export function reopenTask(ctx: StoreContext, id: string, sessionId: string): void {
  const task = getTask(ctx, id);
  const now = isoNow();
  if (task.routine_id) return;
  if (task.session_id !== sessionId) {
    if (task.closed_at) ctx.db.run(`UPDATE tasks SET closed_at = ? WHERE id = ?`, [now, id]);
    return;
  }
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE tasks SET closed_at = ?, status = CASE WHEN status = 'active' THEN 'parked' ELSE status END
       WHERE session_id = ? AND closed_at IS NULL AND routine_id IS NULL AND id != ?`,
      [now, sessionId, id],
    );
    ctx.db.run(`UPDATE tasks SET closed_at = NULL, status = 'active' WHERE id = ?`, [id]);
  })();
}

function uniqueDir(ctx: StoreContext, input: { title: string; id: string }): string {
  for (const suffixLength of [4, 8, 26]) {
    const dir = taskDirName({ ...input, suffixLength });
    const taken = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE dir = ?`).get(dir);
    if (!taken) return dir;
  }
  // Three collisions on the same id is not reachable; a stable fallback beats a throw here.
  return `${WORK_ROOT}/${input.id.toLowerCase()}`;
}

/** `YYYY-MM-DD` in the machine's local time: how a routine's ticket for the day is named. */
export function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

export function idSuffix(id: string, length: number): string {
  return id.slice(-length).toLowerCase();
}

/**
 * Sanitize before clipping, so a title that opens with separators (`../../etc/passwd`) spends the
 * budget on words rather than on the junk that gets stripped anyway.
 */
export function slugify(title: string, max = SLUG_MAX): string {
  const safe = [...title]
    .map((ch) => (UNSAFE.test(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return takeCodePoints(safe, max).text.replace(/[-.]+$/, "");
}
