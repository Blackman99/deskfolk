/**
 * Submissions, reviews and ticket stages (ADR 0040 §2.6, §2.8, §5.2, §5.3.7, §6.5; ADR 0046), from
 * engine level 5. A submission is one hand-over of a ticket's work: its files by content hash, the
 * checks the app ran on them, and the reviews it got. It is explicit (`submit`) or implicit (a
 * producing segment that cited new files in its ticket's folder). A ticket's stage moves only here
 * and by your board edits — no Bot writes a stage — and the old status column is written beside it,
 * mapped (§2.3).
 *
 * What may approve: only checks in force (gates) decide by measurement; a check from your words you
 * have not confirmed never blocks anything. What a review must judge are the requirements you
 * raised twice or more and those about the picture. A pass on one you raised twice from a reviewer
 * on the producer's own model, or no review at all, is not enough without a passing check standing
 * on it or your word: then the ball comes to you, on a card — never back to the producer to chase
 * a number you have not confirmed.
 *
 * The store side is synchronous: preparing a submission, reading what its checks said, judging a
 * review, the supervisor's part. Hashing files, running checks and waking Bots is the engine's
 * (`engine/submissions.ts`).
 */
import { USER_MEMBER, type Message, type Ticket, type TicketStatus } from "@real-bot/protocol";
import { clauseObjects, clausesOf } from "../complaint-words";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { derivedNotGate } from "./acceptance-checks";
import { confirmDerivedCheck } from "./derived-checks";
import { filenamePartNumbers, partNumbers, registerFilenameParts } from "./filing";
import { holdsCovering } from "./holds";
import { queueInboxItem, refreshHeldInbox } from "./inbox";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { emptyPlanSpec, parsePlanSpec } from "./plan-shape";
import { requirementsBearingOn, setRequirementHere, waiveRequirement } from "./requirements";
import { noteHandOverFailed, resetEscalation } from "./escalation";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import { requireNonEmpty, type StoreContext } from "./shared";
import { getTask, isReservedTaskPath, setTaskSpec } from "./tasks";
import { getTicket, toTicket, type TicketRow } from "./tickets";
import { recordWorkEvent } from "./work-events";
import { hasWorkAuthority, queueWork } from "./work-items";

export type TicketStage = "todo" | "doing" | "submitted" | "in_review" | "rework" | "approved" | "dropped";
export const TICKET_STAGES: readonly TicketStage[] = ["todo", "doing", "submitted", "in_review", "rework", "approved", "dropped"];

/** The stage a ticket with no stage of its own reads as, from its old status. */
export const STAGE_OF_STATUS: Readonly<Record<TicketStatus, TicketStage>> = {
  todo: "todo", doing: "doing", review: "submitted", done: "approved", parked: "dropped",
};
/** The old status written beside each stage (§2.3), so the board and any reader of status stay right. */
export const STATUS_OF_STAGE: Readonly<Record<TicketStage, TicketStatus>> = {
  todo: "todo", doing: "doing", submitted: "review", in_review: "review", rework: "doing", approved: "done", dropped: "parked",
};
/** A ticket's stage in SQL, for a table aliased `alias`: its own, else what its status reads as. */
export const STAGE_SQL = (alias: string) => `COALESCE(${alias}.stage, CASE ${alias}.status WHEN 'todo' THEN 'todo' WHEN 'doing' THEN 'doing'
  WHEN 'review' THEN 'submitted' WHEN 'done' THEN 'approved' ELSE 'dropped' END)`;

export type SubmissionState = "checking" | "checks_failed" | "submitted" | "in_review" | "approved" | "rejected" | "superseded";
export type SubmissionArtifact = { path: string; sha256: string };
/**
 * How it was handed over: `submit` and `implicit` hand over files; `answer`, words in place of a file
 * (a ticket whose work is an answer); `organizer`, the organizer read a ticket nothing was ever
 * handed over on as done — it goes the no-reviewer way, never straight to approved.
 */
export type SubmissionOrigin = "submit" | "implicit" | "answer" | "organizer";
/**
 * One check's result as a submission keeps it. `gate`: it decides (a check you or the organizer
 * wrote, or one from your words you confirmed); otherwise it is measured and shown, never a block.
 * `yours`: a gate you wrote or confirmed — the only kind that, passing, backs an approval no one
 * else stands behind. An organizer's check still blocks when it fails, but its pass vouches for
 * nothing: it may only ask that a file exists.
 */
export type SubmissionCheck = {
  check_id: string; item: string; gate: boolean; yours: boolean; outcome: string; detail: string;
  /** Its last verdict came from a model looking at pictures: shown for reference, never a gate (from level 5, until calibrated). */
  reference?: "vision";
};

/** A gate you wrote or confirmed that passed: what backs an approval nobody else stands behind. */
function backs(check: SubmissionCheck): boolean {
  return check.gate && check.yours === true && check.outcome === "pass";
}
export type ReviewVerdict = { requirement_id: string; verdict: "pass" | "fail" | "unknown" | "n/a"; evidence: string[] };
export type ReviewRecord = {
  reviewer_bot_id: string; reviewer_model: string | null; same_model: boolean; turn_id: string;
  verdicts: ReviewVerdict[]; outcome: "approve" | "reject"; note: string | null; at: string;
};
export type SubmissionClaim = { requirement_id: string; claim: string; evidence: string };
/**
 * An approval waiting on you: the required items nothing backs yet, the card that asks you, and
 * the review it would complete (null when there is no reviewer). `kind` tells the two cards this
 * module writes apart: `items` (the default, omitted on older rows) asks about required items
 * nothing backs; `approval` asks you to approve or send back a hand-over with no reviewer and
 * nothing required, or one nothing you confirmed backs (an `answer` or `organizer` submission is
 * never approved on its own say) — a later tick never turns that one into an approval by itself.
 */
export type AwaitingYou = {
  requirement_ids: string[]; check_ids: string[]; message_id: string | null; review: ReviewRecord | null; at: string; kind?: "items" | "approval";
  /** An approval card whose 放行 you already pressed, waiting on a gate that had not run yet: resolves once every gate has, never asks again. */
  pending?: boolean;
};

export type Submission = {
  id: string; work_item_id: string | null; task_id: string; ticket_id: string; part_keys: string[]; bot_id: string;
  model: string | null; turn_id: string | null; origin: SubmissionOrigin; artifacts: SubmissionArtifact[];
  /** The words handed over, for an `answer`: a ticket whose work is an answer, not a file. */
  content: string | null;
  claims: SubmissionClaim[]; note: string | null; state: SubmissionState; checks: SubmissionCheck[];
  reviews: ReviewRecord[]; awaiting: AwaitingYou | null; created_at: string; updated_at: string;
};

type SubmissionRow = Omit<Submission, "part_keys" | "artifacts" | "claims" | "checks" | "reviews" | "awaiting"> & {
  part_keys: string; artifacts: string; claims: string; checks: string; reviews: string; awaiting: string | null;
};
type StagedTicketRow = TicketRow & { stage: string | null; reviewer_bot_id: string | null };

/** What a review must judge, and why (§6.5 2, ADR 0046): what you raised twice or more, what is about the picture. */
export type RequiredItem = { requirement_id: string; quote: string; reasons: Array<"raised" | "visual">; times_raised: number };

/** Categories about the picture: their pass needs frames of the delivery read in the reviewing segment (§2.8 `review`). */
const VISUAL_CATEGORY = /画面|视觉|背景|角色|人物|镜头|构图|颜色|色调|光|造型|外观|动作|转场|分镜|场景|visual|image|frame|shot|scene|colou?r|light|character/i;
/** An image file, as the evidence a Bot looked at frames. */
export const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
/** The workspace folder every plan may hand over from, besides a ticket's own (§2.8 `submit`). */
export const SHARED_ASSETS_DIR = "assets";
/** At most this many files in one submission. */
export const SUBMISSION_ARTIFACTS_MAX = 50;
const CLAIMS_MAX = 50;
const CLAIM_TEXT_MAX = 1000;
/** How long a checked submission with no reviewer waits before the supervisor takes it on: one tick (§5.3.7). */
export const UNREVIEWED_AFTER_MS = 15_000;
/** Undecided submissions, which a newer one of the same ticket (or your board edit) supersedes; one that failed its checks stays that. */
const OPEN_STATES: readonly SubmissionState[] = ["checking", "submitted", "in_review"];
/**
 * Origins with no Bot that actually produced them: an organizer's reading, or a ticket's answer.
 * With no reviewer, neither is ever approved on its checks alone — the ball comes to you on a card,
 * even with nothing required (ADR 0046, where §6.5 and §5.3.7 would have the no-reviewer path
 * approve once checks and required items clear).
 */
const ORIGIN_NEEDS_USER: readonly SubmissionOrigin[] = ["answer", "organizer"];
/** How much of an answer's text a card shows before truncating it; the submission keeps the rest. */
const ANSWER_EXCERPT_MAX = 400;

/** An answer's text, truncated for a line or a card; the submission itself keeps the full text. */
function truncatedAnswer(content: string): string {
  const points = [...content];
  return points.length > ANSWER_EXCERPT_MAX ? `${points.slice(0, ANSWER_EXCERPT_MAX).join("")}……` : content;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    ...row,
    part_keys: parse<string[]>(row.part_keys, []),
    artifacts: parse<SubmissionArtifact[]>(row.artifacts, []),
    claims: parse<SubmissionClaim[]>(row.claims, []),
    checks: parse<SubmissionCheck[]>(row.checks, []),
    reviews: parse<ReviewRecord[]>(row.reviews, []),
    awaiting: parse<AwaitingYou | null>(row.awaiting, null),
  };
}

function locale(ctx: StoreContext): "zh" | "en" {
  return settingsCached(ctx).locale === "en" ? "en" : "zh";
}

export function getSubmission(ctx: StoreContext, id: string): Submission {
  const row = ctx.db.query<SubmissionRow, [string]>("SELECT * FROM submissions WHERE id = ?").get(requireNonEmpty("submissionId", id));
  if (!row) throw new HttpError(404, "not_found", "submission not found");
  return toSubmission(row);
}

/** A plan's or a ticket's submissions, newest first. */
export function listSubmissions(ctx: StoreContext, filter: { taskId?: string; ticketId?: string; limit?: number }): Submission[] {
  if (!filter.taskId && !filter.ticketId) throw new HttpError(422, "invalid_args", "submissions are listed for a plan or a ticket");
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
  return ctx.db.query<SubmissionRow, [string | null, string | null, number]>(`SELECT * FROM submissions
    WHERE (?1 IS NULL OR task_id = ?1) AND (?2 IS NULL OR ticket_id = ?2) ORDER BY created_at DESC, rowid DESC LIMIT ?3`)
    .all(filter.taskId ?? null, filter.ticketId ?? null, limit).map(toSubmission);
}

/** The model a segment ran on, from its route decision; null when it has none. */
function segmentModel(ctx: StoreContext, turnId: string): string | null {
  return ctx.db.query<{ model: string }, [string]>("SELECT model FROM turn_route_decisions WHERE turn_id = ?").get(turnId)?.model ?? null;
}

function supervised(ctx: StoreContext): boolean {
  return readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions;
}

/** A ticket's stage: its own, or the one its status reads as. */
export function ticketStage(ticket: { status: TicketStatus; stage?: string | null }): TicketStage {
  return ticket.stage && (TICKET_STAGES as readonly string[]).includes(ticket.stage) ? ticket.stage as TicketStage : STAGE_OF_STATUS[ticket.status];
}

