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
 * on it or your word: then the ball comes to you, on the hand-over's one 放行/退回 card — never back
 * to the producer to chase a number you have not confirmed.
 *
 * The store side is synchronous: preparing a submission, reading what its checks said, judging a
 * review, the supervisor's part. Hashing files, running checks and waking Bots is the engine's
 * (`engine/submissions.ts`).
 */
import { CONTROL_NOTE_MAX, USER_MEMBER, type Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, isoPlus, ulid } from "../ids";
import { ceilingCardOf, checkCeiling, closeCeilingCards, NO_CEILING, openCeiling, type CeilingOutcome } from "./ceiling";
import { deliverDelegations } from "./delegations";
import { confirmDerivedCheck } from "./derived-checks";
import { noteHandOverFailed, resetEscalation } from "./escalation";
import { holdsCovering } from "./holds";
import { queueInboxItem, refreshHeldInbox } from "./inbox";
import { largeJobRefusal, sampleOf, syncStandardChecks, yoursToApprove } from "./large-jobs";
import { getMessage, setMessageControl } from "./messages";
import { updateNotificationActionState } from "./notifications";
import { learningOn } from "./quality";
import { recordQuote } from "./quotes";
import { setRequirementHere, waiveRequirement } from "./requirements";
import { askApproval, letGoOfCard, markApprovalCard, REVIEW_CARD_ACTIONS, type ReviewCardAction } from "./review-cards";
import { localeOf } from "./settings";
import { LIVE_TURN_STATUSES, requireNonEmpty, type StoreContext } from "./shared";
import { cleanVerdicts, framesRead, needsYourApproval, requiredItems, unbackedItems } from "./submission-evidence";
import { backs, boundCheckIds, checkLines, checkResults, gateFailed, getSubmission, implicitSubmissionPaths, inTicketDir, listSubmissions, OPEN_STATES, ORIGIN_NEEDS_USER, plainPath, producerIsBot, producerSession, segmentModel, setPartStage, supervised, toSubmission, truncatedAnswer, yourDirectWith, type ReviewRecord, type Submission, type SubmissionArtifact, type SubmissionCheck, type SubmissionClaim, type SubmissionRow, type SubmissionState } from "./submission-rows";
import { isReservedTaskPath } from "./tasks";
import { setTicketStage, settlePlanStage, STAGE_SQL, stagedTicket, ticketStage, type StagedTicketRow, type TicketStage } from "./ticket-stage";
import { recordWorkEvent } from "./work-events";
import { hasWorkAuthority, queueWork } from "./work-items";
import { bindToOwnTicket } from "./work-on";

/** The workspace folder every plan may hand over from, besides a ticket's own (§2.8 `submit`). */
export const SHARED_ASSETS_DIR = "assets";
/** At most this many files in one submission. */
export const SUBMISSION_ARTIFACTS_MAX = 50;
const CLAIMS_MAX = 50;
const CLAIM_TEXT_MAX = 1000;
/** How long a checked submission with no reviewer waits before the supervisor takes it on: one tick (§5.3.7). */
export const UNREVIEWED_AFTER_MS = 15_000;

