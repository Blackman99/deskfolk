/**
 * The work dir a job's intermediate files live in.
 *
 * It is not a scheduler entity: no status beyond open/closed, no assignee, no steps, no plan. Its
 * identity is the turn tree one trigger opens — a handoff arrives as a message some turn produced,
 * so the woken turn inherits that turn's dir and the folder follows the work across Bots and
 * sessions without anyone routing it. A session holds at most one open dir; opening a new one
 * closes it. A dir nobody has touched for {@link TASK_QUIET_MS} is no longer joinable, so a long
 * lived you↔Bot direct does not pour every job of the year into one folder.
 */
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { sessionRow, type StoreContext } from "./shared";

export type Task = {
  id: string;
  /** Null once the session it was opened in is deleted; the dir and its turns stay. */
  session_id: string | null;
  title: string;
  dir: string;
  created_at: string;
  closed_at: string | null;
};

/** Long enough to survive a coffee break, short enough that the next job gets its own folder. */
export const TASK_QUIET_MS = 6 * 60 * 60_000;

/** The reserved root every work dir lives under, so the workspace top level stays the user's. */
export const WORK_ROOT = "work";

/** Reserved subdirs inside a work dir. Nothing written here is ever cited as an artifact. */
export const RESERVED_SUBDIRS = ["tool-results", "scratch"] as const;

const TITLE_MAX = 40;
const SLUG_MAX = 12;
/** Path separators, the Windows-reserved set, and control characters. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

export function taskTitle(body: string): string {
  return takeCodePoints(body.replace(/\s+/g, " ").trim(), TITLE_MAX).text;
}

/**
 * `work/2026-09-21-导出季度报表-7f3k`. The date sorts the folder list the way a human reads it;
 * CJK is kept as-is because the workspace is APFS, not a URL. The id suffix is what actually keeps
 * two same-day jobs with the same opening words apart.
 */
export function taskDirName(input: { title: string; id: string; at: Date; suffixLength?: number }): string {
  const parts = [localDate(input.at)];
  const slug = slugify(input.title);
  if (slug) parts.push(slug);
  parts.push(idSuffix(input.id, input.suffixLength ?? 4));
  return `${WORK_ROOT}/${parts.join("-")}`;
}

/** Whether a workspace-relative path sits in a work dir's reserved subdir. */
export function isReservedTaskPath(dir: string, relpath: string): boolean {
  return RESERVED_SUBDIRS.some((name) => relpath.startsWith(`${dir}/${name}/`));
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

/** The work dir a turn works in. Null on turns from before work dirs. */
export function turnWorkDir(ctx: StoreContext, turnId: string): string | null {
  const taskId = taskOfTurn(ctx, turnId);
  if (!taskId) return null;
  try {
    return getTask(ctx, taskId).dir;
  } catch {
    return null;
  }
}

/** The session's open work dir, if it is still within the quiet window. */
export function joinableTask(ctx: StoreContext, sessionId: string, notBefore: string): Task | null {
  return (
    ctx.db
      .query<Task, [string, string]>(
        `SELECT t.* FROM tasks t
         WHERE t.session_id = ? AND t.closed_at IS NULL
           AND COALESCE(
                 (SELECT MAX(last_activity_at) FROM turns WHERE turns.task_id = t.id),
                 t.created_at
               ) >= ?
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 1`,
      )
      .get(sessionId, notBefore) ?? null
  );
}

export type TaskArtifact = {
  path: string;
  last_cited_at: string;
  turn_id: string | null;
};

/**
 * Relevance is "somebody cited it", not "it sits in the work dir" and not "this turn wrote it".
 * Listing the folder would hand back the daemon's spill and every throwaway; listing one turn
 * would drop whatever the Bot before the handoff produced. The union of what this job's messages
 * cited is the set a reader actually wants, and it is already recorded.
 */
export function taskArtifacts(ctx: StoreContext, taskId: string, limit = 200): TaskArtifact[] {
  getTask(ctx, taskId);
  return ctx.db
    .query<TaskArtifact, [string, number]>(
      `SELECT a.workspace_relpath AS path,
              MAX(m.created_at) AS last_cited_at,
              MAX(m.turn_id) AS turn_id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.task_id = ?
       GROUP BY a.workspace_relpath
       ORDER BY last_cited_at DESC, path ASC
       LIMIT ?`,
    )
    .all(taskId, limit);
}

export function openTask(
  ctx: StoreContext,
  input: { sessionId: string; title: string; now?: Date },
): Task {
  sessionRow(ctx, input.sessionId);
  const at = input.now ?? new Date();
  const now = isoNow();
  const id = ulid(at.getTime());
  const title = taskTitle(input.title);
  ctx.db.transaction(() => {
    // One open dir per session: the new job takes over, the old one stops accepting follow-ups.
    ctx.db.run(`UPDATE tasks SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL`, [
      now,
      input.sessionId,
    ]);
    ctx.db.run(
      `INSERT INTO tasks (id, session_id, title, dir, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [id, input.sessionId, title, uniqueDir(ctx, { title, id, at }), now],
    );
  })();
  return getTask(ctx, id);
}

/**
 * Work dirs whose job ended long enough ago that the daemon's own spill in them is dead weight.
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
  ctx.db.run(`UPDATE tasks SET closed_at = ? WHERE id = ? AND closed_at IS NULL`, [isoNow(), id]);
}

/**
 * Which work dir a turn about to be opened belongs to.
 *
 * A trigger some turn produced carries that turn's dir: handoff, mention, a judgement that joined,
 * a Bot↔Bot direct, and the interrupt note all land here. Everything else is the user (or a
 * routine) speaking, and joins the session's open dir unless the caller says this is a fresh job.
 */
export function resolveTurnTask(
  ctx: StoreContext,
  input: {
    sessionId: string;
    trigger: { body: string; turn_id: string | null };
    /** A routine fires as a user message, so only the caller can say it is a new job. */
    newTask?: boolean;
    now?: Date;
  },
): string {
  const at = input.now ?? new Date();
  if (input.trigger.turn_id) {
    const inherited = taskOfTurn(ctx, input.trigger.turn_id);
    if (inherited) return inherited;
  }
  if (!input.newTask) {
    const open = joinableTask(ctx, input.sessionId, quietFloor(at));
    if (open) return open.id;
  }
  return openTask(ctx, { sessionId: input.sessionId, title: input.trigger.body, now: at }).id;
}

function quietFloor(at: Date): string {
  return new Date(at.getTime() - TASK_QUIET_MS).toISOString();
}

function uniqueDir(ctx: StoreContext, input: { title: string; id: string; at: Date }): string {
  for (const suffixLength of [4, 8, 26]) {
    const dir = taskDirName({ ...input, suffixLength });
    const taken = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE dir = ?`).get(dir);
    if (!taken) return dir;
  }
  // Three collisions on the same id is not reachable; a stable fallback beats a throw here.
  return `${WORK_ROOT}/${input.id.toLowerCase()}`;
}

function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

function idSuffix(id: string, length: number): string {
  return id.slice(-length).toLowerCase();
}

/**
 * Sanitize before clipping, so a title that opens with separators (`../../etc/passwd`) spends the
 * budget on words rather than on the junk that gets stripped anyway.
 */
function slugify(title: string): string {
  const safe = [...title]
    .map((ch) => (UNSAFE.test(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return takeCodePoints(safe, SLUG_MAX).text.replace(/[-.]+$/, "");
}