function stagedTicket(ctx: StoreContext, id: string): StagedTicketRow {
  const row = ctx.db.query<StagedTicketRow, [string]>("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "ticket not found");
  return row;
}

/**
 * Moves a ticket to `stage`, its old status beside it (§2.3), and logs the move as
 * `ticket.stage_changed` — the supervisor's progress. Only this module moves a stage (a submission's
 * checks, a review, the supervisor's approval); your board edits change the status, and the trigger
 * `tickets_stage_follows_status` brings the stage along.
 */
export function setTicketStage(ctx: StoreContext, input: {
  ticketId: string; stage: TicketStage; source: "submission" | "review" | "supervisor" | "user";
  botId?: string | null; turnId?: string | null; workItemId?: string | null; submissionId?: string | null; now?: string;
}): Ticket {
  const row = stagedTicket(ctx, input.ticketId);
  const before = ticketStage(row);
  if (before === input.stage && row.stage === input.stage) return toTicket(row);
  const now = input.now ?? isoNow();
  const status = STATUS_OF_STAGE[input.stage];
  const closing = status === "done" || status === "parked";
  ctx.db.run(`UPDATE tickets SET stage = ?, status = ?, updated_at = ?, closed_at = CASE WHEN ? THEN COALESCE(closed_at, ?) ELSE NULL END
    WHERE id = ?`, [input.stage, status, now, closing ? 1 : 0, now, row.id]);
  if (before !== input.stage) {
    recordWorkEvent(ctx, { kind: "ticket.stage_changed", actor: input.source === "user" ? "user" : "app", botId: input.botId ?? null, taskId: row.task_id,
      ticketId: row.id, turnId: input.turnId ?? null, payload: { work_item_id: input.workItemId ?? null, before, after: input.stage, source: input.source,
        submission_id: input.submissionId ?? null } });
  }
  return getTicket(ctx, row.id);
}

function setPartStage(ctx: StoreContext, submission: Submission, stage: "submitted" | "approved" | "rework"): void {
  for (const key of submission.part_keys) {
    const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(submission.ticket_id, key);
    if (!part || part.stage === stage || part.stage === "waived" || part.stage === "blocked") continue;
    ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ?", [stage, submission.ticket_id, key]);
    recordWorkEvent(ctx, { kind: "part.stage_changed", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { work_item_id: submission.work_item_id, part: key, before: part.stage, after: stage, submission_id: submission.id } });
  }
}

/** The parts a submission is about: those named, else those its files' names number (§8.2 rule 7), made when missing. */
function submissionParts(ctx: StoreContext, ticketId: string, artifacts: readonly SubmissionArtifact[], named: unknown): Map<string, string> {
  const parts = new Map<string, string>();
  if (named !== undefined && named !== null) {
    if (!Array.isArray(named) || named.some((key) => typeof key !== "string" || !key.trim())) throw new HttpError(422, "invalid_args", "parts must be a list of part keys");
    for (const key of named as string[]) {
      if (!ctx.db.query("SELECT 1 FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(ticketId, key)) {
        throw new HttpError(422, "invalid_args", `${key} is not a part of this ticket`);
      }
      parts.set(key, artifacts[0]!.path);
    }
    return parts;
  }
  for (const artifact of artifacts) {
    for (const key of registerFilenameParts(ctx, ticketId, artifact.path)) parts.set(key, artifact.path);
  }
  return parts;
}

function cleanClaims(raw: unknown): SubmissionClaim[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > CLAIMS_MAX) throw new HttpError(422, "invalid_args", `claims must be a list of at most ${CLAIMS_MAX}`);
  return raw.map((entry) => {
    const claim = entry as Record<string, unknown>;
    if (!claim || typeof claim !== "object" || typeof claim.requirement_id !== "string" || typeof claim.claim !== "string") {
      throw new HttpError(422, "invalid_args", "each claim needs requirement_id and claim");
    }
    return { requirement_id: claim.requirement_id, claim: claim.claim.slice(0, CLAIM_TEXT_MAX),
      evidence: typeof claim.evidence === "string" ? claim.evidence.slice(0, CLAIM_TEXT_MAX) : "" };
  });
}

type SegmentRow = { id: string; bot_id: string; status: string; work_item_id: string | null; task_id: string | null; ticket_id: string | null };

/** Whether `path` is a plain workspace-relative path: no empty, `.` or `..` part, no backslash. */
function plainPath(path: string): boolean {
  return Boolean(path) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** Whether `path` is a file of the ticket folder `dir` a submission may hand over. */
export function inTicketDir(dir: string, path: string): boolean {
  return path.startsWith(`${dir}/`) && plainPath(path) && !isReservedTaskPath(dir, path);
}

/**
 * Whether this segment produces its ticket's work, so that what it cites is a hand-over (ADR
 * 0046): the ticket's owner (or worker), a Bot an open or answered request asks for a
 * deliverable on it, or anyone on a ticket nobody owns yet. Never the ticket's reviewer, a Bot asked
 * to review it, or a segment woken by a request to review — what a reviewer writes are its notes.
 */
function producesTicket(ctx: StoreContext, turn: SegmentRow & { ticket_id: string }): boolean {
  return producerStanding(ctx, turn) === "producer";
}

/** Why a segment is or is not its ticket's producer: it is; it reviews the ticket; or only someone else owns it. */
function producerStanding(ctx: StoreContext, turn: Pick<SegmentRow, "id" | "bot_id"> & { ticket_id: string }): "producer" | "reviewer" | "not_owner" {
  const ticket = stagedTicket(ctx, turn.ticket_id);
  if (ticket.reviewer_bot_id === turn.bot_id) return "reviewer";
  if (ctx.db.query(`SELECT 1 FROM delegations WHERE to_bot_id = ? AND task_id = ? AND (ticket_id = ? OR ticket_id IS NULL)
    AND expects = 'review' AND status = 'open'`).get(turn.bot_id, ticket.task_id, ticket.id)) return "reviewer";
  if (ctx.db.query(`SELECT 1 FROM inbox_items WHERE (delivered_turn_id = ?1 OR turn_id = ?1) AND source = 'review' AND kind = 'change'`).get(turn.id)) return "reviewer";
  const owner = ticket.owner_bot_id ?? ticket.worker;
  if (!owner || owner === turn.bot_id) return "producer";
  return ctx.db.query(`SELECT 1 FROM delegations WHERE to_bot_id = ? AND task_id = ? AND ticket_id = ? AND expects = 'deliverable'
    AND status IN ('open', 'replied')`).get(turn.bot_id, ticket.task_id, ticket.id) ? "producer" : "not_owner";
}

/**
 * The note a Bot that is not its ticket's owner gets once, at the end of a segment in which it
 * cited or wrote files in that ticket's folder: what it made is not handed over for it (only the
 * owner's is — that keeps a reviewer's frames out), so if it is the ticket's work it hands it over
 * with `submit`. Null for the owner, a reviewer, no such files, or once already said this segment.
 */
export function handOverHint(ctx: StoreContext, input: { turnId: string; paths: readonly string[] }): string | null {
  if (!supervised(ctx)) return null;
  return ctx.commit(() => {
    const turn = ctx.db.query<{ id: string; bot_id: string; ticket_id: string | null; task_id: string | null }, [string]>(
      "SELECT id, bot_id, ticket_id, task_id FROM turns WHERE id = ?").get(input.turnId);
    if (!turn?.ticket_id) return null;
    const ticket = stagedTicket(ctx, turn.ticket_id);
    const stage = ticketStage(ticket);
    if (stage === "approved" || stage === "dropped") return null;
    const files = [...new Set([...input.paths, ...implicitSubmissionPaths(ctx, turn.id)])].filter((path) => inTicketDir(ticket.dir, path));
    if (files.length === 0 || producerStanding(ctx, { ...turn, ticket_id: turn.ticket_id }) !== "not_owner") return null;
    if (ctx.db.query("SELECT 1 FROM work_events WHERE kind = 'submission.hint' AND turn_id = ?").get(turn.id)) return null;
    recordWorkEvent(ctx, { kind: "submission.hint", actor: "app", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId: turn.id,
      payload: { paths: files } });
    const owner = ticket.owner_bot_id ?? ticket.worker;
    const name = owner ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(owner)?.name ?? owner : "";
    return locale(ctx) === "en"
      ? `(app) This ticket is ${name}'s, so the files you made in its folder were not handed over for you: ${files.join(", ")}. If they are the ticket's work, hand them over with submit; then end your turn.`
      : `（应用）这张任务是${name}的，你在它文件夹里做的文件不会替你交：${files.join("、")}。如果它们就是这张任务的成果，用 submit 交出去，再结束本段。`;
  });
}

/**
 * The note a Bot that is not its ticket's owner gets once, when `end_turn(done, answer)` hands
 * over no words for it: only the ticket's owner hands over words; it should write what it means to
 * hand over to a file in the ticket's folder and `submit` that instead, rather than a bare
 * `unfinished_obligations` that says nothing about why. Null for the owner, a reviewer, or once
 * already said this segment.
 */
export function answerHint(ctx: StoreContext, input: { turnId: string }): string | null {
  if (!supervised(ctx)) return null;
  return ctx.commit(() => {
    const turn = ctx.db.query<{ id: string; bot_id: string; ticket_id: string | null; task_id: string | null }, [string]>(
      "SELECT id, bot_id, ticket_id, task_id FROM turns WHERE id = ?").get(input.turnId);
    if (!turn?.ticket_id) return null;
    if (producerStanding(ctx, { ...turn, ticket_id: turn.ticket_id }) !== "not_owner") return null;
    if (ctx.db.query("SELECT 1 FROM work_events WHERE kind = 'submission.answer_hint' AND turn_id = ?").get(turn.id)) return null;
    recordWorkEvent(ctx, { kind: "submission.answer_hint", actor: "app", botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId: turn.id, payload: {} });
    const ticket = stagedTicket(ctx, turn.ticket_id);
    const owner = ticket.owner_bot_id ?? ticket.worker;
    const name = owner ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(owner)?.name ?? owner : "";
    return locale(ctx) === "en"
      ? `(app) Only this ticket's owner${name ? ` (${name})` : ""} hands over words; write what you mean to hand over to a file in its folder and submit that.`
      : `（应用）只有这张任务的 owner${name ? `（${name}）` : ""}能交出话；把你要交的内容写进它文件夹里的一个文件，再用 submit 交。`;
  });
}

/**
 * A new submission of the segment's ticket, before its checks run (state `checking`). Its files are
 * in the ticket's own folder — an explicit `submit` may also hand over files of the workspace's
 * shared `assets/` — never where the app keeps its own. An implicit one is made only for the
 * ticket's producer, and only when some file's content hash is new since the ticket's last
 * submission; it is null otherwise. Earlier submissions of the ticket still undecided are
 * superseded; a ticket still todo reads as doing. Returns the checks to run on it.
 */
export function prepareSubmission(ctx: StoreContext, input: {
  turnId: string; origin: "submit" | "implicit" | "answer"; artifacts: readonly SubmissionArtifact[];
  parts?: unknown; claims?: unknown; note?: unknown; content?: string | null; model?: string | null; now?: string;
}): { submission: Submission; checkIds: string[] } | null {
  return ctx.commit(() => {
    if (!supervised(ctx)) throw new HttpError(409, "submissions_unavailable", "submissions are not on at this engine level");
    const turn = ctx.db.query<SegmentRow, [string]>("SELECT id, bot_id, status, work_item_id, task_id, ticket_id FROM turns WHERE id = ?")
      .get(requireNonEmpty("turnId", input.turnId));
    if (!turn) throw new HttpError(404, "not_found", "turn not found");
    if (!turn.task_id || !turn.ticket_id || !turn.work_item_id) {
      throw new HttpError(422, "invalid_args", "a submission hands over one ticket's work: bind this segment to the ticket first (work_on with its ticket)");
    }
    if (input.origin === "submit" && !hasWorkAuthority(ctx, turn.id)) throw new HttpError(409, "no_work_authority", "this segment no longer owns this work");
    if (input.origin !== "submit" && !producesTicket(ctx, { ...turn, ticket_id: turn.ticket_id })) return null;
    const ticketDir = stagedTicket(ctx, turn.ticket_id).dir;
    const planDir = ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tasks WHERE id = ?").get(turn.task_id)!.dir;
    let content: string | null = null;
    if (input.origin === "answer") {
      // Words in place of a file: only on a ticket no file was ever handed over on, and only new words.
      content = typeof input.content === "string" ? input.content.trim().slice(0, 8000) : "";
      if (!content || (input.artifacts?.length ?? 0) > 0) return null;
      if (ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND artifacts <> '[]'").get(turn.ticket_id)) return null;
      const last = ctx.db.query<{ content: string | null }, [string]>(`SELECT content FROM submissions WHERE ticket_id = ? AND origin = 'answer'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(turn.ticket_id);
      if (last?.content === content) return null;
    } else if (!Array.isArray(input.artifacts) || input.artifacts.length === 0 || input.artifacts.length > SUBMISSION_ARTIFACTS_MAX) {
      throw new HttpError(422, "invalid_args", `a submission names 1 to ${SUBMISSION_ARTIFACTS_MAX} files`);
    }
    const otherTickets = ctx.db.query<{ dir: string }, [string, string]>("SELECT dir FROM tickets WHERE task_id = ? AND id <> ?").all(turn.task_id, turn.ticket_id)
      .map((row) => row.dir);
    const artifacts: SubmissionArtifact[] = [];
    for (const artifact of input.origin === "answer" ? [] : input.artifacts) {
      const path: string = typeof artifact?.path === "string" ? artifact.path : "";
      // Implicit: the ticket's own folder. Explicit: the plan's folder (its deliverables/ too) but not
      // another ticket's, or the workspace's shared assets/.
      const allowed = input.origin === "implicit"
        ? inTicketDir(ticketDir, path)
        : (path.startsWith(`${SHARED_ASSETS_DIR}/`) && plainPath(path))
          || (path.startsWith(`${planDir}/`) && plainPath(path) && !isReservedTaskPath(planDir, path)
            && !otherTickets.some((dir) => path === dir || path.startsWith(`${dir}/`)));
      if (!allowed) {
        throw new HttpError(422, "invalid_args", isReservedTaskPath(planDir, path)
          ? `${path} is in a folder the app keeps for itself`
          : input.origin === "implicit"
            ? `${path || "a file"} is not in this ticket's folder (${ticketDir}/)`
            : `${path || "a file"} is not this ticket's to hand over: use this plan's folder (${planDir}/, not another ticket's folder) or the shared ${SHARED_ASSETS_DIR}/`);
      }
      if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new HttpError(422, "invalid_args", `${path} has no content hash`);
      if (!artifacts.some((seen) => seen.path === path)) artifacts.push({ path, sha256: artifact.sha256 });
    }
    if (input.origin === "implicit") {
      const known = new Map<string, string>();
      for (const previous of listSubmissions(ctx, { ticketId: turn.ticket_id, limit: 200 }).reverse()) {
        for (const artifact of previous.artifacts) known.set(artifact.path, artifact.sha256);
      }
      if (artifacts.every((artifact) => known.get(artifact.path) === artifact.sha256)) return null;
    }
    const now = input.now ?? isoNow();
    const claims = cleanClaims(input.claims);
    if (input.note !== undefined && input.note !== null && typeof input.note !== "string") throw new HttpError(422, "invalid_args", "note must be a string");
    const parts = submissionParts(ctx, turn.ticket_id, artifacts, input.parts);
    const stuck = openCeiling(ctx, turn.ticket_id, [...parts.keys()]);
    if (stuck) {
      throw new HttpError(409, "ceiling_reached", `${stuck.part_key ? `part ${stuck.part_key}` : "this ticket"} hit the capability ceiling: the user is asked on a card how to go on (another way, another plan, a relaxed requirement, or as it is); nothing more is handed over for it until they answer`);
    }
    const superseded = supersedeOpen(ctx, turn.ticket_id, now, "submission");
    const id = ulid(Date.parse(now));
    ctx.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
        note, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checking', ?, ?)`,
      [id, turn.work_item_id, turn.task_id, turn.ticket_id, JSON.stringify([...parts.keys()].sort()), turn.bot_id, input.model ?? segmentModel(ctx, turn.id), turn.id,
        input.origin, JSON.stringify(artifacts), content, JSON.stringify(claims), typeof input.note === "string" ? input.note.trim().slice(0, 2000) || null : null, now, now]);
    for (const [key, path] of parts) {
      ctx.db.run(`UPDATE ticket_parts SET attempts = attempts + 1, current_artifact = ?, owner_bot_id = COALESCE(owner_bot_id, ?),
        stage = CASE WHEN stage IN ('todo', 'rework') THEN 'in_progress' ELSE stage END WHERE ticket_id = ? AND key = ?`, [path, turn.bot_id, turn.ticket_id, key]);
    }
    if (ticketStage(stagedTicket(ctx, turn.ticket_id)) === "todo") {
      setTicketStage(ctx, { ticketId: turn.ticket_id, stage: "doing", source: "submission", botId: turn.bot_id, turnId: turn.id,
        workItemId: turn.work_item_id, submissionId: id, now });
    }
    recordWorkEvent(ctx, { kind: "submission.created", actor: turn.bot_id, botId: turn.bot_id, taskId: turn.task_id, ticketId: turn.ticket_id,
      turnId: turn.id, payload: { submission_id: id, work_item_id: turn.work_item_id, origin: input.origin, artifacts: artifacts.map((artifact) => artifact.path),
        parts: [...parts.keys()].sort(), superseded } });
    const submission = getSubmission(ctx, id);
    return { submission, checkIds: boundCheckIds(ctx, submission) };
  });
}

/** Supersedes a ticket's undecided submissions, and lets go of the cards that asked you about them. Returns their ids. */
function supersedeOpen(ctx: StoreContext, ticketId: string, now: string, by: "submission" | "board"): string[] {
  const open = ctx.db.query<SubmissionRow, [string, string]>(`SELECT * FROM submissions WHERE ticket_id = ? AND state IN (SELECT value FROM json_each(?))`)
    .all(ticketId, JSON.stringify(OPEN_STATES)).map(toSubmission);
  for (const submission of open) {
    ctx.db.run("UPDATE submissions SET state = 'superseded', awaiting = NULL, updated_at = ? WHERE id = ?", [now, submission.id]);
    if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "superseded", by });
  }
  return open.map((submission) => submission.id);
}

/**
 * Your board edit of a ticket's status, from level 5: what you set
 * stands, and the hand-overs still waiting on it are superseded, so a review in flight cannot move
 * the ticket past you.
 */
export function noteBoardStatus(ctx: StoreContext, ticketId: string, now: string = isoNow()): string[] {
  if (!supervised(ctx)) return [];
  const superseded = supersedeOpen(ctx, ticketId, now, "board");
  closeCeilingCards(ctx, ticketId, locale(ctx) === "en" ? "You changed the ticket's status on the board, so this no longer asks." : "你在看板上改了这张任务的状态，不再问了。");
  if (superseded.length > 0) {
    const ticket = stagedTicket(ctx, ticketId);
    recordWorkEvent(ctx, { kind: "submission.superseded", actor: USER_MEMBER, taskId: ticket.task_id, ticketId, payload: { submissions: superseded, by: "board" } });
  }
  return superseded;
}

function matchesGlob(glob: string, path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  const pattern = new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return pattern.test(name) || pattern.test(path);
}

/**
 * The checks a submission is held to: the plan's checks on its ticket, and those reading one of its
 * files or anything in its ticket's folder (a file check, a command run there, a check from your
 * words bound to a delivered file). Checks from your words not yet confirmed are among them —
 * measured and shown — but only a gate holds a submission back.
 */
export function boundCheckIds(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id" | "artifacts">): string[] {
  const dir = ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE id = ?").get(submission.ticket_id)?.dir ?? null;
  const rows = ctx.db.query<{ id: string; ticket_id: string | null; path: string | null; cwd: string | null; bind_glob: string | null; origin: string | null; bind_kind: string | null },
    [string]>("SELECT id, ticket_id, path, cwd, bind_glob, origin, bind_kind FROM acceptance_checks WHERE task_id = ? AND removed_at IS NULL ORDER BY created_at, id")
    .all(submission.task_id);
  const paths = submission.artifacts.map((artifact) => artifact.path);
  const inside = (place: string | null) => Boolean(place && dir && (place === dir || place.startsWith(`${dir}/`)));
  return rows.filter((check) => {
    if (check.origin === "derived" && !check.bind_kind) return false;
    if (check.ticket_id) return check.ticket_id === submission.ticket_id;
    return (check.path !== null && (paths.includes(check.path) || inside(check.path)))
      || inside(check.cwd)
      || (check.origin === "derived" && check.bind_glob !== null && paths.some((path) => matchesGlob(check.bind_glob!, path)));
  }).map((check) => check.id);
}