/**
 * The parts a submission is about: those the Bot names. A hand-over that names none is the
 * ticket's as a whole; a file's name never makes it a part's (ADR 0057).
 */
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
    return localeOf(ctx) === "en"
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
    return localeOf(ctx) === "en"
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
    const segment = () => ctx.db.query<SegmentRow, [string]>("SELECT id, bot_id, status, work_item_id, task_id, ticket_id FROM turns WHERE id = ?")
      .get(requireNonEmpty("turnId", input.turnId));
    let turn = segment();
    if (!turn) throw new HttpError(404, "not_found", "turn not found");
    // Handing in files that all sit in one of its own tickets' folders puts a segment on the whole job
    // onto that ticket, as writing there does — whatever wrote them. On 2026-10-04's real-model run the
    // lead's poster came from a command you approved, which did not put it on its ticket; submit asked
    // it to bind first, its work_on went wrong, and it gave up with the poster made.
    if (input.origin === "submit" && turn.task_id && !turn.ticket_id && input.artifacts.length > 0
      && bindToOwnTicket(ctx, { turnId: turn.id, paths: input.artifacts.map((artifact) => artifact.path), every: true })) turn = segment()!;
    if (!turn.task_id || !turn.ticket_id || !turn.work_item_id) {
      throw new HttpError(422, "invalid_args", "a submission hands over one ticket's work: bind this segment to the ticket first (work_on with its ticket)");
    }
    // A large job not laid out, or a ticket still waiting (ADR 0060): nothing is handed over yet. Said
    // to a Bot that hands over itself; files or words left at an ending simply stay where they are.
    const refusal = largeJobRefusal(ctx, turn.id);
    if (refusal) {
      if (input.origin === "submit") throw new HttpError(409, refusal.code, refusal.message);
      return null;
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
    // The same files, byte for byte, as the hand-over approved or still open on this ticket: nothing
    // to decide. On 2026-10-04's real-model run, asked for a change after delivery, a Bot wrote the
    // new version into a folder of its own making and handed in the untouched file; the card asked
    // you to approve a change that was not there.
    if (input.origin === "submit") {
      const last = listSubmissions(ctx, { ticketId: turn.ticket_id, limit: 1 })[0];
      const same = last && ["approved", "checking", "submitted", "in_review"].includes(last.state)
        && last.artifacts.length === artifacts.length
        && artifacts.every((artifact) => last.artifacts.some((before) => before.path === artifact.path && before.sha256 === artifact.sha256));
      if (same) {
        throw new HttpError(409, "unchanged", `these files are exactly what hand-over ${last.id} (${last.state}) already has; nothing changed since. `
          + "If you made changes, they are not in these files: hand in the files you changed, in this ticket's folder.");
      }
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
  closeCeilingCards(ctx, ticketId, localeOf(ctx) === "en" ? "You changed the ticket's status on the board, so this no longer asks." : "你在看板上改了这张任务的状态，不再问了。");
  if (superseded.length > 0) {
    const ticket = stagedTicket(ctx, ticketId);
    recordWorkEvent(ctx, { kind: "submission.superseded", actor: USER_MEMBER, taskId: ticket.task_id, ticketId, payload: { submissions: superseded, by: "board" } });
  }
  return superseded;
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
  const en = localeOf(ctx) === "en";
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
  if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "checks_failed", lines: checkLines(checks.filter(gateFailed), localeOf(ctx)) });
  const stage = ticketStage(stagedTicket(ctx, submission.ticket_id));
  const back: TicketStage | null = ["submitted", "in_review", "approved"].includes(stage) ? "rework" : stage === "todo" ? "doing" : null;
  if (back) setTicketStage(ctx, { ticketId: submission.ticket_id, stage: back, source: "submission", botId: submission.bot_id, turnId: submission.turn_id,
    workItemId: submission.work_item_id, submissionId: submission.id, now });
  const failed = getSubmission(ctx, submission.id);
  setPartStage(ctx, failed, "rework");
  // Filed here, whichever way the gate failed — at hand-over, or later on your approval (ADR 0050).
  if (learningOn(ctx)) {
    recordWorkEvent(ctx, { kind: "submission.gates_failed", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      turnId: submission.turn_id, payload: { submission_id: submission.id, failures: checks.filter(gateFailed).map((check) => check.check_id) } });
  }
  const ceiling = checkCeiling(ctx, failed, now);
  noteHandOverFailed(ctx, submission.work_item_id, now);
  if (!tell) return;
  const lines = checkLines(checks.filter(gateFailed), localeOf(ctx));
  tellAfterFailure(ctx, submission, localeOf(ctx) === "en"
    ? { what: `(app) Submission ${submission.id} failed its checks, so the ticket did not move: ${lines.join("; ")}.`, retry: "Fix it and hand it over again." }
    : { what: `（应用）交付 ${submission.id} 没过检查，任务没往前走：${lines.join("；")}。`, retry: "改好再交。" }, ceiling, now);
}

/**
 * The producer hears a failed hand-over (its checks, a review's reject, your send-back) and is woken
 * to fix it — unless every unit it covered is now stuck at the capability ceiling: then it only hears
 * that you are being asked how to go on, and is not woken to try again (the ball is yours).
 */
