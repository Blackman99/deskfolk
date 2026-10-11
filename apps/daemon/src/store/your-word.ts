/**
 * Letting work through by your word (ADR 0084). A hand-over that waits on you has no card: the Bot
 * that made it has told you what it handed over, and what you say next is your verdict, the way your
 * next word ends a stop (ADR 0081). The reader is shown the hand-overs waiting on you where you speak
 * (`waitingOnYourWord`) and names the ones your line lets through — a nod, using it, going on to the
 * next step, or in your direct with its Bot moving on to something else; a fault found sends it back
 * instead (`noteComplaint`, ADR 0070). Before, 放行 was only ever a press: 「打字永远不算放行」.
 */
import type { Message } from "@real-bot/protocol";
import { isoNow } from "../ids";
import type { ReadingSource } from "../line-reading";
import { allJobConversations, jobConversations } from "./job-conversations";
import { yoursToApprove } from "./large-jobs";
import { markPassedLine } from "./review-cards";
import type { StoreContext } from "./shared";
import { boundCheckIds, checkResults, fileNames, getSubmission, supervised, toSubmission, truncatedAnswer, type AwaitingYou, type Submission, type SubmissionRow } from "./submission-rows";
import { resolveApproval, workOnYourLine } from "./submissions";
import { STAGE_SQL } from "./ticket-stage";

/** At most this many hand-overs are shown to a reading of one line: the latest ones. */
const SHOWN_MAX = 6;

/** A hand-over a line of yours may let through, as a reading is shown it. */
export type WaitingHandOver = {
  submission_id: string;
  /** Who handed it over. */
  bot: string;
  /** The job, and the ticket of it. */
  job: string;
  ticket: string;
  /** The files' names, the words handed over, or that the organizer read the ticket as done. */
  what: string;
  /** A large job's sample: only a clear yes lets it through (the rest of the job waits on it). */
  sample: boolean;
  created_at: string;
};

/** Whether a line said in `sessionId` is said where you and the Bot that made it talk about this job. */
function spokenHere(ctx: StoreContext, submission: Pick<Submission, "task_id" | "bot_id">, sessionId: string): boolean {
  if (!allJobConversations(jobConversations(ctx, submission.task_id)).includes(sessionId)) return false;
  return Boolean(ctx.db.query(`SELECT 1 FROM sessions s
    JOIN session_participants u ON u.session_id = s.id AND u.member = 'user' AND u.left_at IS NULL
    WHERE s.id = ?1 AND s.archived_at IS NULL AND (s.kind = 'group' OR (s.kind = 'direct' AND EXISTS (SELECT 1
      FROM session_participants b WHERE b.session_id = s.id AND b.member = ?2 AND b.left_at IS NULL)))`).get(sessionId, submission.bot_id));
}

/**
 * The hand-overs a line of yours said in `sessionId` at `before` may let through: handed over before
 * it and still open — waiting on your word, or not taken up yet (your word comes first) — but not
 * one a reviewer is at work on; of a job worked on with you here, by a Bot you can talk to here; and
 * not one whose Bot is at work on something you said about it since, which is what you will look at
 * next. The latest {@link SHOWN_MAX}, oldest first.
 */
export function waitingOnYourWord(ctx: StoreContext, input: { sessionId: string; before: string }): WaitingHandOver[] {
  if (!supervised(ctx)) return [];
  const rows = ctx.db.query<SubmissionRow, [string]>(`SELECT s.* FROM submissions s JOIN tickets t ON t.id = s.ticket_id
    WHERE s.state IN ('submitted', 'in_review') AND ${STAGE_SQL("t")} IN ('submitted', 'in_review') AND s.created_at <= ?
      AND NOT (s.state = 'in_review' AND s.awaiting IS NULL)
    ORDER BY s.created_at DESC, s.rowid DESC LIMIT 40`).all(input.before).map(toSubmission);
  const shown: WaitingHandOver[] = [];
  for (const submission of rows) {
    if (shown.length >= SHOWN_MAX) break;
    if (submission.awaiting?.pending) continue;
    if (!spokenHere(ctx, submission, input.sessionId) || workOnYourLine(ctx, submission)) continue;
    const names = ctx.db.query<{ bot: string | null; job: string | null; ticket: string | null }, [string, string, string]>(`SELECT
      (SELECT name FROM bots WHERE id = ?1) AS bot, (SELECT title FROM tasks WHERE id = ?2) AS job, (SELECT title FROM tickets WHERE id = ?3) AS ticket`)
      .get(submission.bot_id, submission.task_id, submission.ticket_id);
    const what = submission.origin === "answer" ? `「${truncatedAnswer(submission.content ?? "")}」`
      : submission.origin === "organizer" ? "（没交文件：整理跳读成这张任务做完了）"
      : fileNames(submission, false);
    shown.push({ submission_id: submission.id, bot: names?.bot ?? submission.bot_id, job: names?.job ?? "", ticket: names?.ticket ?? "",
      what, sample: yoursToApprove(ctx, submission.ticket_id) === "sample", created_at: submission.created_at });
  }
  return shown.reverse();
}

/**
 * Your line let these hand-overs through, as the reader read it (a model's reading only: the word
 * lists never let anything through). Each still waiting where the line was said is let through as
 * 放行 on its card always did — on its checks as they are now, a gate failing sends it back, one not
 * run yet is waited for (returned in `toRun`, for the engine to run, then `takeUpPendingApproval`) —
 * logged as yours with your line. Your line then says what came of it (`control.kind = "passed"`),
 * with no undo: a fault you find later sends it back like any approved work. Returns your line, marked.
 */
export function passByYourWord(
  ctx: StoreContext,
  messageId: string,
  input: { passes?: readonly string[]; source?: ReadingSource; now?: string } = {},
): { lines: Message[]; toRun: Array<{ submission: Submission; checkIds: string[] }> } {
  return ctx.commit(() => {
    const none = { lines: [], toRun: [] };
    if (!supervised(ctx) || input.source !== "model" || !input.passes?.length) return none;
    const line = ctx.db.query<{ kind: string; session_id: string; created_at: string }, [string]>(
      "SELECT kind, session_id, created_at FROM messages WHERE id = ?").get(messageId);
    if (!line || line.kind !== "user") return none;
    // What still waits where it was said, now: a reading takes a few seconds, and the work moves on.
    const waiting = new Set(waitingOnYourWord(ctx, { sessionId: line.session_id, before: line.created_at }).map((row) => row.submission_id));
    const now = input.now ?? isoNow();
    const passed: string[] = [];
    const toRun: Array<{ submission: Submission; checkIds: string[] }> = [];
    for (const id of new Set(input.passes)) {
      if (!waiting.has(id)) continue;
      const before = getSubmission(ctx, id);
      const checks = checkResults(ctx, boundCheckIds(ctx, before), before.created_at);
      const unrun = checks.filter((check) => check.gate && check.outcome === "not_run").map((check) => check.check_id);
      const awaiting: AwaitingYou = { ...(before.awaiting ?? { requirement_ids: [], check_ids: [], message_id: null, review: null, at: now }),
        kind: "approval", line_id: messageId, ...(unrun.length > 0 ? { pending: true } : {}) };
      ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify(awaiting), now, id]);
      passed.push(id);
      if (unrun.length > 0) toRun.push({ submission: getSubmission(ctx, id), checkIds: unrun });
      else resolveApproval(ctx, getSubmission(ctx, id), checks, now);
    }
    const marked = passed.length > 0 ? markPassedLine(ctx, messageId, passed) : null;
    return { lines: marked ? [marked] : [], toRun };
  });
}