/** Each check's latest run that started at or after `since`, as a submission keeps it. A check with none reads `not_run`. */
export function checkResults(ctx: StoreContext, checkIds: readonly string[], since: string): SubmissionCheck[] {
  return checkIds.flatMap((id) => {
    const check = ctx.db.query<{ id: string; item: string; origin: string | null; bind_kind: string | null; derived_state: string | null; source: string }, [string]>(
      "SELECT id, item, origin, bind_kind, derived_state, source FROM acceptance_checks WHERE id = ? AND removed_at IS NULL").get(id);
    if (!check) return [];
    const run = ctx.db.query<{ outcome: string | null; detail: string; judged_by: string | null }, [string, string]>(`SELECT outcome, detail, judged_by
      FROM acceptance_check_runs WHERE check_id = ? AND finished_at IS NOT NULL AND started_at >= ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(id, since);
    const vision = run?.judged_by === "vision" && supervised(ctx);
    const gate = !derivedNotGate(check) && !vision;
    return [{ check_id: id, item: check.item, gate, yours: gate && (check.origin === "derived" || check.source === "user"),
      outcome: run?.outcome ?? "not_run", detail: run?.detail ?? "", ...(vision ? { reference: "vision" as const } : {}) }];
  });
}

/** A gate that did not pass: what sends a submission back, and the only check that blocks an approval. */
export function gateFailed(check: SubmissionCheck): boolean {
  return check.gate && check.outcome !== "pass";
}

/** One line per check in `checks`, in the Bots' language. */
export function checkLines(checks: readonly SubmissionCheck[], lang: "zh" | "en"): string[] {
  return checks.map((check) => lang === "en"
    ? `"${check.item}": ${check.outcome === "not_run" ? "did not run" : check.outcome}${check.detail ? ` — ${check.detail}` : ""}${check.reference ? " (judged by a model looking at pictures: for reference only)" : check.gate ? "" : " (not confirmed by the user)"}`
    : `「${check.item}」：${check.outcome === "not_run" ? "没跑成" : check.outcome === "fail" ? "不通过" : check.outcome === "pass" ? "通过" : check.outcome}${check.detail ? `——${check.detail}` : ""}${check.reference ? "（看图判定，只作参考）" : check.gate ? "" : "（用户还没确认）"}`);
}

function inPlanSession(ctx: StoreContext, botId: string, taskId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM bots b JOIN tasks p ON p.id = ?2
    JOIN session_participants sp ON sp.session_id = p.session_id AND sp.member = b.id AND sp.left_at IS NULL
    WHERE b.id = ?1 AND b.archived_at IS NULL AND b.deleted_at IS NULL`).get(botId, taskId));
}

function eligibleReviewer(ctx: StoreContext, botId: string | null | undefined, taskId: string, producer: string): string | null {
  if (!botId || botId === producer) return null;
  return inPlanSession(ctx, botId, taskId) ? botId : null;
}

/**
 * Who reviews a ticket's submissions: its reviewer (`reviewer_bot_id`, set on the board or through
 * the API), else the Bot an open request to review asks on it (`delegate` with expects `review`).
 * Never the producer.
 */
export function ticketReviewer(ctx: StoreContext, ticketId: string, producer: string): string | null {
  const ticket = stagedTicket(ctx, ticketId);
  const own = eligibleReviewer(ctx, ticket.reviewer_bot_id, ticket.task_id, producer);
  if (own) return own;
  const asked = ctx.db.query<{ to_bot_id: string }, [string, string]>(`SELECT to_bot_id FROM delegations WHERE task_id = ? AND status = 'open'
    AND expects = 'review' AND (ticket_id = ? OR ticket_id IS NULL) ORDER BY created_at DESC, rowid DESC`).all(ticket.task_id, ticket.id);
  for (const row of asked) {
    const eligible = eligibleReviewer(ctx, row.to_bot_id, ticket.task_id, producer);
    if (eligible) return eligible;
  }
  return null;
}

/** Asks the reviewer for a review: a line in its queue on the ticket, waking it (priority 2, a review). */
function requestReview(ctx: StoreContext, submission: Submission, reviewer: string, now: string): void {
  const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(submission.task_id);
  const ticket = stagedTicket(ctx, submission.ticket_id);
  const home = ctx.db.query<{ home_session_id: string }, [string, string, string]>(`SELECT home_session_id FROM work_items
    WHERE bot_id = ? AND task_id = ? AND ticket_id IS ? AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(reviewer, submission.task_id, submission.ticket_id);
  const sessionId = home?.home_session_id ?? plan?.session_id;
  if (!sessionId) return;
  const en = locale(ctx) === "en";
  // An answer has no file: the review request names the words themselves. An organizer's reading
  // has neither a file nor words of its own; its note says what it is — already a full sentence
  // ("…做完了。"), so its own period goes before it is spliced into the template's.
  const handedOver = submission.origin === "answer" ? `"${truncatedAnswer(submission.content ?? "")}"`
    : submission.origin === "organizer" ? (submission.note ?? "").replace(/[。.]+$/, "")
      : submission.artifacts.map((artifact) => artifact.path).join(en ? ", " : "、");
  const number = String(ticket.seq).padStart(2, "0");
  const body = en
    ? `(app) Please review submission ${submission.id} of ticket ${number} "${ticket.title}": ${handedOver}. Read what you judge (frames for anything about the picture), then call review with a verdict and evidence per required item.`
    : `（应用）请审查任务 ${number}「${ticket.title}」的交付 ${submission.id}：${handedOver}。先看要判的内容（画面类要读帧），再调 review 对每条必查要求给结论和依据。`;
  const queued = queueWork(ctx, { botId: reviewer, sessionId, taskId: submission.task_id, ticketId: submission.ticket_id, messageId: null,
    author: "app", body, source: "review", kind: "change", priority: 2, notice: false });
  refreshHeldInbox(ctx, { botId: reviewer });
  recordWorkEvent(ctx, { kind: "review.requested", actor: "app", botId: reviewer, taskId: submission.task_id, ticketId: submission.ticket_id,
    payload: { submission_id: submission.id, work_item_id: queued.workItem.id, inbox_seq: queued.inbox.seq, at: now } });
}

/** The checks' failure, back to the producer: the submission failed them, the ticket reads rework, and the producer is told (woken). */
function failOnGates(ctx: StoreContext, submission: Submission, checks: SubmissionCheck[], now: string, tell: boolean): void {
  ctx.db.run("UPDATE submissions SET state = 'checks_failed', checks = ?, awaiting = NULL, updated_at = ? WHERE id = ?", [JSON.stringify(checks), now, submission.id]);
  if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "checks_failed", lines: checkLines(checks.filter(gateFailed), locale(ctx)) });
  const stage = ticketStage(stagedTicket(ctx, submission.ticket_id));
  const back: TicketStage | null = ["submitted", "in_review", "approved"].includes(stage) ? "rework" : stage === "todo" ? "doing" : null;
  if (back) setTicketStage(ctx, { ticketId: submission.ticket_id, stage: back, source: "submission", botId: submission.bot_id, turnId: submission.turn_id,
    workItemId: submission.work_item_id, submissionId: submission.id, now });
  const failed = getSubmission(ctx, submission.id);
  setPartStage(ctx, failed, "rework");
  const ceiling = checkCeiling(ctx, failed, now);
  noteHandOverFailed(ctx, submission.work_item_id, now);
  if (!tell) return;
  const lines = checkLines(checks.filter(gateFailed), locale(ctx));
  tellAfterFailure(ctx, submission, locale(ctx) === "en"
    ? { what: `(app) Submission ${submission.id} failed its checks, so the ticket did not move: ${lines.join("; ")}.`, retry: "Fix it and hand it over again." }
    : { what: `（应用）交付 ${submission.id} 没过检查，任务没往前走：${lines.join("；")}。`, retry: "改好再交。" }, ceiling, now);
}

/**
 * The producer hears a failed hand-over (its checks, a review's reject, your send-back) and is woken
 * to fix it — unless every unit it covered is now stuck at the capability ceiling: then it only hears
 * that you are being asked how to go on, and is not woken to try again (the ball is yours).
 */
function tellAfterFailure(ctx: StoreContext, submission: Submission, said: { what: string; retry: string }, ceiling: CeilingOutcome, now: string): void {
  if (!producerIsBot(ctx, submission)) return;
  const sessionId = producerSession(ctx, submission);
  if (!sessionId) return;
  const en = locale(ctx) === "en";
  const stuck = ceiling.stuck.map((unit) => unit ?? (en ? "the ticket" : "这张任务"));
  const note = stuck.length === 0 ? "" : en
    ? ` ${stuck.join(", ")} hit the capability ceiling: the user is being asked how to go on${ceiling.all ? ", so do not hand it over again until they answer." : "; leave those until they answer."}`
    : ` ${stuck.join("、")}到了能力天花板：应用在问用户怎么办${ceiling.all ? "，用户选之前别再交。" : "，用户选之前别动这几个。"}`;
  if (ceiling.all) {
    if (submission.work_item_id) {
      queueInboxItem(ctx, { botId: submission.bot_id, sessionId, turnId: null, workItemId: submission.work_item_id, taskId: submission.task_id,
        ticketId: submission.ticket_id, messageId: null, author: "app", body: `${said.what}${note}`, source: "review", kind: "result", priority: 2, wakes: false, now });
    }
  } else {
    queueWork(ctx, { botId: submission.bot_id, sessionId, taskId: submission.task_id, ticketId: submission.ticket_id, messageId: null, author: "app",
      body: `${said.what}${said.retry ? `${en ? " " : ""}${said.retry}` : ""}${note}`, source: "review", kind: "result", priority: 2, notice: false });
  }
  refreshHeldInbox(ctx, { botId: submission.bot_id });
}

/** Whether a submission's producer is a Bot (the organizer's reading of a ticket nobody owns has none). */
function producerIsBot(ctx: StoreContext, submission: Pick<Submission, "bot_id">): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(submission.bot_id));
}

function producerSession(ctx: StoreContext, submission: Submission): string | null {
  const work = submission.work_item_id
    ? ctx.db.query<{ home_session_id: string; thread_session_id: string | null }, [string]>("SELECT home_session_id, thread_session_id FROM work_items WHERE id = ?")
      .get(submission.work_item_id)
    : null;
  return work ? work.thread_session_id ?? work.home_session_id
    : ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(submission.task_id)?.session_id ?? null;
}

export type SettledSubmission = { submission: Submission; state: SubmissionState; failures: SubmissionCheck[]; reviewer: string | null };

/**
 * A submission's checks have run (each since it was made): a gate that did not pass sends it back
 * (`checks_failed`; a ticket already handed over reads rework; the producer is told when `tell`,
 * i.e. when no tool call returns the failure to it); else it goes to the ticket's reviewer
 * (`in_review`, a line in the reviewer's queue) or, with none, waits one supervisor tick as
 * `submitted` for the no-reviewer path (§5.3.7).
 */
export function settleSubmissionChecks(ctx: StoreContext, submissionId: string, now: string = isoNow(), opts: { tell?: boolean } = {}): SettledSubmission {
  return ctx.commit(() => {
    const submission = getSubmission(ctx, submissionId);
    if (submission.state !== "checking") {
      return { submission, state: submission.state, failures: submission.checks.filter(gateFailed), reviewer: null };
    }
    const checks = checkResults(ctx, boundCheckIds(ctx, submission), submission.created_at);
    const failures = checks.filter(gateFailed);
    let reviewer: string | null = null;
    if (failures.length > 0) {
      failOnGates(ctx, submission, checks, now, opts.tell === true);
    } else {
      reviewer = ticketReviewer(ctx, submission.ticket_id, submission.bot_id);
      const state: SubmissionState = reviewer ? "in_review" : "submitted";
      setTicketStage(ctx, { ticketId: submission.ticket_id, stage: state, source: "submission", botId: submission.bot_id, turnId: submission.turn_id,
        workItemId: submission.work_item_id, submissionId, now });
      ctx.db.run("UPDATE submissions SET state = ?, checks = ?, updated_at = ? WHERE id = ?", [state, JSON.stringify(checks), now, submissionId]);
      setPartStage(ctx, getSubmission(ctx, submissionId), "submitted");
      if (reviewer) requestReview(ctx, getSubmission(ctx, submissionId), reviewer, now);
    }
    const settled = getSubmission(ctx, submissionId);
    recordWorkEvent(ctx, { kind: "submission.checked", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      turnId: submission.turn_id, payload: { submission_id: submissionId, work_item_id: submission.work_item_id, state: settled.state, reviewer,
        failures: failures.map((check) => check.check_id) } });
    return { submission: settled, state: settled.state, failures, reviewer };
  });
}

/**
 * The submission a reviewing segment judges: the one named; else the newest undecided one handed
 * over by another Bot — on its ticket, else in its plan, else one it reviews, else in a plan of the
 * conversation it runs in.
 */
export function reviewTarget(ctx: StoreContext, turnId: string, submissionId?: string | null): Submission | null {
  if (submissionId) return getSubmission(ctx, submissionId);
  const turn = ctx.db.query<{ bot_id: string; session_id: string; task_id: string | null; ticket_id: string | null }, [string]>(
    "SELECT bot_id, session_id, task_id, ticket_id FROM turns WHERE id = ?").get(turnId);
  if (!turn) return null;
  const pick = (where: string, params: Record<string, string>) => ctx.db.query<SubmissionRow, Record<string, string>>(
    `SELECT s.* FROM submissions s WHERE s.bot_id <> $bot AND s.state IN ('in_review', 'submitted') AND ${where}
     ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`).get({ bot: turn.bot_id, ...params });
  const row = (turn.ticket_id ? pick("s.ticket_id = $ticket", { ticket: turn.ticket_id }) : null)
    ?? (turn.task_id ? pick("s.task_id = $task", { task: turn.task_id }) : null)
    ?? pick("EXISTS (SELECT 1 FROM tickets t WHERE t.id = s.ticket_id AND t.reviewer_bot_id = $bot)", {})
    ?? pick("EXISTS (SELECT 1 FROM tasks p WHERE p.id = s.task_id AND p.session_id = $session)", { session: turn.session_id });
  return row ? toSubmission(row) : null;
}

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
function unbackedItems(ctx: StoreContext, submission: Submission, which: "raised" | "all"): Array<RequiredItem & { checks: SubmissionCheck[] }> {
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

function cleanVerdicts(raw: unknown): ReviewVerdict[] {
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
function framesRead(ctx: StoreContext, turnId: string, submission: Pick<Submission, "task_id" | "created_at">): boolean {
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

export type ReviewResult =
  | { ok: true; submission: Submission; outcome: "approve" | "reject" }
  | { ok: false; code: "review_refused"; reasons: string[]; submission: Submission }
  | { ok: false; code: "awaiting_user"; reasons: string[]; submission: Submission; card: Message | null };

/**
 * Who may review a submission: the ticket's reviewer when it has one; otherwise a Bot in the
 * plan's conversation. Never the producer.
 */
function assertMayReview(ctx: StoreContext, botId: string, submission: Submission): void {
  if (submission.bot_id === botId) throw new HttpError(422, "invalid_args", "a Bot does not review its own submission");
  const reviewer = ticketReviewer(ctx, submission.ticket_id, submission.bot_id);
  if (reviewer && reviewer !== botId) {
    const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(reviewer)?.name ?? reviewer;
    throw new HttpError(403, "not_the_reviewer", `this ticket's reviewer is ${name}; only it reviews these submissions`);
  }
  if (!reviewer && !inPlanSession(ctx, botId, submission.task_id)) {
    throw new HttpError(403, "not_the_reviewer", "only a Bot in this plan's conversation may review its submissions");
  }
}

/**
 * A review of another Bot's submission (§2.8 `review`, §6.5; ADR 0046). A rejection always records.
 * An approval is refused — nothing changes, and the reviewer is told why — when a gate fails when the
 * app runs it again (`checks`, from the engine), when a required item (raised twice or more, or about
 * the picture) has no pass with evidence, or when something about the picture passed with no frame
 * of this job read after the submission. When the reviewer runs on the producer's own model and
 * passes something you raised twice or more that no passing check backs and you have not confirmed,
 * the approval waits on you instead: a card asks you to confirm the check or the item, or to drop
 * it, and the ball is yours (`awaiting_user`). Unconfirmed checks from your words never block.
 */
export function reviewSubmission(ctx: StoreContext, input: {
  turnId: string; submissionId?: unknown; verdicts?: unknown; outcome: unknown; note?: unknown; model?: string | null;
  checks?: readonly SubmissionCheck[]; now?: string;
}): ReviewResult {
  return ctx.commit(() => {
    if (!supervised(ctx)) throw new HttpError(409, "submissions_unavailable", "reviews are not on at this engine level");
    if (input.outcome !== "approve" && input.outcome !== "reject") throw new HttpError(422, "invalid_args", "outcome must be approve or reject");
    const turn = ctx.db.query<{ id: string; bot_id: string; status: string }, [string]>("SELECT id, bot_id, status FROM turns WHERE id = ?")
      .get(requireNonEmpty("turnId", input.turnId));
    if (!turn || turn.status !== "running") throw new HttpError(409, "turn_ended", "this segment is no longer running");
    if (input.submissionId !== undefined && input.submissionId !== null && typeof input.submissionId !== "string") {
      throw new HttpError(422, "invalid_args", "submission_id must be a string");
    }
    const submission = reviewTarget(ctx, turn.id, (input.submissionId as string | undefined) ?? null);
    if (!submission) throw new HttpError(422, "invalid_args", "there is no submission here to review: name its submission_id");
    assertMayReview(ctx, turn.bot_id, submission);
    const stage = ticketStage(stagedTicket(ctx, submission.ticket_id));
    if ((submission.state !== "submitted" && submission.state !== "in_review") || (stage !== "submitted" && stage !== "in_review")) {
      throw new HttpError(409, "conflict", `submission ${submission.id} is ${submission.state} and its ticket ${stage}: there is nothing to review`);
    }
    if (submission.awaiting) throw new HttpError(409, "awaiting_user", `submission ${submission.id} waits on the user's answer; there is nothing more to review`);
    const verdicts = cleanVerdicts(input.verdicts);
    const outcome = input.outcome as "approve" | "reject";
    const now = input.now ?? isoNow();
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) || null : null;
    const model = input.model ?? segmentModel(ctx, turn.id);
    // A model nobody recorded (a segment with no route decision) counts as the producer's own: the
    // cautious reading, since nothing shows the two apart.
    const sameModel = !model || !submission.model || model === submission.model;
    const checks = [...(input.checks ?? submission.checks)];
    const record: ReviewRecord = { reviewer_bot_id: turn.bot_id, reviewer_model: model, same_model: sameModel, turn_id: turn.id, verdicts, outcome, note, at: now };
    if (outcome === "approve") {
      const reasons: string[] = [];
      const failing = checks.filter(gateFailed);
      if (failing.length > 0) reasons.push(`the app ran this submission's checks again just now, and a review does not overrule them: ${checkLines(failing, "en").join("; ")}`);
      const byId = new Map(verdicts.map((verdict) => [verdict.requirement_id, verdict]));
      for (const item of requiredItems(ctx, submission)) {
        const verdict = byId.get(item.requirement_id);
        if (verdict?.verdict !== "pass" || verdict.evidence.length === 0) {
          reasons.push(`requirement ${item.requirement_id} 「${item.quote}」 must be judged (${item.reasons.join(", ")}): it needs pass with evidence, not ${verdict ? `${verdict.verdict}${verdict.evidence.length === 0 ? " without evidence" : ""}` : "no verdict"}`);
          continue;
        }
        if (item.reasons.includes("visual") && !framesRead(ctx, turn.id, submission)) {
          reasons.push(`requirement ${item.requirement_id} 「${item.quote}」 is about the picture: read frames of this delivery (read_file on an image in this job's folder) before passing it`);
        }
      }
      if (reasons.length > 0) {
        ctx.db.run("UPDATE submissions SET checks = ?, updated_at = ? WHERE id = ?", [JSON.stringify(checks), now, submission.id]);
        recordWorkEvent(ctx, { kind: "review.refused", actor: turn.bot_id, botId: turn.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
          turnId: turn.id, payload: { submission_id: submission.id, reasons, same_model: sameModel } });
        return { ok: false, code: "review_refused", reasons, submission: getSubmission(ctx, submission.id) };
      }
      if (sameModel) {
        const open = unbackedItems(ctx, { ...submission, checks }, "raised");
        if (open.length > 0) {
          ctx.db.run("UPDATE submissions SET checks = ?, updated_at = ? WHERE id = ?", [JSON.stringify(checks), now, submission.id]);
          const card = askYou(ctx, getSubmission(ctx, submission.id), open, record, now);
          const waiting = open.map((item) => `requirement ${item.requirement_id} 「${item.quote}」 was raised ${item.times_raised} times, and you run on the producer's own model: your pass needs a passing check or the user's word${item.checks.length > 0 ? ` (the app measured: ${checkLines(item.checks, "en").join("; ")})` : ""}`);
          recordWorkEvent(ctx, { kind: "review.awaiting_user", actor: turn.bot_id, botId: turn.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
            turnId: turn.id, payload: { submission_id: submission.id, requirement_ids: open.map((item) => item.requirement_id), message_id: card?.id ?? null } });
          return { ok: false, code: "awaiting_user", reasons: waiting, submission: getSubmission(ctx, submission.id), card };
        }
      }
      // An organizer's reading or an answer is never approved on a reviewer's word alone: nobody
      // made the words. Nor is a hand-over no confirmed check backs, when the reviewer runs on the
      // producer's own model or gave no evidence for anything — one Bot passing another's claim.
      // Either way the clean approve moves it to your approve/reject card, its verdict shown there.
      // (Every gate passed by here: a failing or unrun one refused the approval above.)
      const unbacked = !checks.some(backs) && (sameModel || !hasEvidence(ctx, submission, verdicts));
      if (ORIGIN_NEEDS_USER.includes(submission.origin) || unbacked) {
        ctx.db.run("UPDATE submissions SET checks = ?, updated_at = ? WHERE id = ?", [JSON.stringify(checks), now, submission.id]);
        const card = askApproval(ctx, getSubmission(ctx, submission.id), now, record);
        recordWorkEvent(ctx, { kind: "review.awaiting_user", actor: turn.bot_id, botId: turn.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
          turnId: turn.id, payload: { submission_id: submission.id, requirement_ids: [], message_id: card?.id ?? null } });
        const why = ORIGIN_NEEDS_USER.includes(submission.origin)
          ? `submission ${submission.id} is a ${submission.origin === "answer" ? "words" : "organizer"} hand-over`
          : `no check the user confirmed backs submission ${submission.id}, and ${sameModel ? "you run on the producer's own model" : "your verdicts carry no evidence"}`;
        return { ok: false, code: "awaiting_user",
          reasons: [`${why}: a review's approve moves it to the user's approve/reject card, never straight to approved`],
          submission: getSubmission(ctx, submission.id), card };
      }
      approve(ctx, submission, record, checks, now);
      return { ok: true, submission: getSubmission(ctx, submission.id), outcome };
    }
    ctx.db.run("UPDATE submissions SET state = 'rejected', reviews = ?, checks = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify([...submission.reviews, record]), JSON.stringify(checks), now, submission.id]);
    setTicketStage(ctx, { ticketId: submission.ticket_id, stage: "rework", source: "review", botId: turn.bot_id,
      turnId: turn.id, workItemId: submission.work_item_id, submissionId: submission.id, now });
    const decided = getSubmission(ctx, submission.id);
    setPartStage(ctx, decided, "rework");
    const ceiling = checkCeiling(ctx, decided, now);
    noteHandOverFailed(ctx, submission.work_item_id, now);
    recordWorkEvent(ctx, { kind: "review.recorded", actor: turn.bot_id, botId: turn.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      turnId: turn.id, payload: { submission_id: submission.id, work_item_id: submission.work_item_id, outcome, same_model: sameModel } });
    tellProducer(ctx, decided, record, now, ceiling);
    return { ok: true, submission: decided, outcome };
  });
}

/** An approval: by a review (`record`) or, with none, by the app on its checks. The ticket and its parts are approved; the plan may be delivered. */
function approve(ctx: StoreContext, submission: Submission, record: ReviewRecord | null, checks: readonly SubmissionCheck[], now: string): void {
  ctx.db.run("UPDATE submissions SET state = 'approved', reviews = ?, checks = ?, awaiting = NULL, updated_at = ? WHERE id = ?",
    [JSON.stringify(record ? [...submission.reviews, record] : submission.reviews), JSON.stringify(checks), now, submission.id]);
  const approved = getSubmission(ctx, submission.id);
  setPartStage(ctx, approved, "approved");
  // A hand-over of some parts approves those; the ticket only once none is left open (a part stuck
  // at the ceiling, in rework or not made yet keeps it going). One of no part is the whole ticket.
  const openParts = submission.part_keys.length === 0 ? 0 : ctx.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM ticket_parts WHERE ticket_id = ? AND stage NOT IN ('approved', 'waived')").get(submission.ticket_id)!.n;
  setTicketStage(ctx, { ticketId: submission.ticket_id, stage: openParts === 0 ? "approved" : "doing", source: record ? "review" : "supervisor",
    botId: record?.reviewer_bot_id ?? null, turnId: record?.turn_id ?? null, workItemId: submission.work_item_id, submissionId: submission.id, now });
  // A job runs on its own level again once the ticket is through, not on one part of it (ADR 0049).
  if (openParts === 0) resetEscalation(ctx, submission.work_item_id);
  if (record) {
    recordWorkEvent(ctx, { kind: "review.recorded", actor: record.reviewer_bot_id, botId: record.reviewer_bot_id, taskId: submission.task_id,
      ticketId: submission.ticket_id, turnId: record.turn_id, payload: { submission_id: submission.id, work_item_id: submission.work_item_id, outcome: "approve",
        same_model: record.same_model } });
    tellProducer(ctx, approved, record, now);
  } else {
    recordWorkEvent(ctx, { kind: "submission.approved", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { submission_id: submission.id, work_item_id: submission.work_item_id, by: "no_reviewer" } });
  }
  if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "approved" });
  if (openParts === 0) closeCeilingCards(ctx, submission.ticket_id, locale(ctx) === "en" ? "The ticket was approved, so this no longer asks." : "这张任务已通过，不再问了。");
  settlePlanStage(ctx, submission.task_id, now);
}

