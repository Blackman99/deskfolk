/** What a review has to show for each required item: checks, your confirmations, frames read. */
import { HttpError } from "../errors";
import { yoursToApprove } from "./large-jobs";
import { requirementsBearingOn } from "./requirements";
import type { StoreContext } from "./shared";
import { backs, checkResults, ORIGIN_NEEDS_USER, plainPath, supervised, type RequiredItem, type ReviewRecord, type ReviewVerdict, type Submission, type SubmissionCheck } from "./submission-rows";
import { recordWorkEvent } from "./work-events";

/** Categories about the picture: their pass needs frames of the delivery read in the reviewing segment (§2.8 `review`). */
const VISUAL_CATEGORY = /画面|视觉|背景|角色|人物|镜头|构图|颜色|色调|光|造型|外观|动作|转场|分镜|场景|visual|image|frame|shot|scene|colou?r|light|character/i;
/** An image file, as the evidence a Bot looked at frames. */
export const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;

/**
 * What a review must judge (§6.5 2, ADR 0046): of the open requirements bearing on the
 * submission's plan and ticket, those you raised twice or more and those about the picture. The rest
 * may be judged n/a. What a check stands on is decided by the check itself once you confirm it.
 */
export function requiredItems(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id">): RequiredItem[] {
  return requirementsHere(ctx, submission)
    .flatMap((entry) => {
      const reasons: RequiredItem["reasons"] = [];
      if (entry.times_raised >= 2) reasons.push("raised");
      if (entry.category && VISUAL_CATEGORY.test(entry.category)) reasons.push("visual");
      return reasons.length > 0 ? [{ requirement_id: entry.id, quote: entry.quote, reasons, times_raised: entry.times_raised }] : [];
    });
}

/** The open requirements in force for a submission's ticket: its plan's, its own, the conversation's and standing ones, not another ticket's or a part's. */
function requirementsHere(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id">) {
  return requirementsBearingOn(ctx, submission.task_id, ["open"])
    .filter((entry) => !entry.excluded && !(entry.scope === "ticket" && entry.scope_id !== submission.ticket_id) && entry.scope !== "part");
}

/**
 * Whether a review gives evidence on anything that bears on the hand-over: a pass or fail, with
 * evidence, on a requirement in force here — not on an id it made up, and not an empty list.
 */
function hasEvidence(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id">, verdicts: readonly ReviewVerdict[]): boolean {
  const here = new Set(requirementsHere(ctx, submission).map((entry) => entry.id));
  return verdicts.some((verdict) => (verdict.verdict === "pass" || verdict.verdict === "fail") && verdict.evidence.length > 0 && here.has(verdict.requirement_id));
}

/** The checks standing on a requirement's words: those read from a line of yours that raised it. */
function itemCheckIds(ctx: StoreContext, taskId: string, requirementId: string): string[] {
  return ctx.db.query<{ id: string }, [string, string]>(`SELECT c.id FROM acceptance_checks c WHERE c.task_id = ?1 AND c.removed_at IS NULL AND c.quote_id IS NOT NULL
    AND (c.quote_id IN (SELECT quote_id FROM requirement_mentions WHERE requirement_id = ?2)
      OR c.quote_id = (SELECT source_quote_id FROM requirements WHERE id = ?2)) ORDER BY c.created_at, c.id`).all(taskId, requirementId).map((row) => row.id);
}

function confirmedByYou(ctx: StoreContext, submissionId: string, requirementId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'review.item_confirmed' AND json_extract(payload, '$.submission_id') = ?1
    AND EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.requirement_ids')) WHERE value = ?2)`).get(submissionId, requirementId));
}

/**
 * The required items nothing backs for this submission: no passing check (measured since it was
 * made) stands on them and you have not said they are met. `which` narrows to the ones a same-model
 * pass leaves open (raised twice or more), or all of them (no review at all).
 */
