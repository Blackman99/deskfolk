/**
 * The work dir a job's intermediate files live in.
 *
 * It is not a scheduler entity: no status beyond open/closed, no assignee, no steps, no plan. Its
 * identity is the turn tree one trigger opens — a handoff arrives as a message some turn produced,
 * so the woken turn inherits that turn's dir and the folder follows the work across Bots and
 * sessions without anyone routing it. A session holds at most one open dir; opening a new one
 * closes it. A dir nobody has touched for {@link TASK_QUIET_MS} is no longer joinable, so a long
 * lived you↔Bot direct does not pour every job of the year into one folder.
 *
 * The trace is that same tree read back: one card per turn, edges from who woke whom, files from
 * the attachments those turns already cited. Nothing is inferred and nothing is written.
 */
import { INTERRUPT_NOTE_BODY, USER_MEMBER, type SessionTaskSummary, type TaskTrace, type TaskTraceNode, type TurnStatus } from "@real-bot/protocol";
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
 *
 * A cited file that has since been deleted is left out (`present` says which are still there):
 * the list is for opening files, and a row that can only answer "file is gone" is not one. The
 * cap counts what survives, so deleted files never crowd live ones out of it.
 */
export function taskArtifacts(
  ctx: StoreContext,
  taskId: string,
  present: (path: string) => boolean,
  limit = 200,
): TaskArtifact[] {
  getTask(ctx, taskId);
  const cited = ctx.db
    .query<TaskArtifact, [string]>(
      `SELECT a.workspace_relpath AS path,
              MAX(m.created_at) AS last_cited_at,
              MAX(m.turn_id) AS turn_id
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
    if (present(row.path)) out.push(row);
  }
  return out;
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

/** One line on a card. A paragraph would turn the board into the transcript it points at. */
const SUMMARY_MAX = 80;

type TraceTurnRow = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  partial_text: string | null;
  created_at: string;
  trigger_body: string;
  trigger_created_at: string;
  trigger_turn_id: string | null;
  trigger_author: string;
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
 * The turns that share this work dir, oldest first, each with what it handed over.
 *
 * A card is a turn. The edge into it is the turn that wrote its trigger; a trigger nobody's turn
 * wrote is you, so the trace grows a card for that message and points the woken turns at it.
 * A Bot woken by another Bot grows no such card — the waking turn is already on the board.
 */
export function taskTrace(ctx: StoreContext, taskId: string): TaskTrace {
  const task = getTask(ctx, taskId);
  const turns = ctx.db
    .query<TraceTurnRow, [string]>(
      `SELECT t.id, t.session_id, t.bot_id, t.status, t.trigger_message_id, t.partial_text, t.created_at,
              m.body AS trigger_body, m.created_at AS trigger_created_at,
              m.turn_id AS trigger_turn_id, m.author AS trigger_author
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
      // Keyed off this job's turns rather than the message's own job: a message written before
      // jobs existed carries none, and its files would vanish from the card that produced them.
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
   * board. A handoff from a job that is not on screen used to be drawn as a line you wrote.
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
    // Woken by someone whose turn belongs to another job: say so rather than inventing a card.
    const elsewhere = fromYou || onBoard
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

/**
 * The jobs a session took part in, newest activity first: a turn here, or a message here, carries
 * the job even when the work dir was opened in some other session.
 */
export function sessionTasks(ctx: StoreContext, sessionId: string): SessionTaskSummary[] {
  sessionRow(ctx, sessionId);
  return ctx.db
    .query<SessionTaskSummary, [string, string]>(
      `SELECT t.id, t.dir, t.title, t.session_id, t.closed_at,
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
}

function oneLine(body: string): string {
  // A card is one sentence. A markdown link would spend it on the address.
  const flat = body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  const cut = takeCodePoints(flat, SUMMARY_MAX);
  return cut.truncated ? `${cut.text}…` : cut.text;
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
    /**
     * The job this turn continues, named outright: a batch of annotations wakes the Bot to fix
     * the delivery, so the turn works in the folder the artifact came from — however long the
     * session has been quiet, and even if that job was closed since.
     */
    taskId?: string | null;
    now?: Date;
  },
): string {
  const at = input.now ?? new Date();
  if (input.taskId) {
    reopenTask(ctx, input.taskId, input.sessionId);
    return input.taskId;
  }
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

/**
 * Put a job back in front for a turn that continues it. In the job's own session it stops being
 * closed, and that session's other open job closes the way it would when a new one opens — one
 * open dir per session. A turn in another session (a batch on a routed Bot↔Bot delivery wakes a
 * turn in your direct with that Bot) works in the job through its own task id and reopens nothing:
 * the job's own session keeps joining whatever it joins now, and your job there stays open. A
 * closed job only has its closing moved to now, so the tool-results sweep leaves the turn's files.
 */
export function reopenTask(ctx: StoreContext, id: string, sessionId: string): void {
  const task = getTask(ctx, id);
  const now = isoNow();
  if (task.session_id !== sessionId) {
    if (task.closed_at) ctx.db.run(`UPDATE tasks SET closed_at = ? WHERE id = ?`, [now, id]);
    return;
  }
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE tasks SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL AND id != ?`, [now, sessionId, id]);
    ctx.db.run(`UPDATE tasks SET closed_at = NULL WHERE id = ?`, [id]);
  })();
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