/** A review's result in the producer's queue: a rejection wakes it to rework; an approval is read next time it wakes. */
function tellProducer(ctx: StoreContext, submission: Submission, review: ReviewRecord, now: string, ceiling: CeilingOutcome = NO_CEILING): void {
  if (!producerIsBot(ctx, submission)) return;
  const work = submission.work_item_id
    ? ctx.db.query<{ id: string; state: string }, [string]>("SELECT id, state FROM work_items WHERE id = ?").get(submission.work_item_id)
    : null;
  const sessionId = producerSession(ctx, submission);
  if (!sessionId) return;
  const failed = review.verdicts.filter((verdict) => verdict.verdict === "fail").map((verdict) => verdict.requirement_id);
  const en = locale(ctx) === "en";
  if (review.outcome === "reject") {
    tellAfterFailure(ctx, submission, en
      ? { what: `(app) Submission ${submission.id} did not pass review${failed.length ? ` (failing: ${failed.join(", ")})` : ""}${review.note ? `: ${review.note}` : "."}`, retry: "Rework it and submit again." }
      : { what: `（应用）交付 ${submission.id} 没通过审查${failed.length ? `（不通过：${failed.join("、")}）` : ""}${review.note ? `：${review.note}` : "。"}`, retry: "返工后再交。" }, ceiling, now);
    return;
  }
  if (work && work.state !== "closed") {
    queueInboxItem(ctx, { botId: submission.bot_id, sessionId, turnId: null, workItemId: work.id, taskId: submission.task_id, ticketId: submission.ticket_id,
      messageId: null, author: "app", body: en ? `(app) Submission ${submission.id} passed review.` : `（应用）交付 ${submission.id} 已通过审查。`,
      source: "review", kind: "result", priority: 2, wakes: false, now });
  }
  refreshHeldInbox(ctx, { botId: submission.bot_id });
}

/**
 * The card that asks you about required items nothing backs (ADR 0046): what each item is, what the
 * app measured on it (a check from your words, not confirmed), and three ways on — confirm the check
 * (it is then a gate and decides), say the item is met for this hand-over, or stop requiring it.
 * The approval waits on it, and the ball is yours. One card per submission and set of items.
 */
function askYou(ctx: StoreContext, submission: Submission, items: ReadonlyArray<RequiredItem & { checks: SubmissionCheck[] }>, review: ReviewRecord | null, now: string): Message | null {
  const requirementIds = items.map((item) => item.requirement_id).sort();
  const proposed = [...new Set(items.flatMap((item) => item.checks.filter((check) => !check.gate).map((check) => check.check_id)))];
  // A misread proposal that PASSES the wrong cut (ADR 0042): the card still shows it, but
  // 「确认这条检查」 is never the one button offered by default for it.
  const checksPassing = items.some((item) => item.checks.some((check) => !check.gate && check.outcome === "pass"));
  const previous = submission.awaiting;
  if (previous && JSON.stringify([...previous.requirement_ids].sort()) === JSON.stringify(requirementIds)) {
    if (review && !previous.review) ctx.db.run("UPDATE submissions SET awaiting = ? WHERE id = ?", [JSON.stringify({ ...previous, review }), submission.id]);
    // The checks measured since may have moved (a proposal that failed now passes, or the reverse):
    // the card's own read of that stays current even when nothing else about it changed.
    if (previous.message_id) {
      try {
        const card = getMessage(ctx, previous.message_id);
        if (card.control?.kind === "review_item" && Boolean(card.control.checks_passing) !== checksPassing) {
          setMessageControl(ctx, previous.message_id, { ...card.control, checks_passing: checksPassing });
        }
      } catch {
        // the card is gone: nothing to refresh
      }
    }
    return null;
  }
  if (previous?.message_id) letGoOfCard(ctx, previous.message_id, { reason: "replaced" });
  const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(submission.task_id);
  const ticket = stagedTicket(ctx, submission.ticket_id);
  let message: Message | null = null;
  if (plan?.session_id) {
    const en = locale(ctx) === "en";
    const number = String(ticket.seq).padStart(2, "0");
    const who = review ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(review.reviewer_bot_id)?.name ?? review.reviewer_bot_id : null;
    const lines = items.map((item) => {
      const measured = item.checks.length > 0 ? (en ? ` — measured: ${checkLines(item.checks, "en").join("; ")}` : `——应用量到：${checkLines(item.checks, "zh").join("；")}`) : "";
      const why = item.reasons.includes("raised") ? (en ? `you said it ${item.times_raised} times` : `你说过 ${item.times_raised} 次`) : (en ? "about the picture" : "关于画面");
      return en ? `- "${item.quote}" (${why})${measured}` : `- 「${item.quote}」（${why}）${measured}`;
    });
    const head = en
      ? review
        ? `Ticket ${number} "${ticket.title}" of ${plan.title}: ${who} passed submission ${submission.id}, but ${modelKnown(review, submission) ? "on the producer's own model" : "with no telling whether on the producer's own model"}, and nothing backs these:`
        : `Ticket ${number} "${ticket.title}" of ${plan.title}: submission ${submission.id} passed its checks and has no reviewer, and nothing backs these:`
      : review
        ? `${plan.title} 的任务 ${number}「${ticket.title}」：${who}放行了交付 ${submission.id}，但${modelKnown(review, submission) ? "它和做的 Bot 是同一个模型" : "看不出它和做的 Bot 是不是同一个模型"}，下面这几条没有东西撑着：`
        : `${plan.title} 的任务 ${number}「${ticket.title}」：交付 ${submission.id} 检查都过了、没有审查者，下面这几条没有东西撑着：`;
    const tail = en
      ? "Confirm the check to let it decide, say these are met, or stop requiring them."
      : "确认那条检查让它来判，说一声这几条做到了，或者不再要这几条。";
    const isDirect = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(plan.session_id)?.kind === "direct"
      && producerIsBot(ctx, submission);
    message = insertMessage(ctx, {
      sessionId: plan.session_id, kind: "system", author: isDirect ? submission.bot_id : USER_MEMBER, hiddenFromBots: true,
      body: [head, ...lines, tail].join("\n"),
      control: { kind: "review_item", submission_id: submission.id, task_id: submission.task_id, ticket_id: submission.ticket_id,
        requirement_ids: requirementIds, check_ids: proposed, checks_passing: checksPassing,
        offer: [...(proposed.length > 0 ? ["confirm_check" as const] : []), "confirm_item", "remove_item"] },
    });
    createNotification(ctx, { semantic_key: `review_item:${message.id}`, kind: "ask", session_id: plan.session_id, message_id: message.id, action_state: "open" });
  }
  const awaiting: AwaitingYou = { requirement_ids: requirementIds, check_ids: proposed, message_id: message?.id ?? null, review, at: now, kind: "items" };
  ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify(awaiting), now, submission.id]);
  return message;
}

