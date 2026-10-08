/** A hand-over's stored record, how it is read back, and the small facts every step asks of it. */
import { HttpError } from "../errors";
import { derivedNotGate } from "./acceptance-checks";
import { spokenFor } from "./job-conversations";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { jsonColumnOr, requireNonEmpty, type StoreContext } from "./shared";
import { isReservedTaskPath } from "./tasks";
import { recordWorkEvent } from "./work-events";

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
export function backs(check: SubmissionCheck): boolean {
  return check.gate && check.yours === true && check.outcome === "pass";
}
export type ReviewVerdict = { requirement_id: string; verdict: "pass" | "fail" | "unknown" | "n/a"; evidence: string[] };
export type ReviewRecord = {
  reviewer_bot_id: string; reviewer_model: string | null; same_model: boolean; turn_id: string;
  verdicts: ReviewVerdict[]; outcome: "approve" | "reject"; note: string | null; at: string;
};
export type SubmissionClaim = { requirement_id: string; claim: string; evidence: string };
/**
 * An approval waiting on you: the required items nothing backs, the card that asks you, and the
 * review it would complete (null when there is no reviewer). `kind` tells the cards apart:
 * `approval` asks you to approve or send back the hand-over — one nothing you confirmed backs (an
 * `answer` or `organizer` submission is never approved on its own say), or one with the required
 * items in `requirement_ids` on nothing, which 放行 takes as met. A later tick never turns it into an
 * approval by itself, unless the listed items were all it waited on and they are met some other way.
 * `items` (the default, omitted on older rows) is the required-items card written until 2026-10-07.
 */
export type AwaitingYou = {
  requirement_ids: string[]; check_ids: string[]; message_id: string | null; review: ReviewRecord | null; at: string; kind?: "items" | "approval";
  /** An approval card whose 放行 you already pressed, waiting on a gate that had not run yet: resolves once every gate has, never asks again. */
  pending?: boolean;
  /**
   * Its card was taken down: you said more on the job after it was handed over and its Bot went to
   * work on that. Once that work is done with nothing newer handed over, it is put to you again.
   */
  held?: boolean;
};

export type Submission = {
  id: string; work_item_id: string | null; task_id: string; ticket_id: string; part_keys: string[]; bot_id: string;
  model: string | null; turn_id: string | null; origin: SubmissionOrigin; artifacts: SubmissionArtifact[];
  /** The words handed over, for an `answer`: a ticket whose work is an answer, not a file. */
  content: string | null;
  claims: SubmissionClaim[]; note: string | null; state: SubmissionState; checks: SubmissionCheck[];
  reviews: ReviewRecord[]; awaiting: AwaitingYou | null; created_at: string; updated_at: string;
};

export type SubmissionRow = Omit<Submission, "part_keys" | "artifacts" | "claims" | "checks" | "reviews" | "awaiting"> & {
  part_keys: string; artifacts: string; claims: string; checks: string; reviews: string; awaiting: string | null;
};

/** What a review must judge, and why (§6.5 2, ADR 0046): what you raised twice or more, what is about the picture. */
export type RequiredItem = { requirement_id: string; quote: string; reasons: Array<"raised" | "visual">; times_raised: number };
/** Undecided submissions, which a newer one of the same ticket (or your board edit) supersedes; one that failed its checks stays that. */
export const OPEN_STATES: readonly SubmissionState[] = ["checking", "submitted", "in_review"];
/**
 * Origins with no Bot that actually produced them: an organizer's reading, or a ticket's answer.
 * With no reviewer, neither is ever approved on its checks alone — the ball comes to you on a card,
 * even with nothing required (ADR 0046, where §6.5 and §5.3.7 would have the no-reviewer path
 * approve once checks and required items clear).
 */
export const ORIGIN_NEEDS_USER: readonly SubmissionOrigin[] = ["answer", "organizer"];
/** How much of an answer's text a card shows before truncating it; the submission keeps the rest. */
const ANSWER_EXCERPT_MAX = 400;

/** An answer's text, truncated for a line or a card; the submission itself keeps the full text. */
export function truncatedAnswer(content: string): string {
  const points = [...content];
  return points.length > ANSWER_EXCERPT_MAX ? `${points.slice(0, ANSWER_EXCERPT_MAX).join("")}……` : content;
}