function tellAfterFailure(ctx: StoreContext, submission: Submission, said: { what: string; retry: string }, ceiling: CeilingOutcome, now: string,
  answeredIn: string | null = null): void {
  if (!producerIsBot(ctx, submission)) return;
  const sessionId = yourDirectWith(ctx, answeredIn, submission.bot_id) ?? producerSession(ctx, submission);
  if (!sessionId) return;
  const en = localeOf(ctx) === "en";
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
 * passes something you raised twice or more that no passing check backs, or when nothing of yours
 * stands behind the hand-over, the approval waits on you instead: one card asks you to 放行 or 退回,
 * listing what it passed on nothing but its word, and the ball is yours (`awaiting_user`).
 * Unconfirmed checks from your words never block.
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
      // A routine's run is approved on a clean review, with nothing put to you (see takeUpAwaiting).
      const routine = routinePlan(ctx, submission.task_id);
      // What you raised twice or more that a pass on the producer's own model leaves on nothing; an
      // organizer's reading or an answer, which nobody made; a hand-over no confirmed check backs,
      // when the reviewer runs on the producer's own model or gave no evidence for anything — one
      // Bot passing another's claim; a large job's sample or last part (ADR 0060). Any of these moves
      // the clean approve to your one 放行/退回 card, its verdict and those items shown there.
      // (Every gate passed by here: a failing or unrun one refused the approval above.)
      const open = sameModel && !routine ? unbackedItems(ctx, { ...submission, checks }, "raised") : [];
      const needed = !routine && needsYourApproval(ctx, submission, checks, record);
      if (open.length > 0 || needed) {
        ctx.db.run("UPDATE submissions SET checks = ?, updated_at = ? WHERE id = ?", [JSON.stringify(checks), now, submission.id]);
        const card = askApproval(ctx, getSubmission(ctx, submission.id), now, record, { items: open, backed: checks.some(backs) });
        recordWorkEvent(ctx, { kind: "review.awaiting_user", actor: turn.bot_id, botId: turn.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
          turnId: turn.id, payload: { submission_id: submission.id, requirement_ids: open.map((item) => item.requirement_id), message_id: card?.id ?? null } });
        const items = open.map((item) => `requirement ${item.requirement_id} 「${item.quote}」 was raised ${item.times_raised} times, and you run on the producer's own model: your pass needs a passing check or the user's word${item.checks.length > 0 ? ` (the app measured: ${checkLines(item.checks, "en").join("; ")})` : ""}`);
        const yours = yoursToApprove(ctx, submission.ticket_id);
        const why = ORIGIN_NEEDS_USER.includes(submission.origin) ? `submission ${submission.id} is a ${submission.origin === "answer" ? "words" : "organizer"} hand-over`
          : yours === "sample" ? `submission ${submission.id} is the job's sample, which sets the standard for the rest`
          : yours === "last" ? `submission ${submission.id} is the large job's last hand-over, which delivers it`
          : `no check the user confirmed backs submission ${submission.id}, and ${sameModel ? "you run on the producer's own model" : "your verdicts carry no evidence"}`;
        return { ok: false, code: "awaiting_user",
          reasons: [...items, ...(needed ? [`${why}: a review's approve moves it to the user's approve/reject card, never straight to approved`] : [])],
          submission: getSubmission(ctx, submission.id), card };
      }
      approve(ctx, submission, record, checks, now, routine ? "routine" : "no_reviewer");
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

/**
 * An approval: by a review (`record`) or, with none, by the app on its checks — `by` says why the app
 * needed nobody for it. The ticket and its parts are approved; the plan may be delivered.
 */
function approve(ctx: StoreContext, submission: Submission, record: ReviewRecord | null, checks: readonly SubmissionCheck[], now: string,
  by: "no_reviewer" | "routine" | "one_go" = "no_reviewer"): void {
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
        same_model: record.same_model, ...(by === "routine" ? { by } : {}) } });
    tellProducer(ctx, approved, record, now);
  } else {
    recordWorkEvent(ctx, { kind: "submission.approved", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
      payload: { submission_id: submission.id, work_item_id: submission.work_item_id, by } });
  }
  if (submission.awaiting?.message_id) letGoOfCard(ctx, submission.awaiting.message_id, { reason: "approved" });
  // The Bot that asked for this work hears it is in, and goes on.
  deliverDelegations(ctx, approved, { ticketApproved: openParts === 0, now });
  if (openParts === 0) closeCeilingCards(ctx, submission.ticket_id, localeOf(ctx) === "en" ? "The ticket was approved, so this no longer asks." : "这张任务已通过，不再问了。");
  // The sample through: the tickets waiting for it are held to it from now on (ADR 0060).
  if (openParts === 0 && sampleOf(ctx, submission.task_id)?.id === submission.ticket_id) syncStandardChecks(ctx, submission.task_id, now);
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
  const en = localeOf(ctx) === "en";
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