/** The reviewer's verdict, for a card that shows it rather than acting on it: name, model, whether it ran on the producer's own, and its notes. */
/** Whether both the reviewer's and the producer's models are known: otherwise "the same model" is only how it is counted. */
function modelKnown(review: ReviewRecord, submission: Pick<Submission, "model">): boolean {
  return Boolean(review.reviewer_model && submission.model);
}

function reviewerVerdictLine(ctx: StoreContext, review: ReviewRecord, submission: Pick<Submission, "model">, en: boolean): string {
  const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(review.reviewer_bot_id)?.name ?? review.reviewer_bot_id;
  const model = review.reviewer_model ?? (en ? "unknown model" : "未知模型");
  const notes = [review.note, ...review.verdicts.map((v) => `${v.requirement_id}: ${v.verdict}${v.evidence.length > 0 ? ` (${v.evidence.join("; ")})` : ""}`)]
    .filter((line): line is string => Boolean(line));
  return en
    ? `${name} (${model}${review.same_model ? (modelKnown(review, submission) ? ", the same model as the producer" : ", counted as the producer's own model: one of the two is not known") : ""}) judged it ${review.outcome}${notes.length > 0 ? `: ${notes.join("; ")}` : "."}`
    : `${name}（${model}${review.same_model ? (modelKnown(review, submission) ? "，和生产者同模型" : "，有一方模型不明，按同模型算") : ""}）判了${review.outcome === "approve" ? "通过" : "不通过"}${notes.length > 0 ? `：${notes.join("；")}` : "。"}`;
}

/**
 * The card for a hand-over that is never approved on its own say — not the organizer's word, not a
 * reviewer's with nothing standing behind it, not an automatic measurement with nothing standing
 * behind it (ADR 0046). Shown for an `answer` or `organizer` submission once its checks and required
 * items clear, reviewed or not; for a `submit`/`implicit` file hand-over no active (confirmed) gate
 * backs, when no reviewer judged it, or when the reviewer ran on the producer's own model or gave no
 * evidence. `review`, when given, is the reviewer's own clean approve — shown on the card, not acted
 * on; your two buttons are the submission's own outcome (`approve`, `reject` — `answerReviewCard`),
 * not a required item's.
 */
function askApproval(ctx: StoreContext, submission: Submission, now: string, review: ReviewRecord | null = null): Message | null {
  const previous = submission.awaiting;
  if (previous?.kind === "approval") return null;
  if (previous?.message_id) letGoOfCard(ctx, previous.message_id, { reason: "replaced" });
  const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(submission.task_id);
  const ticket = stagedTicket(ctx, submission.ticket_id);
  let message: Message | null = null;
  if (plan?.session_id) {
    const en = locale(ctx) === "en";
    const number = String(ticket.seq).padStart(2, "0");
    const verdict = review ? `\n${reviewerVerdictLine(ctx, review, submission, en)}` : "";
    const head = submission.origin === "answer"
      ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: the words themselves — "${truncatedAnswer(submission.content ?? "")}"`
        : `${plan.title} 的任务 ${number}「${ticket.title}」：交的话本身——「${truncatedAnswer(submission.content ?? "")}」`)
      : submission.origin === "organizer"
        ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: the organizer read this as done.`
          : `${plan.title} 的任务 ${number}「${ticket.title}」：整理跳认为这张任务做完了。`)
        : review
          ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: a hand-over no check you confirmed backs — ${submission.artifacts.map((a) => a.path).join(", ")}`
            : `${plan.title} 的任务 ${number}「${ticket.title}」：一份没有你确认过的检查撑着的交付——${submission.artifacts.map((a) => a.path).join("、")}`)
          : (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: a hand-over with no reviewer and no active check backing it — ${submission.artifacts.map((a) => a.path).join(", ")}`
            : `${plan.title} 的任务 ${number}「${ticket.title}」：一份没有审查者、也没有生效检查撑着的交付——${submission.artifacts.map((a) => a.path).join("、")}`);
    const tail = en ? "Approve it, or send it back." : "放行，或者退回。";
    const body = [head + verdict, tail].join("\n");
    const isDirect = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(plan.session_id)?.kind === "direct"
      && producerIsBot(ctx, submission);
    // A file hand-over's card links the files themselves, to open and look.
    const paths = submission.origin !== "answer" && submission.origin !== "organizer" ? submission.artifacts.map((a) => a.path) : undefined;
    message = insertMessage(ctx, {
      sessionId: plan.session_id, kind: "system", author: isDirect ? submission.bot_id : USER_MEMBER, hiddenFromBots: true, body,
      ...(paths && paths.length > 0 ? { paths } : {}),
      control: { kind: "review_item", submission_id: submission.id, task_id: submission.task_id, ticket_id: submission.ticket_id,
        requirement_ids: [], check_ids: [], offer: ["approve", "reject"] },
    });
    createNotification(ctx, { semantic_key: `review_item:${message.id}`, kind: "ask", session_id: plan.session_id, message_id: message.id, action_state: "open" });
  }
  const awaiting: AwaitingYou = { requirement_ids: [], check_ids: [], message_id: message?.id ?? null, review, at: now, kind: "approval" };
  ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify(awaiting), now, submission.id]);
  return message;
}

/** Why a card no longer waits on you, as it then reads in place of its buttons. */
type LetGo =
  | { reason: "superseded"; by: "submission" | "board" | "complaint" }
  | { reason: "checks_failed"; lines: readonly string[] }
  | { reason: "approved" | "replaced" };

function letGoLine(ctx: StoreContext, why: LetGo): string {
  const en = locale(ctx) === "en";
  switch (why.reason) {
    case "superseded":
      return why.by === "board"
        ? (en ? "You changed the ticket's status on the board, so this hand-over no longer counts." : "你在看板上改了这张任务的状态，这份交付作废了。")
        : why.by === "complaint"
          ? (en ? "You said something is wrong with it, so it went back to rework." : "你说它有问题，转回返工了。")
          : (en ? "A newer hand-over replaced this one." : "已被新的交付取代。");
    case "checks_failed":
      return en ? `Its checks failed, so it was sent back${why.lines.length > 0 ? `: ${why.lines.join("; ")}` : "."}`
        : `检查没过，已退回${why.lines.length > 0 ? `：${why.lines.join("；")}` : "。"}`;
    case "approved":
      return en ? "Approved." : "已放行。";
    case "replaced":
      return en ? "A newer card about this hand-over replaced this one." : "这份交付换了一张新卡片来问。";
  }
}

/** A card about a submission that no longer waits on you: its buttons go, it says why, its notification resolves. */
function letGoOfCard(ctx: StoreContext, messageId: string, why: LetGo): void {
  let control: Message["control"];
  try {
    control = getMessage(ctx, messageId).control;
  } catch {
    return;
  }
  if (control?.kind !== "review_item") return;
  if ((control.acted ?? []).length === 0) setMessageControl(ctx, messageId, { ...control, offer: [], acted: [], result: letGoLine(ctx, why) });
  updateNotificationActionState(ctx, `review_item:${messageId}`, "resolved", why.reason, true);
}

/**
 * Takes up a submission that waits on you again, against what is true now: the checks as they
 * last ran, your confirmations, the requirements still in force. A gate failing now sends it back to
 * its producer; nothing left open completes the approval it was waiting for (the review's, or the
 * app's with no reviewer); otherwise it keeps waiting.
 */
function takeUpAwaiting(ctx: StoreContext, submission: Submission, now: string): { submission: Submission; unrun: string[] } {
  const checks = checkResults(ctx, boundCheckIds(ctx, submission), submission.created_at);
  // A gate that ran and did not pass sends it back; one that has not finished running yet is waited
  // for (the engine runs it), never read as a failure.
  if (checks.some((check) => gateFailed(check) && check.outcome !== "not_run")) {
    failOnGates(ctx, submission, checks.filter((check) => check.outcome !== "not_run"), now, true);
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  const unrun = checks.filter((check) => check.gate && check.outcome === "not_run").map((check) => check.check_id);
  if (unrun.length > 0) return { submission, unrun };
  // Your approve/reject card waits on your press alone; a later tick never approves it by itself.
  // A 放行 you already pressed, waiting on a gate, resolves here once every gate has run — one
  // added while it waited included, which the press's own run never saw.
  if (submission.awaiting?.kind === "approval") {
    return { submission: submission.awaiting.pending ? resolveApproval(ctx, submission, checks, now) : submission, unrun: [] };
  }
  const review = submission.awaiting?.review ?? null;
  const open = unbackedItems(ctx, submission, review ? "raised" : "all");
  if (open.length > 0) {
    askYou(ctx, submission, open, review, now);
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  // An organizer's reading or an answer always ends on your approve/reject card: nobody made the
  // words, reviewed or not. A file hand-over (submit/implicit) with no reviewer auto-approves only
  // when at least one gate you wrote or confirmed backs it and all gates pass — by here every gate
  // that ran did (the first check above sent a failure back); with none of yours bound, it waits
  // on the same card instead.
  if (ORIGIN_NEEDS_USER.includes(submission.origin) || (!review && !checks.some(backs))) {
    askApproval(ctx, submission, now, review);
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  approve(ctx, submission, review, checks, now);
  return { submission: getSubmission(ctx, submission.id), unrun: [] };
}

export type ReviewCardAction = "confirm_check" | "confirm_item" | "remove_item" | "approve" | "reject";
const REVIEW_CARD_ACTIONS: readonly ReviewCardAction[] = ["confirm_check", "confirm_item", "remove_item", "approve", "reject"];

/**
 * Approves or sends an approve/reject card's submission back, once its gates have all run: 已放行
 * only when it actually approved — a gate that had not run yet is waited for, never read as a
 * failure. Marks the card itself with what happened, not just that 放行 was pressed.
 */
function resolveApproval(ctx: StoreContext, submission: Submission, checks: readonly SubmissionCheck[], now: string): Submission {
  const cardId = submission.awaiting?.message_id ?? null;
  const review = submission.awaiting?.review ?? null;
  const failing = checks.filter(gateFailed);
  if (failing.length > 0) {
    failOnGates(ctx, submission, checks as SubmissionCheck[], now, true);
    if (cardId) markApprovalCard(ctx, cardId, "reject", checkLines(failing, locale(ctx)));
  } else {
    approve(ctx, submission, review, checks, now);
    if (cardId) markApprovalCard(ctx, cardId, "approve", []);
  }
  return getSubmission(ctx, submission.id);
}

/** The approve/reject card's own record of the outcome, shown in place of the generic 已放行/已退回 label when it differs from the button pressed. */
function markApprovalCard(ctx: StoreContext, messageId: string, outcome: "approve" | "reject", failingLines: readonly string[]): void {
  let control: Message["control"];
  try {
    control = getMessage(ctx, messageId).control;
  } catch {
    return;
  }
  if (control?.kind !== "review_item") return;
  const en = locale(ctx) === "en";
  const result = outcome === "reject"
    ? (en ? `Its checks failed, so it was sent back${failingLines.length > 0 ? `: ${failingLines.join("; ")}` : "."}`
      : `检查没过，已退回${failingLines.length > 0 ? `：${failingLines.join("；")}` : "。"}`)
    : undefined;
  setMessageControl(ctx, messageId, { ...control, offer: [], acted: [outcome], ...(result ? { result } : {}) });
  updateNotificationActionState(ctx, `review_item:${messageId}`, "resolved", outcome, true);
}

/**
 * After the gate a pressed 放行 was waiting on has run (`answerReviewCard`'s `checkIds`): resolves
 * it the way `resolveApproval` always does, never a second ask. A gate still not_run (one added
 * while it waited) keeps it pending: the supervisor's tick runs that gate and resolves the press
 * (`takeUpAwaiting`). A submission no longer `submitted`/`in_review`, or not waiting on a press,
 * is left alone.
 */
export function takeUpPendingApproval(ctx: StoreContext, submissionId: string, now: string = isoNow()): Submission {
  return ctx.commit(() => {
    const submission = getSubmission(ctx, submissionId);
    if ((submission.state !== "submitted" && submission.state !== "in_review") || submission.awaiting?.kind !== "approval" || !submission.awaiting.pending) {
      return submission;
    }
    const checks = checkResults(ctx, boundCheckIds(ctx, submission), submission.created_at);
    if (checks.some((check) => check.gate && check.outcome === "not_run")) return submission;
    return resolveApproval(ctx, submission, checks, now);
  });
}

/**
 * Your answer on a card, once per card. On a required-items card: confirming the item says it is
 * met for this hand-over; removing it stops requiring it in this plan (waived, or not held here
 * when it is the conversation's or standing); confirming the check makes it a gate, and the engine
 * then runs it and takes the submission up again (returned in `checkIds`). On an approve/reject
 * card: `approve` resolves it on its checks as the
 * no-reviewer path always did, with a gate still `not_run` waited for first (its check ids come
 * back in `checkIds`, for the engine to run before taking it up again — `takeUpPendingApproval`);
 * `reject` sends it back to rework and wakes its producer, the way a reviewer's reject does.
 */
export function answerReviewCard(ctx: StoreContext, messageId: string, action: unknown): { submission: Submission; checkIds: string[]; message: Message } {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "review_item") throw new HttpError(422, "invalid_args", "this line is not about a hand-over's requirements");
    if (!REVIEW_CARD_ACTIONS.includes(action as ReviewCardAction)) throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action as ReviewCardAction)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const submission = getSubmission(ctx, control.submission_id);
    if (submission.awaiting?.message_id !== messageId) throw new HttpError(409, "conflict", "this hand-over no longer waits on this line");
    const now = isoNow();
    if (action === "approve") {
      const checks = checkResults(ctx, boundCheckIds(ctx, submission), submission.created_at);
      const unrun = checks.filter((check) => check.gate && check.outcome === "not_run").map((check) => check.check_id);
      if (unrun.length > 0) {
        // Wait: the engine runs the gate, then takes it up again (`takeUpPendingApproval`, or the
        // supervisor's tick for a gate added meanwhile) — neither a failure nor an approval yet.
        // The card says it is waiting; only 退回 is left on it, and a second 放行 is refused.
        ctx.db.run("UPDATE submissions SET awaiting = ? WHERE id = ?", [JSON.stringify({ ...submission.awaiting!, pending: true }), submission.id]);
        const en = locale(ctx) === "en";
        setMessageControl(ctx, messageId, { ...control, offer: control.offer.filter((offered) => offered === "reject"),
          result: en ? "Waiting for its checks to finish before approving…" : "等检查跑完再放行…" });
        return { submission: getSubmission(ctx, submission.id), checkIds: unrun, message: getMessage(ctx, messageId) };
      }
      const after = resolveApproval(ctx, submission, checks, now);
      return { submission: after, checkIds: [], message: getMessage(ctx, messageId) };
    }
    let checkIds: string[] = [];
    let after: Submission;
    if (action === "reject") {
      after = rejectByUser(ctx, submission, now);
    } else {
      if (action === "confirm_item") {
        recordWorkEvent(ctx, { kind: "review.item_confirmed", actor: USER_MEMBER, taskId: submission.task_id, ticketId: submission.ticket_id,
          payload: { submission_id: submission.id, requirement_ids: control.requirement_ids, message_id: messageId } });
      } else if (action === "remove_item") {
        for (const id of control.requirement_ids) {
          const scope = ctx.db.query<{ scope: string; status: string }, [string]>("SELECT scope, status FROM requirements WHERE id = ?").get(id);
          if (!scope || scope.status !== "open") continue;
          if (scope.scope === "project" || scope.scope === "standing") setRequirementHere(ctx, id, { taskId: submission.task_id, holds: false, action: messageId });
          else waiveRequirement(ctx, id, { taskId: submission.task_id, action: messageId, now });
        }
      } else {
        checkIds = control.check_ids.filter((id) => {
          try {
            confirmDerivedCheck(ctx, id);
            return true;
          } catch {
            return false; // gone, or replaced meanwhile: nothing to confirm
          }
        });
      }
      after = action === "confirm_check" ? getSubmission(ctx, submission.id) : takeUpAwaiting(ctx, getSubmission(ctx, submission.id), now).submission;
    }
    // What the press did, in place of a waiting line it may have had (退回 while 放行 was pending).
    const { result: _waiting, ...answered } = control;
    setMessageControl(ctx, messageId, { ...answered, acted: [action as ReviewCardAction] });
    updateNotificationActionState(ctx, `review_item:${messageId}`, "resolved", action as ReviewCardAction, true);
    return { submission: after, checkIds, message: getMessage(ctx, messageId) };
  });
}