export function unbackedItems(ctx: StoreContext, submission: Submission, which: "raised" | "all"): Array<RequiredItem & { checks: SubmissionCheck[] }> {
  return requiredItems(ctx, submission)
    .filter((item) => which === "all" || item.reasons.includes("raised"))
    .flatMap((item) => {
      if (confirmedByYou(ctx, submission.id, item.requirement_id)) return [];
      const checks = checkResults(ctx, itemCheckIds(ctx, submission.task_id, item.requirement_id), submission.created_at);
      // Only a check in force that passed backs it: a proposal that passes may be a misread
      // number (ADR 0042: a misread costs a card), so it is shown on the card, not taken as backing.
      return checks.some(backs) ? [] : [{ ...item, checks }];
    });
}

export function cleanVerdicts(raw: unknown): ReviewVerdict[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 200) throw new HttpError(422, "invalid_args", "verdicts must be a list");
  return raw.map((entry) => {
    const row = entry as Record<string, unknown>;
    const verdict = row?.verdict;
    if (!row || typeof row.requirement_id !== "string" || !["pass", "fail", "unknown", "n/a"].includes(verdict as string)) {
      throw new HttpError(422, "invalid_args", "each verdict needs requirement_id and verdict: pass, fail, unknown or n/a");
    }
    const evidence = Array.isArray(row.evidence) ? row.evidence.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.slice(0, 500)).slice(0, 20) : [];
    return { requirement_id: row.requirement_id, verdict: verdict as ReviewVerdict["verdict"], evidence };
  });
}

/**
 * Whether the segment read a picture of this job after the submission was made: an image inside the
 * plan's folder (its tickets' included), read with `read_file` (`artifact.viewed`, {@link
 * recordFrameRead}) — what a pass on anything about the picture needs. Kept in the work log rather
 * than among the commands a turn ran, so looking at a picture never counts as having run a test.
 */
export function framesRead(ctx: StoreContext, turnId: string, submission: Pick<Submission, "task_id" | "created_at">): boolean {
  const dir = ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tasks WHERE id = ?").get(submission.task_id)?.dir;
  if (!dir) return false;
  return ctx.db.query<{ path: string | null }, [string, string]>(`SELECT json_extract(payload, '$.path') AS path FROM work_events
    WHERE kind = 'artifact.viewed' AND turn_id = ? AND at >= ?`).all(turnId, submission.created_at)
    .some((row) => Boolean(row.path && row.path.startsWith(`${dir}/`) && plainPath(row.path) && IMAGE_PATH.test(row.path)));
}

/**
 * A picture a segment read with `read_file`, from engine level 5: the evidence a reviewer looked at
 * frames. Kept once per path and segment, however often it is read, and never capped the way a
 * turn's commands are.
 */
export function recordFrameRead(ctx: StoreContext, input: { turnId: string; path: string }): boolean {
  if (!supervised(ctx) || !IMAGE_PATH.test(input.path)) return false;
  return ctx.commit(() => {
    const turn = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; session_id: string }, [string]>(
      "SELECT bot_id, task_id, ticket_id, session_id FROM turns WHERE id = ?").get(input.turnId);
    if (!turn) return false;
    if (ctx.db.query("SELECT 1 FROM work_events WHERE kind = 'artifact.viewed' AND turn_id = ? AND json_extract(payload, '$.path') = ?").get(input.turnId, input.path)) return false;
    recordWorkEvent(ctx, { kind: "artifact.viewed", actor: turn.bot_id, botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id,
      turnId: input.turnId, sessionId: turn.session_id, payload: { path: input.path } });
    return true;
  });
}

/** A required item nothing backs, with what the app measured on it (checks from your words, not confirmed). */
export type UnbackedItem = RequiredItem & { checks: SubmissionCheck[] };

/**
 * Whether a hand-over waits on your 放行 with every required item met: nobody made it (an
 * organizer's reading, words handed over), it is a large job's sample or last part (ADR 0060), or
 * nothing stands behind it — no gate of yours passed, and no reviewer on another model gave evidence
 * on what you asked (ADR 0046).
 */
export function needsYourApproval(ctx: StoreContext, submission: Submission, checks: readonly SubmissionCheck[], review: ReviewRecord | null): boolean {
  if (ORIGIN_NEEDS_USER.includes(submission.origin) || yoursToApprove(ctx, submission.ticket_id)) return true;
  if (checks.some(backs)) return false;
  return !review || review.same_model || !hasEvidence(ctx, submission, review.verdicts);
}