/** Whether the plan is a routine's standing plan, whose runs nobody waits on to approve. */
function routinePlan(ctx: StoreContext, taskId: string): boolean {
  return Boolean(ctx.db.query("SELECT 1 FROM tasks WHERE id = ? AND routine_id IS NOT NULL").get(taskId));
}

/**
 * A file hand-over made in one go: on a job with one ticket that has never come to your card or has
 * had a hand-over approved, by the only segment on it since it opened or since its last approved hand-over. You asked, the Bot did it,
 * and it is there where you asked; a card asking you to let it through adds nothing a word from you
 * would not do (2026-10-06: 「根据你的职责，生成图片更新你的头像」 opened, made and handed over an
 * avatar in 31 s, then waited on a 放行 card). A job of several tickets (a large one is laid out in
 * several), one that took more segments or one you were asked about once still comes to your card:
 * the three hand-overs of 《全职猎人》 you sent back with notes each came after four or more segments.
 * Segments that start after the hand-over (your next line while it waits) do not count against it.
 *
 * Once a hand-over of the job is approved, what one segment makes after it goes the same way, card
 * before or not: on 2026-10-07 each follow-up question in a one-ticket job came back as a 放行 card,
 * five in half an hour, all let through, because the job's first hand-over had been carded. A hand-over
 * sent back is still followed by a card: the segment that made it counts against the next one.
 */
function doneInOneGo(ctx: StoreContext, submission: Submission): boolean {
  if (!submission.turn_id || (submission.origin !== "submit" && submission.origin !== "implicit")) return false;
  const job = ctx.db.query<{ tickets: number; asked: number; approved: number; others: number }, [string, string, string]>(`SELECT
      (SELECT COUNT(*) FROM tickets t WHERE t.task_id = ?1 AND ${STAGE_SQL("t")} <> 'dropped') AS tickets,
      (SELECT COUNT(*) FROM messages WHERE json_valid(control) AND json_extract(control, '$.kind') = 'review_item'
        AND json_extract(control, '$.task_id') = ?1) AS asked,
      (SELECT COUNT(*) FROM submissions a WHERE a.task_id = ?1 AND a.state = 'approved' AND a.id <> ?3) AS approved,
      (SELECT COUNT(*) FROM turns u, submissions s WHERE s.id = ?3 AND u.task_id = ?1 AND u.id <> ?2
        AND u.mode IS NOT 'readonly' AND u.created_at <= s.created_at
        AND u.created_at > COALESCE((SELECT MAX(a.created_at) FROM submissions a WHERE a.task_id = ?1
          AND a.state = 'approved' AND a.id <> ?3), '')) AS others`).get(submission.task_id, submission.turn_id, submission.id);
  return job?.tickets === 1 && job.others === 0 && (job.asked === 0 || job.approved > 0);
}

/**
 * Whether the Bot that handed this over is at work on something you said about its job since: a line
 * of yours filed under its ticket, or under the job as a whole, after the hand-over, which that Bot
 * has not finished with — a segment of its on the ticket (or the whole job) it opened or was heard in
 * still running, its work there still going on (asked you something, waiting on a job of its own,
 * queued again), or the line still queued for it. What it makes of your line is the next thing to
 * look at, not this (2026-10-07: 「把猫改成橘猫」, said 14 s after a picture was handed over, was
 * followed by a card to let that picture through while the Bot was making the orange one).
 * Segments that only read never count; work stopped or stuck (needs attention) is over.
 */