/** Your 退回 on an approval card (ADR 0046): rework, the way a reviewer's reject reads, without one. */
function rejectByUser(ctx: StoreContext, submission: Submission, now: string): Submission {
  ctx.db.run("UPDATE submissions SET state = 'rejected', checks = ?, awaiting = NULL, updated_at = ? WHERE id = ?",
    [JSON.stringify(submission.checks), now, submission.id]);
  setTicketStage(ctx, { ticketId: submission.ticket_id, stage: "rework", source: "user", turnId: null, workItemId: submission.work_item_id, submissionId: submission.id, now });
  const decided = getSubmission(ctx, submission.id);
  setPartStage(ctx, decided, "rework");
  const ceiling = checkCeiling(ctx, decided, now);
  noteHandOverFailed(ctx, submission.work_item_id, now);
  recordWorkEvent(ctx, { kind: "review.recorded", actor: USER_MEMBER, taskId: submission.task_id, ticketId: submission.ticket_id,
    payload: { submission_id: submission.id, work_item_id: submission.work_item_id, outcome: "reject", by: "user" } });
  const en = locale(ctx) === "en";
  tellAfterFailure(ctx, decided, en ? { what: `(app) The user sent submission ${decided.id} back for rework.`, retry: "" } : { what: `（应用）用户把交付 ${decided.id} 退回重做了。`, retry: "" }, ceiling, now);
  return decided;
}

/** After the checks you confirmed on a card have run: the submission taken up again. */
export function takeUpSubmission(ctx: StoreContext, submissionId: string, now: string = isoNow()): Submission {
  return ctx.commit(() => {
    const submission = getSubmission(ctx, submissionId);
    if (submission.state !== "submitted" && submission.state !== "in_review") return submission;
    return takeUpAwaiting(ctx, submission, now).submission;
  });
}

/**
 * A plan whose every ticket not dropped is approved, and whose plan-wide gates (checks on no ticket)
 * last passed, is delivered (§2.6 active → delivered), by the same path the plan's status always
 * takes (`setTaskSpec`: its spec says done, it closes as a done plan does, a stop over it still reads
 * parked).
 */