export function toSubmission(row: SubmissionRow): Submission {
  return {
    ...row,
    part_keys: jsonColumnOr<string[]>(row.part_keys, []),
    artifacts: jsonColumnOr<SubmissionArtifact[]>(row.artifacts, []),
    claims: jsonColumnOr<SubmissionClaim[]>(row.claims, []),
    checks: jsonColumnOr<SubmissionCheck[]>(row.checks, []),
    reviews: jsonColumnOr<ReviewRecord[]>(row.reviews, []),
    awaiting: jsonColumnOr<AwaitingYou | null>(row.awaiting, null),
  };
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
export function segmentModel(ctx: StoreContext, turnId: string): string | null {
  return ctx.db.query<{ model: string }, [string]>("SELECT model FROM turn_route_decisions WHERE turn_id = ?").get(turnId)?.model ?? null;
}

export function supervised(ctx: StoreContext): boolean {
  return readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions;
}

export function setPartStage(ctx: StoreContext, submission: Submission, stage: "submitted" | "approved" | "rework"): void {
  for (const key of submission.part_keys) {
    const part = ctx.db.query<{ stage: string }, [string, string]>("SELECT stage FROM ticket_parts WHERE ticket_id = ? AND key = ?").get(submission.ticket_id, key);
    if (!part || part.stage === stage || part.stage === "waived" || part.stage === "blocked") continue;
    ctx.db.run("UPDATE ticket_parts SET stage = ? WHERE ticket_id = ? AND key = ?", [stage, submission.ticket_id, key]);
    recordWorkEvent(ctx, { kind: "part.stage_changed", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { work_item_id: submission.work_item_id, part: key, before: part.stage, after: stage, submission_id: submission.id } });
  }
}

/** Whether `path` is a plain workspace-relative path: no empty, `.` or `..` part, no backslash. */
export function plainPath(path: string): boolean {
  return Boolean(path) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** Whether `path` is a file of the ticket folder `dir` a submission may hand over. */
export function inTicketDir(dir: string, path: string): boolean {
  return path.startsWith(`${dir}/`) && plainPath(path) && !isReservedTaskPath(dir, path);
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
    const check = ctx.db.query<{ id: string; item: string; origin: string | null; bind_kind: string | null; derived_state: string | null; source: string; standard_of: string | null }, [string]>(
      "SELECT id, item, origin, bind_kind, derived_state, source, standard_of FROM acceptance_checks WHERE id = ? AND removed_at IS NULL").get(id);
    if (!check) return [];
    const run = ctx.db.query<{ outcome: string | null; detail: string; judged_by: string | null }, [string, string]>(`SELECT outcome, detail, judged_by
      FROM acceptance_check_runs WHERE check_id = ? AND finished_at IS NOT NULL AND started_at >= ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(id, since);
    const vision = run?.judged_by === "vision" && supervised(ctx);
    // A standard check (ADR 0060) is a gate once it judged: a pass or a fail. One it could not make
    // (nothing to compare yet, no model, your stop, the picture budget) holds nothing back.
    const unjudged = check.standard_of !== null && run !== null && run.outcome !== "pass" && run.outcome !== "fail";
    const gate = !derivedNotGate(check) && !vision && !unjudged;
    // A check a reflection proposed is a gate but not yours (ADR 0051): adopting a card is not writing it.
    return [{ check_id: id, item: check.item, gate, yours: gate && (check.origin === "derived" || (check.source === "user" && check.origin !== "reflection")),
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

/** Whether a submission's producer is a Bot (the organizer's reading of a ticket nobody owns has none). */
export function producerIsBot(ctx: StoreContext, submission: Pick<Submission, "bot_id">): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(submission.bot_id));
}

/**
 * Your direct with this Bot, when that is where you answered a card about its work: it goes on with
 * the rework there, beside your words. Sent back from your direct with 文案, the slogans were redone
 * in the group the job began in, and the new version landed there (2026-10-04, real-model run).
 */
export function yourDirectWith(ctx: StoreContext, sessionId: string | null | undefined, botId: string): string | null {
  if (!sessionId) return null;
  return ctx.db.query(`SELECT 1 FROM sessions s WHERE s.id = ?1 AND s.kind = 'direct' AND s.archived_at IS NULL
    AND EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.member = ?2 AND p.left_at IS NULL)
    AND EXISTS (SELECT 1 FROM session_participants u WHERE u.session_id = s.id AND u.member = 'user' AND u.left_at IS NULL)`)
    .get(sessionId, botId) ? sessionId : null;
}

export function producerSession(ctx: StoreContext, submission: Submission): string | null {
  const work = submission.work_item_id
    ? ctx.db.query<{ home_session_id: string; thread_session_id: string | null }, [string]>("SELECT home_session_id, thread_session_id FROM work_items WHERE id = ?")
      .get(submission.work_item_id)
    : null;
  return work ? work.thread_session_id ?? work.home_session_id
    : ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(submission.task_id)?.session_id ?? null;
}

/**
 * Where a card about a hand-over goes: where you last spoke about its job — a group, or your direct
 * with the Bot that made it — else the job's home (see `spokenFor`).
 */
export function cardPlace(ctx: StoreContext, submission: Pick<Submission, "task_id" | "bot_id">, home: string): string {
  return spokenFor(ctx, submission.task_id, submission.bot_id)[0] ?? home;
}

/** The files a hand-over's card names in its words; the card shows the files themselves beside them. */
export function fileNames(submission: Pick<Submission, "artifacts">, en: boolean): string {
  return submission.artifacts.map((artifact) => artifact.path.split("/").pop() ?? artifact.path).join(en ? ", " : "、");
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