function workOnYourLine(ctx: StoreContext, submission: Pick<Submission, "task_id" | "ticket_id" | "bot_id" | "created_at">): boolean {
  return Boolean(ctx.db.query(`WITH yours AS (
      SELECT DISTINCT f.message_id AS id FROM message_filings f JOIN messages m ON m.id = f.message_id
      WHERE f.task_id = ?1 AND (f.ticket_id = ?2 OR f.ticket_id IS NULL) AND m.kind = 'user' AND m.created_at > ?4),
    heard AS (
      SELECT u.status, u.work_item_id FROM turns u WHERE u.bot_id = ?3 AND u.task_id = ?1 AND (u.ticket_id = ?2 OR u.ticket_id IS NULL)
        AND u.mode IS NOT 'readonly' AND (u.trigger_message_id IN (SELECT id FROM yours)
          OR u.id IN (SELECT delivered_turn_id FROM inbox_items WHERE bot_id = ?3 AND message_id IN (SELECT id FROM yours))))
    SELECT 1 FROM heard WHERE status IN ${LIVE_TURN_STATUSES}
      OR work_item_id IN (SELECT id FROM work_items WHERE state IN ('queued', 'running', 'waiting', 'blocked'))
    UNION ALL SELECT 1 FROM inbox_items WHERE bot_id = ?3 AND state = 'queued' AND message_id IN (SELECT id FROM yours)
    LIMIT 1`).get(submission.task_id, submission.ticket_id, submission.bot_id, submission.created_at));
}

/**
 * Holds a hand-over while its Bot works on what you said since ({@link workOnYourLine}): a card up for
 * it is taken down, saying it waits for that, and the hand-over is put to you again — on a new card,
 * by the next tick — only if that work ends with nothing newer handed over. A newer hand-over
 * supersedes it as always. Returns the card taken down, if any.
 */
function holdForWork(ctx: StoreContext, submission: Submission, now: string): Message | null {
  const awaiting = submission.awaiting;
  if (!awaiting?.message_id) return null;
  const bot = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(submission.bot_id)?.name ?? submission.bot_id;
  letGoOfCard(ctx, awaiting.message_id, { reason: "said_more", bot });
  ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ ...awaiting, message_id: null, held: true }), now, submission.id]);
  return getMessage(ctx, awaiting.message_id);
}

/**
 * Your line, once it has woken whom it wakes: a hand-over of the job it is filed under that waits on
 * your card is taken down at once when its Bot is now at work on what you said, rather than at the
 * next tick. A 放行 you already pressed is left alone. Returns the cards taken down.
 */