export function settlePlanStage(ctx: StoreContext, taskId: string, now: string = isoNow()): boolean {
  const plan = ctx.db.query<{ status: string; stage: string | null }, [string]>("SELECT status, stage FROM tasks WHERE id = ?").get(taskId);
  if (!plan || (plan.stage ?? (plan.status === "done" ? "delivered" : "active")) !== "active") return false;
  const stages = ctx.db.query<{ stage: string }, [string]>(`SELECT ${STAGE_SQL("t")} AS stage FROM tickets t WHERE t.task_id = ?`).all(taskId)
    .map((row) => row.stage).filter((stage) => stage !== "dropped");
  if (stages.length === 0 || stages.some((stage) => stage !== "approved")) return false;
  const gates = ctx.db.query<{ id: string; origin: string | null; bind_kind: string | null; derived_state: string | null }, [string]>(
    "SELECT id, origin, bind_kind, derived_state FROM acceptance_checks WHERE task_id = ? AND ticket_id IS NULL AND removed_at IS NULL").all(taskId)
    .filter((check) => !derivedNotGate(check));
  for (const gate of gates) {
    const last = ctx.db.query<{ outcome: string | null; judged_by: string | null }, [string]>(`SELECT outcome, judged_by FROM acceptance_check_runs
      WHERE check_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(gate.id);
    // A verdict of pictures is only a reference (ADR 0046): it neither holds the plan back nor lets it through.
    if (last?.judged_by === "vision") continue;
    if (last?.outcome !== "pass") return false;
  }
  const task = getTask(ctx, taskId);
  const spec = parsePlanSpec(task.spec) ?? emptyPlanSpec(task.brief ?? task.title);
  setTaskSpec(ctx, taskId, { ...spec, status: "done" }, now);
  ctx.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = ? WHERE id = ?", [now, taskId]);
  recordWorkEvent(ctx, { kind: "plan.delivered", actor: "app", taskId, payload: { tickets: stages.length } });
  return true;
}

/**
 * The supervisor's part (§5.3.7), each tick, outside your stops and dormant plans: a submission
 * checked and handed over with no reviewer for longer than one tick goes to the ticket's reviewer if
 * it has one by now; else the app reads its checks as they are now (a gate failing sends it back to
 * its producer) and approves it, unless a required item (raised twice or more, or about the
 * picture) has nothing behind it — then a card asks you. A submission waiting on you is taken up
 * again each tick against what is true now. Returns what it moved and the cards it wrote.
 */
export function superviseSubmissions(ctx: StoreContext, now: string = isoNow()): {
  moved: Submission[]; messages: Message[]; toRun: Array<{ taskId: string; checkIds: string[] }>;
} {
  const out = { moved: [] as Submission[], messages: [] as Message[], toRun: [] as Array<{ taskId: string; checkIds: string[] }> };
  if (!supervised(ctx)) return out;
  const cutoff = new Date(Date.parse(now) - UNREVIEWED_AFTER_MS).toISOString();
  const rows = ctx.db.query<SubmissionRow, [string]>(`SELECT * FROM submissions WHERE (state = 'submitted' AND updated_at <= ?)
    OR (state IN ('submitted', 'in_review') AND awaiting IS NOT NULL) ORDER BY created_at, rowid`).all(cutoff).map(toSubmission);
  for (const submission of rows) {
    const ticket = stagedTicket(ctx, submission.ticket_id);
    const stage = ticketStage(ticket);
    if (stage !== "submitted" && stage !== "in_review") continue;
    const plan = ctx.db.query<{ session_id: string | null; dormant_since: string | null }, [string]>(
      "SELECT session_id, dormant_since FROM tasks WHERE id = ?").get(submission.task_id);
    if (!plan || plan.dormant_since) continue;
    if (holdsCovering(ctx, { botId: submission.bot_id, sessionId: plan.session_id, taskId: submission.task_id, ticketId: ticket.id }).length > 0) continue;
    const card = submission.awaiting?.message_id ?? null;
    // A ticket's reviewer, once set, judges an organizer's reading the same as any other hand-over
    // (its approve then only shows on your card).
    const reviewer = submission.awaiting ? null : ticketReviewer(ctx, ticket.id, submission.bot_id);
    if (reviewer) {
      ctx.db.run("UPDATE submissions SET state = 'in_review', updated_at = ? WHERE id = ?", [now, submission.id]);
      setTicketStage(ctx, { ticketId: ticket.id, stage: "in_review", source: "supervisor", submissionId: submission.id, workItemId: submission.work_item_id, now });
      requestReview(ctx, getSubmission(ctx, submission.id), reviewer, now);
      out.moved.push(getSubmission(ctx, submission.id));
      continue;
    }
    const taken = takeUpAwaiting(ctx, submission, now);
    if (taken.unrun.length > 0) {
      out.toRun.push({ taskId: submission.task_id, checkIds: taken.unrun });
      continue;
    }
    const after = taken.submission;
    if (after.state !== submission.state || after.awaiting?.message_id !== card) out.moved.push(after);
    if (after.awaiting?.message_id && after.awaiting.message_id !== card) out.messages.push(getMessage(ctx, after.awaiting.message_id));
  }
  return out;
}

/** Whether `producer` has a segment still running on this ticket, or a work item that is not idle: real work that an organizer's reading must not race ahead of. */
function producerBusy(ctx: StoreContext, ticket: Pick<StagedTicketRow, "task_id" | "id">, producer: string | null): boolean {
  if (!producer) return false;
  if (ctx.db.query(`SELECT 1 FROM turns WHERE bot_id = ? AND task_id = ? AND (ticket_id = ? OR ticket_id IS NULL) AND status = 'running'`)
    .get(producer, ticket.task_id, ticket.id)) return true;
  const work = ctx.db.query<{ state: string }, [string, string, string]>(`SELECT state FROM work_items WHERE bot_id = ? AND task_id = ?
    AND ticket_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(producer, ticket.task_id, ticket.id);
  return Boolean(work) && work!.state !== "idle";
}

/**
 * The organizer read a ticket as done (from level 5 it writes no ticket's status, ADR 0046). On a
 * ticket nothing was ever handed over on — its work was not a file, or not in its folder — that
 * reading becomes a submission of its own (`organizer`), which goes the no-reviewer way at the next
 * tick: its checks, then a card to you if a required item has nothing behind it; never ignored, never
 * approved on the organizer's word alone. A ticket with submissions moves by them, not by this. A
 * producer still running on the ticket, or whose work item is not idle, is left alone this round —
 * the reading would otherwise race ahead of work still in progress;
 * the organizer tries again next time it reads the ticket as done.
 */
export function organizerSaysDone(ctx: StoreContext, ticketId: string, now: string = isoNow()): Submission | null {
  if (!supervised(ctx)) return null;
  const ticket = stagedTicket(ctx, ticketId);
  const stage = ticketStage(ticket);
  if (stage === "approved" || stage === "dropped" || stage === "submitted" || stage === "in_review") return null;
  if (ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ?").get(ticketId)) return null;
  // Stuck at the capability ceiling: your answer on its card decides, not the organizer's reading.
  if (ceilingCardOf(ctx, ticketId)) return null;
  const producer = ticket.owner_bot_id ?? ticket.worker;
  if (producerBusy(ctx, ticket, producer)) return null;
  const work = producer ? ctx.db.query<{ id: string }, [string, string, string]>(`SELECT id FROM work_items WHERE bot_id = ? AND task_id = ?
    AND ticket_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(producer, ticket.task_id, ticket.id) : null;
  const id = ulid(Date.parse(now));
  // Due at the next tick: the organizer's reading is not one more Bot to wait for.
  const due = new Date(Date.parse(now) - UNREVIEWED_AFTER_MS).toISOString();
  ctx.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
      note, state, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, 'organizer', '[]', NULL, '[]', ?, 'submitted', ?, ?)`,
    [id, work?.id ?? null, ticket.task_id, ticket.id, producer ?? "app", locale(ctx) === "en" ? "The organizer read this ticket as done." : "整理跳认为这张任务做完了。", now, due]);
  setTicketStage(ctx, { ticketId: ticket.id, stage: "submitted", source: "submission", botId: producer, workItemId: work?.id ?? null, submissionId: id, now });
  recordWorkEvent(ctx, { kind: "submission.created", actor: "app", botId: producer, taskId: ticket.task_id, ticketId: ticket.id,
    payload: { submission_id: id, work_item_id: work?.id ?? null, origin: "organizer", artifacts: [], parts: [], superseded: [] } });
  return getSubmission(ctx, id);
}

/**
 * The files a segment cited that an implicit submission hands over (§5.2): in its ticket's folder,
 * attached to its own lines, not where the app keeps its own files.
 */
export function implicitSubmissionPaths(ctx: StoreContext, turnId: string): string[] {
  const turn = ctx.db.query<{ bot_id: string; ticket_id: string | null }, [string]>("SELECT bot_id, ticket_id FROM turns WHERE id = ?").get(turnId);
  if (!turn?.ticket_id) return [];
  const dir = ctx.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE id = ?").get(turn.ticket_id)?.dir;
  if (!dir) return [];
  return ctx.db.query<{ path: string }, [string, string]>(`SELECT DISTINCT a.workspace_relpath AS path FROM attachments a
    JOIN messages m ON m.id = a.message_id WHERE (m.turn_id = ?1 OR m.source_turn_id = ?1) AND m.author = ?2 AND m.kind = 'bot'
    ORDER BY a.workspace_relpath`).all(turnId, turn.bot_id).map((row) => row.path)
    .filter((path) => inTicketDir(dir, path));
}

/** Where a complaint can still send work back: handed over, under review, or approved. */
const REWORKABLE: readonly TicketStage[] = ["submitted", "in_review", "approved"];
/** How much of your line a rework card or a calibration record quotes. */
const COMPLAINT_EXCERPT_MAX = 80;

type ReworkBefore = {
  ticket_stage: TicketStage;
  parts: Array<{ key: string; stage: string }>;
  plan_stage: string;
  submissions: Array<{ id: string; state: SubmissionState }>;
};

export type ReworkCardAction = "rework" | "dismiss" | "undo";
const REWORK_CARD_ACTIONS: readonly ReworkCardAction[] = ["rework", "dismiss", "undo"];

function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}

/** The rework cards about one line of yours, by ticket. */
function reworkCards(ctx: StoreContext, messageId: string): Array<{ id: string; ticket_id: string }> {
  return ctx.db.query<{ id: string; ticket_id: string }, [string]>(`SELECT id, json_extract(control, '$.ticket_id') AS ticket_id FROM messages
    WHERE json_extract(control, '$.kind') = 'rework' AND json_extract(control, '$.message_id') = ? ORDER BY created_at, rowid`).all(messageId);
}

/**
 * Your complaint about work already handed over or approved (§6.6, ADR 0046), read with no model —
 * and only ever asked about, never acted on by itself: what a word list makes of a line is a guess
 * («收到» in a reply, «别重做了», «C07 很好，比上一版那个错乱的好多了»), so a guess costs a card, not
 * a rework. A line of yours filed under a ticket (or some of its parts) by the rows or by you — not a
 * Bot's pick — while that ticket is handed over, in review or approved, asks when one of its clauses
 * objects (`clauseObjects`: a complaint word, no praise, no redo turned down), when it annotates a
 * file, or when the scribe made a part-level entry of it. The parts asked about are those an
 * objecting clause numbers, or every part it was filed under when an objecting clause numbers none
 * (or the signal was not words). One card per line and ticket; on a refile, a card still asking about
 * a ticket the line is no longer filed under stops asking. Returns the new cards.
 */
export function noteComplaint(ctx: StoreContext, messageId: string, input: { scribeAdded?: readonly string[]; now?: string } = {}): Message[] {
  return ctx.commit(() => {
    if (!supervised(ctx)) return [];
    const message = ctx.db.query<{ id: string; kind: string; body: string }, [string]>("SELECT id, kind, body FROM messages WHERE id = ?").get(messageId);
    if (!message || message.kind !== "user") return [];
    const filings = ctx.db.query<{ ticket_id: string; part_key: string | null }, [string]>(`SELECT ticket_id, part_key FROM message_filings
      WHERE message_id = ? AND ticket_id IS NOT NULL AND strength IN ('locked', 'default', 'user') ORDER BY is_primary DESC, rowid`).all(messageId);
    const existing = reworkCards(ctx, messageId);
    for (const card of existing) {
      if (filings.some((filing) => filing.ticket_id === card.ticket_id)) continue;
      const control = getMessage(ctx, card.id).control;
      if (control?.kind === "rework" && control.offer.includes("rework") && (control.acted ?? []).length === 0) {
        setMessageControl(ctx, card.id, { ...control, offer: [], result: locale(ctx) === "en" ? "That line was filed elsewhere since." : "这句话后来改归别处了。" });
      }
    }
    const annotated = Boolean(ctx.db.query("SELECT 1 FROM annotations WHERE message_id = ? AND status <> 'draft'").get(messageId));
    const scribed = (input.scribeAdded ?? []).length > 0
      && Boolean(ctx.db.query("SELECT 1 FROM requirements WHERE scope = 'part' AND id IN (SELECT value FROM json_each(?))").get(JSON.stringify(input.scribeAdded)));
    const objecting = clausesOf(message.body).filter(clauseObjects);
    if (!annotated && !scribed && objecting.length === 0) return [];
    // Which parts it is about: those an objecting clause numbers; all it was filed under when one
    // numbers none, or when the signal is the annotation or the scribe's entry rather than words.
    const numbered = objecting.map(partNumbers);
    const general = annotated || scribed || numbered.some((numbers) => numbers.length === 0);
    const named = new Set(numbered.flat());
    const byTicket = new Map<string, { whole: boolean; parts: Set<string> }>();
    for (const filing of filings) {
      const entry = byTicket.get(filing.ticket_id) ?? { whole: false, parts: new Set<string>() };
      if (!filing.part_key) entry.whole = true;
      else if (general || filenamePartNumbers(filing.part_key).some((n) => named.has(n))) entry.parts.add(filing.part_key);
      byTicket.set(filing.ticket_id, entry);
    }
    const now = input.now ?? isoNow();
    const excerpt = truncate(message.body.replace(/\s+/g, " ").trim(), COMPLAINT_EXCERPT_MAX);
    const cards: Message[] = [];
    for (const [ticketId, about] of byTicket) {
      if (existing.some((card) => card.ticket_id === ticketId)) continue;
      if (!about.whole && about.parts.size === 0) continue;
      const ticket = stagedTicket(ctx, ticketId);
      if (!REWORKABLE.includes(ticketStage(ticket))) continue;
      const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(ticket.task_id);
      if (!plan?.session_id) continue;
      const partKeys = about.parts.size > 0 ? [...about.parts].sort() : [];
      const en = locale(ctx) === "en";
      const number = String(ticket.seq).padStart(2, "0");
      const what = partKeys.length > 0 ? (en ? ` (${partKeys.join(", ")})` : `（${partKeys.join("、")}）`) : "";
      const card = insertMessage(ctx, {
        sessionId: plan.session_id, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
        body: en ? `You said "${excerpt}" — send ticket ${number} "${ticket.title}"${what} of ${plan.title} back to rework?`
          : `你说「${excerpt}」——要把 ${plan.title} 的任务 ${number}「${ticket.title}」${what}转回返工吗？`,
        control: { kind: "rework", task_id: ticket.task_id, ticket_id: ticketId, part_keys: partKeys, message_id: messageId, offer: ["rework", "dismiss"] },
      });
      createNotification(ctx, { semantic_key: `rework:${card.id}`, kind: "ask", session_id: plan.session_id, message_id: card.id, action_state: "open" });
      recordWorkEvent(ctx, { kind: "complaint.asked", actor: "app", taskId: ticket.task_id, ticketId,
        payload: { message_id: messageId, card_id: card.id, parts: partKeys, signal: annotated ? "annotation" : scribed ? "scribe" : "words", at: now } });
      cards.push(card);
    }
    return cards;
  });
}

/** A delivered plan your complaint reopened: active again, by the path its status always takes. */
function reopenPlan(ctx: StoreContext, taskId: string, now: string): void {
  const task = getTask(ctx, taskId);
  const spec = parsePlanSpec(task.spec) ?? emptyPlanSpec(task.brief ?? task.title);
  setTaskSpec(ctx, taskId, { ...spec, status: "active" }, now);
  ctx.db.run("UPDATE tasks SET stage = 'active', delivered_at = NULL WHERE id = ?", [taskId]);
  recordWorkEvent(ctx, { kind: "plan.reopened", actor: USER_MEMBER, taskId, payload: { by: "complaint" } });
}

/**
 * Your answer on a rework card (§6.6). Rework: the parts it names (else the ticket) go back to
 * rework, a hand-over still waiting is superseded, every review that approved the current hand-over
 * gets a `review.miss` (once per hand-over and reviewer — the reviewer reads it in its calibration
 * record), a delivered plan is active again, and the producer is woken with what you said; the card
 * then offers undo. Refused when the ticket is no longer handed over, in review or approved.
 * Dismiss: nothing moves. Undo: the ticket, its parts, the plan and the superseded hand-overs back
 * where they were, the misses no longer counted — refused once the work has moved on (a newer
 * hand-over, or the ticket out of rework).
 */
export function answerReworkCard(ctx: StoreContext, cardId: string, action: unknown): Message {
  return ctx.commit(() => {
    const card = getMessage(ctx, cardId);
    const control = card.control;
    if (control?.kind !== "rework") throw new HttpError(422, "invalid_args", "this line is not a rework card");
    if (!REWORK_CARD_ACTIONS.includes(action as ReworkCardAction)) throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action as ReworkCardAction)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const now = isoNow();
    const en = locale(ctx) === "en";
    if (action === "dismiss") {
      updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "dismiss", true);
      return setMessageControl(ctx, cardId, { ...control, acted: ["dismiss"] });
    }
    if (action === "undo") return undoRework(ctx, cardId, control, now);
    const ticket = stagedTicket(ctx, control.ticket_id);
    const stage = ticketStage(ticket);
    // The work moved on since your line: nothing handed over or approved to send back, or a newer
    // hand-over your line was not about. The card says so instead of acting on the wrong version.
    const saidAt = ctx.db.query<{ created_at: string }, [string]>("SELECT created_at FROM messages WHERE id = ?").get(control.message_id)?.created_at ?? "";
    const newer = Boolean(ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND created_at > ? AND state <> 'superseded'").get(ticket.id, saidAt));
    if (!REWORKABLE.includes(stage) || newer) {
      updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "moved_on", true);
      return setMessageControl(ctx, cardId, { ...control, offer: [], result: newer
        ? (en ? "A newer version was handed over after your line, so nothing was sent back; say it again if it is still wrong." : "这句话之后又交了新的一版，没有转回；新版还有问题就再说一次。")
        : (en ? "It is no longer handed over or approved, so there was nothing to send back." : "它已经不在交付或通过的状态，没有可转回的。") });
    }
    const partKeys = control.part_keys;
    const plan = ctx.db.query<{ session_id: string | null; stage: string | null; status: string }, [string]>(
      "SELECT session_id, stage, status FROM tasks WHERE id = ?").get(ticket.task_id)!;
    const planStage = plan.stage ?? (plan.status === "done" ? "delivered" : "active");
    const parts = partKeys.length > 0
      ? ctx.db.query<{ key: string; stage: string }, [string]>("SELECT key, stage FROM ticket_parts WHERE ticket_id = ? ORDER BY key").all(ticket.id)
        .filter((part) => partKeys.includes(part.key))
      : [];
    const open = ctx.db.query<SubmissionRow, [string, string]>("SELECT * FROM submissions WHERE ticket_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid")
      .all(ticket.id, JSON.stringify(OPEN_STATES)).map(toSubmission);
    const before: ReworkBefore = { ticket_stage: stage, parts, plan_stage: planStage, submissions: open.map((submission) => ({ id: submission.id, state: submission.state })) };
    // A hand-over still waiting is no longer what counts: your complaint is.
    for (const submission of open) {
      ctx.db.run("UPDATE submissions SET state = 'superseded', awaiting = NULL, updated_at = ? WHERE id = ?", [now, submission.id]);
      if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "superseded", by: "complaint" });
    }
    // The reviews that let the current hand-over through missed what you found.
    const said = ctx.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(control.message_id)?.body ?? "";
    const excerpt = truncate(said.replace(/\s+/g, " ").trim(), COMPLAINT_EXCERPT_MAX);
    const approved = ctx.db.query<SubmissionRow, [string]>("SELECT * FROM submissions WHERE ticket_id = ? AND state = 'approved' ORDER BY created_at DESC, rowid DESC")
      .all(ticket.id).map(toSubmission)
      .find((submission) => partKeys.length === 0 || submission.part_keys.length === 0 || submission.part_keys.some((key) => partKeys.includes(key)));
    const misses: string[] = [];
    for (const review of approved?.reviews ?? []) {
      if (review.outcome !== "approve") continue;
      const missed = ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'review.miss' AND json_extract(payload, '$.submission_id') = ?
        AND json_extract(payload, '$.reviewer_bot_id') = ? AND json_extract(payload, '$.undone') IS NULL`).get(approved!.id, review.reviewer_bot_id);
      if (missed) continue;
      recordWorkEvent(ctx, { kind: "review.miss", actor: USER_MEMBER, botId: review.reviewer_bot_id, taskId: ticket.task_id, ticketId: ticket.id,
        payload: { submission_id: approved!.id, reviewer_bot_id: review.reviewer_bot_id, reviewer_model: review.reviewer_model, same_model: review.same_model,
          message_id: control.message_id, card_id: cardId, quote: excerpt, reviewed_at: review.at } });
      misses.push(review.reviewer_bot_id);
    }
    for (const part of parts) {
      if (part.stage === "rework" || part.stage === "waived") continue;
      ctx.db.run("UPDATE ticket_parts SET stage = 'rework' WHERE ticket_id = ? AND key = ?", [ticket.id, part.key]);
      recordWorkEvent(ctx, { kind: "part.stage_changed", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
        payload: { part: part.key, before: part.stage, after: "rework", message_id: control.message_id } });
    }
    setTicketStage(ctx, { ticketId: ticket.id, stage: "rework", source: "user", now });
    if (planStage === "delivered") reopenPlan(ctx, ticket.task_id, now);
    // Its producer hears it and goes back to work on it.
    const producer = ticket.owner_bot_id ?? ticket.worker;
    let producerInbox: number | null = null;
    if (producer && plan.session_id && ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(producer)) {
      const what = partKeys.length > 0 ? (en ? ` (${partKeys.join(", ")})` : `（${partKeys.join("、")}）`) : "";
      producerInbox = queueWork(ctx, { botId: producer, sessionId: plan.session_id, taskId: ticket.task_id, ticketId: ticket.id, messageId: null, author: "app",
        body: en ? `(app) The user sent ticket "${ticket.title}"${what} back to rework, saying: "${excerpt}". Fix that and hand it over again.`
          : `（应用）用户把任务「${ticket.title}」${what}转回返工了，用户说：「${excerpt}」。按这个改好再交。`,
        source: "review", kind: "change", priority: 2, notice: false }).inbox.seq;
      refreshHeldInbox(ctx, { botId: producer });
    }
    recordWorkEvent(ctx, { kind: "complaint.rework", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
      payload: { message_id: control.message_id, card_id: cardId, parts: partKeys, before, misses, superseded: open.map((submission) => submission.id),
        producer: producer ?? null, producer_inbox: producerInbox } });
    updateNotificationActionState(ctx, `rework:${cardId}`, "resolved", "rework", true);
    return setMessageControl(ctx, cardId, { ...control, offer: ["undo"], result: en ? "Sent back to rework." : "已转回返工。" });
  });
}

function undoRework(ctx: StoreContext, cardId: string, control: Extract<Message["control"], { kind: "rework" }>, now: string): Message {
  const event = ctx.db.query<{ at: string; payload: string }, [string]>(`SELECT at, payload FROM work_events WHERE kind = 'complaint.rework'
    AND json_extract(payload, '$.card_id') = ? ORDER BY rowid DESC LIMIT 1`).get(cardId);
  if (!event) throw new HttpError(409, "conflict", "there is nothing left to undo");
  const payload = JSON.parse(event.payload) as { message_id: string; before: ReworkBefore; superseded: string[]; producer?: string | null; producer_inbox?: number | null };
  const newer = ctx.db.query("SELECT 1 FROM submissions WHERE ticket_id = ? AND created_at > ? AND id NOT IN (SELECT value FROM json_each(?))")
    .get(control.ticket_id, event.at, JSON.stringify(payload.superseded));
  if (newer || ticketStage(stagedTicket(ctx, control.ticket_id)) !== "rework") {
    throw new HttpError(409, "moved_on", "the work has moved on since: there is a newer hand-over, or the ticket is no longer in rework");
  }
  const before = payload.before;
  for (const submission of before.submissions) {
    ctx.db.run("UPDATE submissions SET state = ?, awaiting = NULL, updated_at = ? WHERE id = ? AND state = 'superseded'", [submission.state, now, submission.id]);
  }
  for (const part of before.parts) {
    ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ? AND stage = 'rework'", [part.stage, control.ticket_id, part.key]);
  }
  setTicketStage(ctx, { ticketId: control.ticket_id, stage: before.ticket_stage, source: "user", now });
  if (before.plan_stage === "delivered") settlePlanStage(ctx, control.task_id, now);
  ctx.db.run(`UPDATE work_events SET payload = json_set(payload, '$.undone', ?) WHERE kind = 'review.miss'
    AND json_extract(payload, '$.card_id') = ? AND json_extract(payload, '$.undone') IS NULL`, [now, cardId]);
  // The producer's call to rework: dropped if it has not read it yet, else told it is taken back.
  if (payload.producer && payload.producer_inbox !== null && payload.producer_inbox !== undefined) {
    const item = ctx.db.query<{ state: string; work_item_id: string | null; session_id: string | null }, [number]>(
      "SELECT state, work_item_id, session_id FROM inbox_items WHERE seq = ?").get(payload.producer_inbox);
    if (item && (item.state === "queued" || item.state === "held")) {
      ctx.db.run("UPDATE inbox_items SET state = 'superseded', disposition_note = 'the user undid the rework', disposed_at = ? WHERE seq = ?", [now, payload.producer_inbox]);
    } else if (item?.work_item_id && item.session_id) {
      const title = stagedTicket(ctx, control.ticket_id).title;
      queueInboxItem(ctx, { botId: payload.producer, sessionId: item.session_id, turnId: null, workItemId: item.work_item_id, taskId: control.task_id,
        ticketId: control.ticket_id, messageId: null, author: "app", source: "review", kind: "info", priority: 2, wakes: false, now,
        body: locale(ctx) === "en" ? `(app) The user took back the rework of "${title}": it stands as before, nothing to change.`
          : `（应用）用户撤销了任务「${title}」的返工：照旧算数，不用改了。` });
    }
    refreshHeldInbox(ctx, { botId: payload.producer });
  }
  recordWorkEvent(ctx, { kind: "complaint.rework_undone", actor: USER_MEMBER, taskId: control.task_id, ticketId: control.ticket_id,
    payload: { message_id: payload.message_id, card_id: cardId } });
  const { result: _done, ...rest } = control;
  return setMessageControl(ctx, cardId, { ...rest, acted: ["undo"] });
}

/**
 * A reviewer's calibration record (§6.5 4): the approvals of its that you overturned in this plan's
 * conversation, newest first, each with what you said — read in its situation from then on. Empty
 * below level 5.
 */
export function reviewMisses(ctx: StoreContext, input: { botId: string; sessionId: string; limit?: number }): Array<{ ticket: string; quote: string; at: string; same_model: boolean }> {
  if (!supervised(ctx)) return [];
  return ctx.db.query<{ payload: string; at: string; title: string }, [string, string, number]>(`SELECT e.payload, e.at, k.title FROM work_events e
    JOIN tickets k ON k.id = e.ticket_id JOIN tasks t ON t.id = e.task_id
    WHERE e.kind = 'review.miss' AND e.bot_id = ? AND t.session_id = ? AND json_extract(e.payload, '$.undone') IS NULL
    ORDER BY e.at DESC, e.rowid DESC LIMIT ?`).all(input.botId, input.sessionId, input.limit ?? 5)
    .map((row) => {
      const payload = JSON.parse(row.payload) as { quote?: string; same_model?: boolean };
      return { ticket: row.title, quote: payload.quote ?? "", at: row.at, same_model: Boolean(payload.same_model) };
    });
}


/** The capability ceiling (§6.6): this many hand-overs in a row failing the same requirement… */
export const CEILING_STREAK = 3;
/** …or more hand-overs than this since you last answered about it. */
export const CEILING_ATTEMPTS = 6;

export type CeilingAction = "another_way" | "another_plan" | "relax" | "accept";
const CEILING_ACTIONS: readonly CeilingAction[] = ["another_way", "another_plan", "relax", "accept"];

/** An open ceiling card on a ticket: about one of `partKeys`, or the ticket itself. Null when none waits. */
function openCeiling(ctx: StoreContext, ticketId: string, partKeys: readonly string[]): { id: string; part_key: string | null } | null {
  const rows = ctx.db.query<{ id: string; part_key: string | null }, [string]>(`SELECT id, json_extract(control, '$.part_key') AS part_key FROM messages
    WHERE json_extract(control, '$.kind') = 'ceiling' AND json_extract(control, '$.ticket_id') = ?
      AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0 AND json_array_length(json_extract(control, '$.offer')) > 0
    ORDER BY created_at, rowid`).all(ticketId);
  // A hand-over of no part would let the ticket through around a stuck part: any open card holds it.
  if (partKeys.length === 0) return rows[0] ?? null;
  return rows.find((row) => row.part_key === null || partKeys.includes(row.part_key)) ?? null;
}

/** An open ceiling card on a ticket, about any of it: the ball is yours while it waits. */
export function ceilingCardOf(ctx: StoreContext, ticketId: string): string | null {
  return ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'ceiling'
    AND json_extract(control, '$.ticket_id') = ? AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0
    AND json_array_length(json_extract(control, '$.offer')) > 0 ORDER BY created_at, rowid LIMIT 1`).get(ticketId)?.id ?? null;
}

/** Since when a unit's hand-overs count towards the ceiling: your last answer about it. */
function ceilingSince(ctx: StoreContext, ticketId: string, partKey: string | null): string {
  return ctx.db.query<{ at: string }, [string, string]>(`SELECT at FROM work_events WHERE kind = 'ceiling.answered' AND ticket_id = ?
    AND IFNULL(json_extract(payload, '$.part_key'), '') = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(ticketId, partKey ?? "")?.at ?? "";
}

/** The requirement of yours a check stands on, when it was read from your words; else null. */
function requirementOfCheck(ctx: StoreContext, checkId: string): { id: string; quote: string } | null {
  return ctx.db.query<{ id: string; quote: string }, [string]>(`SELECT r.id, r.quote FROM acceptance_checks c
    JOIN requirements r ON r.status = 'open' AND (r.source_quote_id = c.quote_id
      OR r.id IN (SELECT requirement_id FROM requirement_mentions WHERE quote_id = c.quote_id))
    WHERE c.id = ? AND c.quote_id IS NOT NULL ORDER BY r.created_at LIMIT 1`).get(checkId) ?? null;
}

/** What a decided hand-over failed, keyed by the requirement it is about (a check on none: `check:<id>`), each with a label for the card. */
function failureKeys(ctx: StoreContext, submission: Submission): Map<string, string> {
  const keys = new Map<string, string>();
  for (const check of submission.checks) {
    if (!gateFailed(check) || check.outcome === "not_run") continue;
    const requirement = requirementOfCheck(ctx, check.check_id);
    keys.set(requirement ? requirement.id : `check:${check.check_id}`, requirement ? requirement.quote : check.item);
  }
  for (const review of submission.reviews) {
    if (review.outcome !== "reject") continue;
    for (const verdict of review.verdicts) {
      if (verdict.verdict !== "fail") continue;
      const quote = ctx.db.query<{ quote: string }, [string]>("SELECT quote FROM requirements WHERE id = ?").get(verdict.requirement_id)?.quote;
      if (quote !== undefined) keys.set(verdict.requirement_id, quote);
    }
  }
  return keys;
}

type CeilingHit = { reason: "streak"; key: string; label: string; times: number } | { reason: "attempts"; times: number };
/** After a failure: the units (part keys; null for the whole ticket) now stuck at the ceiling, and whether that is every unit it covered. */
type CeilingOutcome = { cards: Message[]; stuck: Array<string | null>; all: boolean };
const NO_CEILING: CeilingOutcome = { cards: [], stuck: [], all: false };

/**
 * After a hand-over failed (its checks, a review, or your send-back): each of its parts — else its
 * ticket — that has now failed the same requirement on {@link CEILING_STREAK} hand-overs in a row, or
 * been handed over more than {@link CEILING_ATTEMPTS} times, since your last answer about it, hits the
 * capability ceiling (§6.6): a part is blocked, nothing more is handed over for it, the ball is yours,
 * and a card asks how to go on. Once per unit while its card waits.
 */
function checkCeiling(ctx: StoreContext, submission: Submission, now: string): CeilingOutcome {
  const cards: Message[] = [];
  const stuck: Array<string | null> = [];
  const units: Array<string | null> = submission.part_keys.length > 0 ? submission.part_keys : [null];
  for (const partKey of units) {
    if (unitStuck(ctx, submission.ticket_id, partKey)) {
      stuck.push(partKey);
      continue;
    }
    const since = ceilingSince(ctx, submission.ticket_id, partKey);
    // A part counts the hand-overs of it; the whole ticket counts only those of no part.
    const covering = ctx.db.query<SubmissionRow, [string, string]>(`SELECT * FROM submissions WHERE ticket_id = ? AND created_at > ?
      AND state <> 'superseded' ORDER BY created_at DESC, rowid DESC`).all(submission.ticket_id, since).map(toSubmission)
      .filter((row) => partKey === null ? row.part_keys.length === 0 : row.part_keys.includes(partKey));
    const decided = covering.filter((row) => row.state === "checks_failed" || row.state === "rejected" || row.state === "approved");
    let hit: CeilingHit | null = null;
    for (const [key, label] of decided[0] ? failureKeys(ctx, decided[0]) : new Map<string, string>()) {
      let times = 0;
      for (const row of decided) {
        if (!failureKeys(ctx, row).has(key)) break;
        times += 1;
      }
      if (times >= CEILING_STREAK) {
        hit = { reason: "streak", key, label, times };
        break;
      }
    }
    const failures = decided.filter((row) => row.state !== "approved").length;
    if (!hit && failures > CEILING_ATTEMPTS) hit = { reason: "attempts", times: failures };
    if (!hit) continue;
    stuck.push(partKey);
    if (partKey) {
      const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(submission.ticket_id, partKey);
      if (part && part.stage !== "blocked") {
        ctx.db.run("UPDATE ticket_parts SET stage = 'blocked' WHERE ticket_id = ? AND key = ?", [submission.ticket_id, partKey]);
        recordWorkEvent(ctx, { kind: "part.stage_changed", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
          payload: { part: partKey, before: part.stage, after: "blocked", submission_id: submission.id } });
      }
    }
    const card = ceilingCard(ctx, submission, partKey, hit);
    if (card) cards.push(card);
    recordWorkEvent(ctx, { kind: "ceiling.reached", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { part_key: partKey, submission_id: submission.id, card_id: card?.id ?? null, at: now, ...hit } });
  }
  return { cards, stuck, all: stuck.length === units.length };
}

/** Whether a unit already waits on an open ceiling card: its own, or (for a part) the whole ticket's. */
function unitStuck(ctx: StoreContext, ticketId: string, partKey: string | null): boolean {
  return ctx.db.query<{ part_key: string | null }, [string]>(`SELECT json_extract(control, '$.part_key') AS part_key FROM messages
    WHERE json_extract(control, '$.kind') = 'ceiling' AND json_extract(control, '$.ticket_id') = ?
      AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0 AND json_array_length(json_extract(control, '$.offer')) > 0`)
    .all(ticketId).some((row) => row.part_key === null || row.part_key === partKey);
}

/**
 * The ceiling cards still asking about a ticket stop asking: it closed another way (approved, or
 * your board edit). Each says why.
 */
function closeCeilingCards(ctx: StoreContext, ticketId: string, why: string): void {
  const open = ctx.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'ceiling'
    AND json_extract(control, '$.ticket_id') = ? AND json_array_length(COALESCE(json_extract(control, '$.acted'), '[]')) = 0
    AND json_array_length(json_extract(control, '$.offer')) > 0`).all(ticketId);
  for (const row of open) {
    const control = getMessage(ctx, row.id).control;
    if (control?.kind !== "ceiling") continue;
    setMessageControl(ctx, row.id, { ...control, offer: [], result: why });
    updateNotificationActionState(ctx, `ceiling:${row.id}`, "resolved", "closed", true);
  }
}

function ceilingCard(ctx: StoreContext, submission: Submission, partKey: string | null, hit: CeilingHit): Message | null {
  const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(submission.task_id);
  if (!plan?.session_id) return null;
  const ticket = stagedTicket(ctx, submission.ticket_id);
  const en = locale(ctx) === "en";
  const number = String(ticket.seq).padStart(2, "0");
  const unit = partKey ? (en ? ` part ${partKey}` : `分件 ${partKey} `) : "";
  const why = hit.reason === "streak"
    ? (en ? `"${hit.label}" failed ${hit.times} hand-overs in a row` : `「${hit.label}」连续 ${hit.times} 次没过`)
    : (en ? `${hit.times} hand-overs failed` : `已经交了 ${hit.times} 次都没过`);
  const requirementId = hit.reason === "streak" && !hit.key.startsWith("check:") ? hit.key : null;
  const message = insertMessage(ctx, {
    sessionId: plan.session_id, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
    body: en
      ? `Ticket ${number} "${ticket.title}"${unit} of ${plan.title} is stuck: ${why}. Trying again the same way is unlikely to help — how should it go on?`
      : `${plan.title} 的任务 ${number}「${ticket.title}」${unit}卡住了：${why}，照原样再试多半还是不过。要怎么办？`,
    control: { kind: "ceiling", task_id: submission.task_id, ticket_id: submission.ticket_id, part_key: partKey, requirement_id: requirementId,
      offer: ["another_way", "another_plan", ...(requirementId ? ["relax" as const] : []), "accept"] },
  });
  createNotification(ctx, { semantic_key: `ceiling:${message.id}`, kind: "ask", session_id: plan.session_id, message_id: message.id, action_state: "open" });
  return message;
}

/**
 * Your answer on a ceiling card (§6.6). Another way or another plan: the unit goes back to rework,
 * its producer is told which, and its count starts over. Relax: the requirement no longer holds for
 * this plan (waived — your press is the confirmation), then the same. Accept: the part is approved
 * as it is; a ticket whose every part is then approved or waived (or that has none) is approved,
 * and the plan may be delivered.
 */
export function answerCeilingCard(ctx: StoreContext, messageId: string, action: unknown): Message {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "ceiling") throw new HttpError(422, "invalid_args", "this line is not a ceiling card");
    if (!CEILING_ACTIONS.includes(action as CeilingAction)) throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action as CeilingAction)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const chosen = action as CeilingAction;
    const now = isoNow();
    const ticket = stagedTicket(ctx, control.ticket_id);
    const partKey = control.part_key;
    if (chosen === "relax" && control.requirement_id) waiveRequirement(ctx, control.requirement_id, { taskId: control.task_id, action: messageId, now });
    const accepted = chosen === "accept";
    if (partKey) {
      const stage = accepted ? "approved" : "rework";
      const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(ticket.id, partKey);
      if (part && part.stage !== stage) {
        ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ?", [stage, ticket.id, partKey]);
        recordWorkEvent(ctx, { kind: "part.stage_changed", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
          payload: { part: partKey, before: part.stage, after: stage, message_id: messageId } });
      }
    }
    if (accepted && ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_parts WHERE ticket_id = ? AND stage NOT IN ('approved', 'waived')").get(ticket.id)!.n === 0) {
      setTicketStage(ctx, { ticketId: ticket.id, stage: "approved", source: "user", now });
      settlePlanStage(ctx, ticket.task_id, now);
    }
    recordWorkEvent(ctx, { kind: "ceiling.answered", actor: USER_MEMBER, taskId: ticket.task_id, ticketId: ticket.id,
      payload: { part_key: partKey, action: chosen, requirement_id: control.requirement_id, card_id: messageId } });
    const producer = ticket.owner_bot_id ?? ticket.worker;
    const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(ticket.task_id);
    if (producer && plan?.session_id && ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(producer)) {
      const en = locale(ctx) === "en";
      const unit = partKey ? (en ? ` (part ${partKey})` : `（分件 ${partKey}）`) : "";
      const said: Record<CeilingAction, string> = en
        ? { another_way: "do it another way — a different method or tool, not the same attempt again", another_plan: "change the plan to get around the problem",
          relax: "that requirement no longer holds for this plan", accept: "accept it as it is" }
        : { another_way: "换一种做法——换方法或工具，别再照原样试", another_plan: "改方案，绕开这个问题", relax: "那条要求在这件事里不再要了", accept: "就用现在的" };
      const body = en
        ? `(app) On the ceiling card for ticket "${ticket.title}"${unit} the user chose: ${said[chosen]}.${accepted ? "" : " Go on from there and hand it over again."}`
        : `（应用）任务「${ticket.title}」${unit}的天花板卡片上，用户选了：${said[chosen]}。${accepted ? "" : "照这个方向做完再交。"}`;
      if (accepted) {
        const work = ctx.db.query<{ id: string }, [string, string, string]>(`SELECT id FROM work_items WHERE bot_id = ? AND task_id = ? AND ticket_id = ?
          AND state <> 'closed' ORDER BY created_at LIMIT 1`).get(producer, ticket.task_id, ticket.id);
        if (work) queueInboxItem(ctx, { botId: producer, sessionId: plan.session_id, turnId: null, workItemId: work.id, taskId: ticket.task_id, ticketId: ticket.id,
          messageId: null, author: "app", body, source: "review", kind: "result", priority: 2, wakes: false, now });
      } else {
        queueWork(ctx, { botId: producer, sessionId: plan.session_id, taskId: ticket.task_id, ticketId: ticket.id, messageId: null, author: "app",
          body, source: "review", kind: "result", priority: 2, notice: false });
      }
      refreshHeldInbox(ctx, { botId: producer });
    }
    updateNotificationActionState(ctx, `ceiling:${messageId}`, "resolved", chosen, true);
    return setMessageControl(ctx, messageId, { ...control, acted: [chosen] });
  });
}

/** What a day of judging pictures may cost before the app stops asking (§6.5 3), in US dollars. */
export const VISION_DAILY_CAP_USD = 5;
const TICKS_IN_USD = 10_000_000_000;

/**
 * Why a judgement of pictures for this plan is not made now, from level 5 (§6.5 3): a stop of yours
 * covers the plan, or today's judging of pictures has already cost {@link VISION_DAILY_CAP_USD}.
 * Null when it may go ahead (and below level 5, where it always does).
 */
export function visionRefusal(ctx: StoreContext, taskId: string, now: Date = new Date()): string | null {
  if (!supervised(ctx)) return null;
  const en = locale(ctx) === "en";
  const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(taskId);
  if (holdsCovering(ctx, { sessionId: plan?.session_id ?? null, taskId }).length > 0) {
    return en ? "not judged while a stop of yours covers this plan" : "这件事被叫停着，没有看图判定";
  }
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const ticks = ctx.db.query<{ ticks: number | null }, [string]>(`SELECT SUM(COALESCE(cost_usd_ticks, estimated_cost_usd_ticks, 0)) AS ticks
    FROM spend WHERE purpose = 'vision' AND created_at >= ?`).get(dayStart)?.ticks ?? 0;
  if (ticks >= VISION_DAILY_CAP_USD * TICKS_IN_USD) {
    return en ? `today's judging of pictures has reached its $${VISION_DAILY_CAP_USD} cap; not judged this time`
      : `今天看图判定的花费已到 $${VISION_DAILY_CAP_USD} 的上限，这次没判`;
  }
  return null;
}