export function holdForYourLine(ctx: StoreContext, messageId: string, now: string = isoNow()): Message[] {
  return ctx.commit(() => {
    if (!supervised(ctx)) return [];
    const rows = ctx.db.query<SubmissionRow, [string]>(`SELECT s.* FROM submissions s WHERE s.state IN ('submitted', 'in_review') AND s.awaiting IS NOT NULL
      AND EXISTS (SELECT 1 FROM message_filings f WHERE f.message_id = ?1 AND f.task_id = s.task_id AND (f.ticket_id = s.ticket_id OR f.ticket_id IS NULL))
      ORDER BY s.created_at, s.rowid`).all(messageId).map(toSubmission);
    const taken: Message[] = [];
    for (const submission of rows) {
      if (!submission.awaiting?.message_id || submission.awaiting.pending || !workOnYourLine(ctx, submission)) continue;
      const card = holdForWork(ctx, submission, now);
      if (card) taken.push(card);
    }
    return taken;
  });
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
  // A routine runs unattended, as you set it up: what a run hands over is taken once its gates pass —
  // every gate that ran did, by here — with no card asking you to approve each day's brief
  // (2026-10-04). A card an earlier build left waiting is let go of as approved.
  if (routinePlan(ctx, submission.task_id)) {
    approve(ctx, submission, submission.awaiting?.review ?? null, checks, now, "routine");
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  const awaiting = submission.awaiting;
  const review = awaiting?.review ?? null;
  // A 放行 you already pressed, waiting on a gate, resolves here once every gate has run — one
  // added while it waited included, which the press's own run never saw.
  if (awaiting?.kind === "approval" && awaiting.pending) return { submission: resolveApproval(ctx, submission, checks, now), unrun: [] };
  // Made in one go, by the one segment since the job opened or was last let through: approved now,
  // with no card — you asked, the Bot did it, and it is there where you asked. That holds for what
  // you said about the picture too: the line that opened a picture job is always such an item, and
  // it put every one made in one go on a card (2026-10-07). A line of yours said since does not hold
  // it either: what the Bot makes of that goes the same way once this one is through. A large job's
  // sample and last part are always yours (ADR 0060).
  if (!awaiting && doneInOneGo(ctx, submission) && !yoursToApprove(ctx, submission.ticket_id)) {
    approve(ctx, submission, null, checks, now, checks.some(backs) ? "no_reviewer" : "one_go");
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  // You said more on the job since it was handed over, and its Bot is at work on that: no card for
  // this one meanwhile, and one already up comes down.
  if (workOnYourLine(ctx, submission)) {
    holdForWork(ctx, submission, now);
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  if (awaiting?.kind === "approval" && !awaiting.held) {
    // Your card waits on your press alone, and a later tick never approves it by itself — unless all
    // it waited on were the required items it lists: once you have dropped them on the board, or a
    // check you confirmed passes on them, and nothing else needs your 放行, it lets the hand-over
    // through, as the required-items card it replaced did.
    if (awaiting.requirement_ids.length > 0 && !needsYourApproval(ctx, submission, checks, review)
      && unbackedItems(ctx, submission, review ? "raised" : "all").length === 0) {
      approve(ctx, submission, review, checks, now);
    }
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  // An organizer's reading or an answer always ends on your approve/reject card: nobody made the
  // words, reviewed or not. A file hand-over (submit/implicit) with no reviewer is approved only when
  // at least one gate you wrote or confirmed backs it and all gates pass — by here every gate that
  // ran did (the first check above sent a failure back). What you said twice or more, or about the
  // picture, with nothing behind it is yours as well: it is listed on the same card, one card for the
  // hand-over, and 放行 takes it as met.
  const open = unbackedItems(ctx, submission, review ? "raised" : "all");
  if (open.length > 0 || needsYourApproval(ctx, submission, checks, review)) {
    askApproval(ctx, submission, now, review, { items: open, backed: checks.some(backs) });
    return { submission: getSubmission(ctx, submission.id), unrun: [] };
  }
  approve(ctx, submission, review, checks, now);
  return { submission: getSubmission(ctx, submission.id), unrun: [] };
}

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
    if (cardId) markApprovalCard(ctx, cardId, "reject", checkLines(failing, localeOf(ctx)));
  } else {
    approve(ctx, submission, review, checks, now);
    if (cardId) markApprovalCard(ctx, cardId, "approve", []);
  }
  return getSubmission(ctx, submission.id);
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
 * Your answer on a card, once per card. On the approve/reject card: `approve` resolves it on its
 * checks as the no-reviewer path always did — the required items it lists taken as met — with a gate
 * still `not_run` waited for first (its check ids come back in `checkIds`, for the engine to run
 * before taking it up again — `takeUpPendingApproval`); `reject` sends it back to rework and wakes
 * its producer, the way a reviewer's reject does. On a required-items card from before 2026-10-07,
 * still out: confirming the item says it is met for this hand-over; removing it stops requiring it
 * in this plan (waived, or not held here when it is the conversation's or standing); confirming the
 * check makes it a gate, and the engine then runs it and takes the submission up again (returned in
 * `checkIds`).
 */
export function answerReviewCard(ctx: StoreContext, messageId: string, action: unknown, opts: { note?: unknown } = {}): { submission: Submission; checkIds: string[]; message: Message } {
  const note = sendBackNote(opts.note);
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
        const en = localeOf(ctx) === "en";
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
      after = rejectByUser(ctx, submission, now, note, message.session_id);
      // What you said with it is your word on the job, as an answer on a question card is: kept as
      // yours, read into the ledger, measured for numbers. The 《一拳超人》 note 「一集时长20分钟……」
      // reached the director once, as its rework note, and nowhere else (2026-10-04).
      if (note) recordQuote(ctx, { via: "ask_answer", body: note, messageId: message.id, sessionId: message.session_id,
        taskId: submission.task_id, ticketId: submission.ticket_id, now });
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
    // What the press did, in place of a waiting line it may have had (退回 while 放行 was pending);
    // a 退回 with what you want changed says it there.
    const { result: _waiting, ...answered } = control;
    const said = action === "reject" && note ? { result: localeOf(ctx) === "en" ? `Sent back: "${note}"` : `已退回：「${note}」` } : {};
    setMessageControl(ctx, messageId, { ...answered, ...said, acted: [action as ReviewCardAction] });
    updateNotificationActionState(ctx, `review_item:${messageId}`, "resolved", action as ReviewCardAction, true);
    return { submission: after, checkIds, message: getMessage(ctx, messageId) };
  });
}

/**
 * What you want changed, said with 退回: trimmed, null when there is none. A 退回 that said nothing
 * left the Bot to guess what was wrong (2026-10-04): it was told only that you sent it back.
 */
function sendBackNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(422, "invalid_args", "note must be a string");
  const note = raw.trim();
  if ([...note].length > CONTROL_NOTE_MAX) throw new HttpError(422, "invalid_args", `note is longer than ${CONTROL_NOTE_MAX} characters`);
  return note.length > 0 ? note : null;
}

/** Your 退回 on an approval card (ADR 0046): rework, the way a reviewer's reject reads, without one. */
function rejectByUser(ctx: StoreContext, submission: Submission, now: string, note: string | null = null, answeredIn: string | null = null): Submission {
  ctx.db.run("UPDATE submissions SET state = 'rejected', checks = ?, awaiting = NULL, updated_at = ? WHERE id = ?",
    [JSON.stringify(submission.checks), now, submission.id]);
  setTicketStage(ctx, { ticketId: submission.ticket_id, stage: "rework", source: "user", turnId: null, workItemId: submission.work_item_id, submissionId: submission.id, now });
  const decided = getSubmission(ctx, submission.id);
  setPartStage(ctx, decided, "rework");
  const ceiling = checkCeiling(ctx, decided, now);
  noteHandOverFailed(ctx, submission.work_item_id, now);
  recordWorkEvent(ctx, { kind: "review.recorded", actor: USER_MEMBER, taskId: submission.task_id, ticketId: submission.ticket_id,
    payload: { submission_id: submission.id, work_item_id: submission.work_item_id, outcome: "reject", by: "user", ...(note ? { note } : {}) } });
  const en = localeOf(ctx) === "en";
  const what = en
    ? `(app) The user sent submission ${decided.id} back for rework.${note ? ` What they want changed, in their words: "${note}"` : ""}`
    : `（应用）用户把交付 ${decided.id} 退回重做了。${note ? `要改的地方，原话：「${note}」` : ""}`;
  tellAfterFailure(ctx, decided, { what, retry: "" }, ceiling, now, answeredIn);
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
 * The supervisor's part (§5.3.7), each tick, outside your stops and dormant plans: a submission
 * checked and handed over with no reviewer for longer than one tick goes to the ticket's reviewer if
 * it has one by now; else the app reads its checks as they are now (a gate failing sends it back to
 * its producer) and approves it when a gate of yours backs it or it was made in one go — otherwise,
 * or when a required item (raised twice or more, or about the picture) has nothing behind it, one
 * card asks you. A submission waiting on you is taken up again each tick against what is true now.
 * Returns what it moved and the cards it wrote.
 */
export function superviseSubmissions(ctx: StoreContext, now: string = isoNow()): {
  moved: Submission[]; messages: Message[]; toRun: Array<{ taskId: string; checkIds: string[] }>;
} {
  const out = { moved: [] as Submission[], messages: [] as Message[], toRun: [] as Array<{ taskId: string; checkIds: string[] }> };
  if (!supervised(ctx)) return out;
  const cutoff = isoPlus(now, -UNREVIEWED_AFTER_MS);
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
    if (after.state !== submission.state || (after.awaiting?.message_id ?? null) !== card) out.moved.push(after);
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
  const due = isoPlus(now, -UNREVIEWED_AFTER_MS);
  ctx.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
      note, state, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, 'organizer', '[]', NULL, '[]', ?, 'submitted', ?, ?)`,
    [id, work?.id ?? null, ticket.task_id, ticket.id, producer ?? "app", localeOf(ctx) === "en" ? "The organizer read this ticket as done." : "整理跳认为这张任务做完了。", now, due]);
  setTicketStage(ctx, { ticketId: ticket.id, stage: "submitted", source: "submission", botId: producer, workItemId: work?.id ?? null, submissionId: id, now });
  recordWorkEvent(ctx, { kind: "submission.created", actor: "app", botId: producer, taskId: ticket.task_id, ticketId: ticket.id,
    payload: { submission_id: id, work_item_id: work?.id ?? null, origin: "organizer", artifacts: [], parts: [], superseded: [] } });
  return getSubmission(ctx, id);
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
