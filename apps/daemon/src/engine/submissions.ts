/**
 * Submissions and reviews on the engine's side (ADR 0040 §2.8, §5.2; ADR 0046), from engine level
 * 5. The store decides what a submission's checks mean and whether a review stands
 * (`store/submissions.ts`); this reads the files (content hashes), cites what is handed over so a
 * check from your words can find its file, runs the checks and waits for them, and lets the queue
 * start whoever a submission or a review woke. Nothing here calls a model but the reading of a line
 * (ADR 0055, `reader.ts`): whether words handed over are the deliverable, what a line of yours objects to.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ControlActionResult, Message } from "@real-bot/protocol";
import type { ToolResult } from "../collab-tools";
import { toolFail } from "../tool-result";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { checkLines, inTicketDir, type SettledSubmission, type Store, type StoredSubmission, type SubmissionCheck } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { classifyPath } from "../workspace-paths";
import type { BotLineContext, BotLineReading, UserLineReading } from "../line-reading";

/** A file larger than this is not hashed, and so cannot be handed over (the supervisor's artifact limit). */
const SUBMISSION_HASH_BYTES_MAX = 2 * 1024 ** 3;
/** How many times a submission's checks are asked to run before what has not run reads as not run. */
const CHECK_ROUNDS = 3;

export type SubmissionsDeps = {
  store: Store;
  /** Runs these checks of the plan (the plan-checks runner), as a submission's or a review's rerun. */
  runChecks: (taskId: string, checkIds: string[]) => Promise<void>;
  /** Brings the plan's checks from your words in line with what is delivered, so one finds the file just handed over. */
  syncDerived: (taskId: string) => void;
  /** Posts and publishes a line of the segment's citing these files (those it has not cited yet). */
  citePaths: (turnId: string, paths: string[]) => Message | null;
  /** Starts what the queue now holds: a reviewer asked to review, a producer sent back to rework. */
  dispatchQueued: () => void;
  /** The segment's work dir, for a file named from the shell's point of view. */
  workDir: (turnId: string) => string | null;
  /** Publishes a line the store wrote (a card asking you about a hand-over). */
  publishMessage: (message: Message) => void;
  /** Late-bound: what the engine runs as a background job, so a test or a drain can wait for it. */
  track: <T>(promise: Promise<T>) => Promise<T>;
  /** A line of yours, read for what it objects to (ADR 0055, `reader.ts`). */
  readUserLine: (message: Message) => Promise<UserLineReading>;
  /** A Bot's words, read for whether they are the deliverable (ADR 0055). */
  readBotLine: (body: string, sessionId: string | null, context?: BotLineContext) => Promise<BotLineReading>;
  log?: (line: string) => void;
};

export type Submissions = {
  /** The `submit` tool. */
  submit: (turnId: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** The `review` tool. */
  review: (turnId: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * The implicit submission (§5.2): new files this segment cited in its ticket's folder, handed over
   * for it. `cite` first cites what the segment wrote and has not cited yet (an ending about to
   * cite them anyway). Null when there was nothing new, or below level 5.
   */
  implicit: (turnId: string, opts?: { cite?: string[]; tell?: boolean }) => Promise<SettledSubmission | null>;
  /** A button on a card asking you about a hand-over's required items (`review_item`). */
  act: (message: Message, input: { action: unknown }) => ControlActionResult;
  /**
   * Words handed over in place of a file (`answer`): on a ticket no file was ever handed over on,
   * by its producer, when the words are new and read as the deliverable ({@link isAnswerText}).
   * Null when it does not apply (not the producer, a file was already handed over, the same words
   * again), or below level 5. Throws `not_an_answer` when the text itself does not qualify.
   */
  answer: (turnId: string, text: string) => Promise<SettledSubmission | null>;
  /**
   * A line of yours, once filed (or refiled, or once the scribe made entries of it): a complaint
   * about work handed over or approved asks whether to send it back to rework (§6.6). Read as
   * `reading` says, else once it is read. Never throws.
   */
  noteComplaint: (messageId: string, opts?: { scribeAdded?: readonly string[]; reading?: UserLineReading }) => void;
  /** Your answer on a rework card: send it back, leave it, or undo. */
  answerRework: (message: Message, input: { action: unknown }) => ControlActionResult;
  /** Your answer on a ceiling card. */
  answerCeiling: (message: Message, input: { action: unknown }) => ControlActionResult;
};

/**
 * `end_turn(done, answer)`'s text must be more than one bare character — not a real content floor:
 * an `answer` hand-over always ends on your approve/reject card, so that card is the safeguard and a
 * short real deliverable (a title, a slogan) must reach it. The claim/ack/promise/question filters
 * below do the actual work.
 */
const ANSWER_TEXT_MIN_CODE_POINTS = 2;

/**
 * Whether words handed over explicitly (`end_turn(done, answer)`, on a ticket no file was ever
 * handed over on) read as the deliverable itself rather than a step on the way: not empty, not a
 * no-work closer, not a promise of more to come, not a question, and not a bare ack, claim or short
 * promise with nothing else behind it — as `reading` reads them (ADR 0055). Replaces `readsAsAnswer`, which used to infer a hand-over
 * from any plain-text closing reply — a verbal hand-over that let "母带剪好了" approve a ticket
 * nobody checked. Words are handed over only through this explicit call
 * now, and only when they pass this check; a plain-text closing reply never hands anything over on
 * its own. `isBareRemark` (no-work.ts) does not fit here and is deliberately left out: its "no file,
 * code or link" shape is exactly what a real text answer ("海边的灯塔", an outline, a paragraph of
 * copy) looks like, so it would reject one wholesale. A padded ack that slips past this is not a
 * bypass: it still lands on your approve/reject card like any other.
 */
export function isAnswerText(text: string, reading: BotLineReading): boolean {
  const body = text.trim();
  if ([...body].length < ANSWER_TEXT_MIN_CODE_POINTS) return false;
  if (reading.noWork || reading.later !== null) return false;
  if (/[?？]\s*$/.test(body)) return false;
  return !reading.bareStatus;
}

/** The tool message `end_turn(done, answer)` gets when its text does not read as the deliverable. */
function notAnAnswerMessage(en: boolean): string {
  return en
    ? "This does not read as the deliverable: hand over the words themselves as the answer — a title, a line, a list, a paragraph. If the work is a file, keep working until that file exists."
    : "这读不出是要交的内容本身：把要交的话本身写进 answer——一个标题、一行字、一份清单、一段话。如果这张任务的成果是一个文件，那就接着做，直到那个文件真的存在。";
}

function failure(error: unknown): ToolResult {
  if (error instanceof HttpError) return toolFail(error.code, error.message);
  return toolFail("failed", error instanceof Error ? error.message : String(error));
}

export function createSubmissions(deps: SubmissionsDeps): Submissions {
  const { store, runChecks, syncDerived, citePaths, dispatchQueued, publishMessage, track } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  function on(): boolean {
    try {
      return store.capabilities().engine_level >= ENGINE_LEVELS.submissions;
    } catch {
      return false;
    }
  }

  /** Content hashes of the files that are there and small enough; the others are left out. */
  async function hash(paths: readonly string[]): Promise<Array<{ path: string; sha256: string }>> {
    const root = store.workspacePath();
    if (!root) return [];
    const out: Array<{ path: string; sha256: string }> = [];
    for (const path of paths) {
      try {
        const abs = join(root, path);
        if (!statSync(abs).isFile()) continue;
        const file = Bun.file(abs);
        if (file.size > SUBMISSION_HASH_BYTES_MAX) continue;
        const hasher = new Bun.CryptoHasher("sha256");
        for await (const chunk of file.stream()) hasher.update(chunk);
        out.push({ path, sha256: hasher.digest("hex") });
      } catch {
        // gone, or not readable: nothing to hand over
      }
    }
    return out;
  }

  /** A file named in a call, as a workspace-relative path: from the work dir first, as the shell sees it. */
  function resolve(turnId: string, raw: string): string | null {
    const root = store.workspacePath();
    if (!root) return null;
    const workDir = deps.workDir(turnId);
    const tries = raw.startsWith("/") || !workDir ? [raw] : [`${workDir}/${raw}`, raw];
    for (const candidate of tries) {
      try {
        const classified = classifyPath(root, candidate);
        if (classified.zone !== "inside" || !classified.rel) continue;
        if (statSync(classified.abs).isFile()) return classified.rel;
      } catch {
        // not there this way
      }
    }
    return null;
  }

  /**
   * Runs the checks a submission is held to and waits until each has a run started since `since`:
   * a run already going for the plan folds this one into a rerun after it, so it is asked again.
   */
  async function runBound(submission: StoredSubmission, since: string): Promise<SubmissionCheck[]> {
    try {
      syncDerived(submission.task_id);
    } catch (error) {
      log(`[submissions] ${submission.id}: could not sync checks from your words: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ids = store.submissionCheckIds(submission);
    if (ids.length === 0) return [];
    for (let round = 0; round < CHECK_ROUNDS; round += 1) {
      await runChecks(submission.task_id, ids);
      if (store.submissionCheckResults(ids, since).every((check) => check.outcome !== "not_run")) break;
    }
    return store.submissionCheckResults(ids, since);
  }

  async function settle(submission: StoredSubmission, tell = false): Promise<SettledSubmission> {
    await runBound(submission, submission.created_at);
    const settled = store.settleSubmissionChecks(submission.id, undefined, { tell });
    dispatchQueued();
    return settled;
  }

  async function submit(turnId: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (!on()) return toolFail("submissions_unavailable", "submit is not on at this engine level");
      const raw = Array.isArray(args.artifacts) ? args.artifacts : typeof args.artifacts === "string" ? [args.artifacts] : null;
      if (!raw || raw.length === 0 || raw.some((entry) => typeof entry !== "string" || !entry.trim())) {
        return toolFail("invalid_args", "artifacts must list the files you hand over");
      }
      if (args.continue !== undefined && typeof args.continue !== "boolean") {
        return toolFail("invalid_args", "continue must be true or false");
      }
      const paths: string[] = [];
      for (const entry of raw as string[]) {
        const path = resolve(turnId, entry.trim());
        if (!path) return toolFail("invalid_args", `${entry} is not a file in the workspace`);
        if (!paths.includes(path)) paths.push(path);
      }
      const artifacts = await hash(paths);
      const missing = paths.filter((path) => !artifacts.some((artifact) => artifact.path === path));
      if (missing.length > 0) return toolFail("invalid_args", `could not read ${missing.join(", ")}`);
      const prepared = store.prepareSubmission({ turnId, origin: "submit", artifacts, parts: args.parts, claims: args.claims, note: args.note });
      if (!prepared) return toolFail("failed", "nothing to submit");
      // Handed over is shown: the files go out on a line of the segment's (published as it is posted).
      citePaths(turnId, paths);
      const emitted: ToolResult["emitted"] = [];
      const settled = await settle(prepared.submission);
      const lang = store.settingsCached().locale === "en" ? "en" : "zh";
      const lines = checkLines(settled.submission.checks, lang);
      if (settled.state === "checks_failed") {
        const failing = checkLines(settled.failures, lang);
        return { ok: false, error: { code: "checks_failed", message: `submission ${settled.submission.id} failed its checks, so the ticket did not move: ${failing.join("; ")}. Fix it and submit again.` },
          data: { submission_id: settled.submission.id, state: settled.state, checks: lines }, emitted };
      }
      let ended = false;
      let notEnded: string | undefined;
      if (args.continue !== true) {
        try {
          const end = store.endAfterSubmit(turnId);
          ended = end.ended;
          notEnded = end.reason;
        } catch (error) {
          notEnded = error instanceof Error ? error.message : String(error);
        }
      }
      return { ok: true, data: { submission_id: settled.submission.id, state: settled.state, reviewer: settled.reviewer, checks: lines,
        ...(ended ? { ended: true } : {}), ...(notEnded ? { not_ended: notEnded } : {}) }, emitted };
    } catch (error) {
      return failure(error);
    }
  }

  async function review(turnId: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (!on()) return toolFail("submissions_unavailable", "review is not on at this engine level");
      if (args.submission_id !== undefined && typeof args.submission_id !== "string") {
        return toolFail("invalid_args", "submission_id must be a string");
      }
      const target = store.reviewTarget(turnId, (args.submission_id as string | undefined) ?? null);
      if (!target) return toolFail("invalid_args", "there is no submission here to review: name its submission_id");
      // An approval stands only on checks run now (§2.8: the app reruns them and its result decides).
      let checks: SubmissionCheck[] | undefined;
      if (args.outcome === "approve" && target.bot_id !== store.getTurn(turnId).bot_id && (target.state === "submitted" || target.state === "in_review")) {
        const since = isoNow();
        checks = await runBound(target, since);
      }
      const result = store.reviewSubmission({ turnId, submissionId: target.id, verdicts: args.verdicts, outcome: args.outcome, note: args.note, checks });
      dispatchQueued();
      if (!result.ok && result.code === "awaiting_user") {
        if (result.card) publishMessage(result.card);
        return { ok: false, error: { code: result.code, message: `approval of submission ${result.submission.id} waits on the user: ${result.reasons.join(" | ")}. A card asks the user to approve it or send it back; there is nothing more for you to do on this submission — end your turn.` },
          data: { submission_id: result.submission.id, waiting_on: "user" }, emitted: [] };
      }
      if (!result.ok) {
        return { ok: false, error: { code: result.code, message: `approval refused for submission ${result.submission.id}: ${result.reasons.join(" | ")}` },
          data: { submission_id: result.submission.id }, emitted: [] };
      }
      return { ok: true, data: { submission_id: result.submission.id, outcome: result.outcome, state: result.submission.state,
        same_model: result.submission.reviews.at(-1)?.same_model ?? false }, emitted: [] };
    } catch (error) {
      return failure(error);
    }
  }

  async function implicit(turnId: string, opts: { cite?: string[]; tell?: boolean } = {}): Promise<SettledSubmission | null> {
    if (!on()) return null;
    let turn;
    try {
      turn = store.getTurn(turnId);
    } catch {
      return null;
    }
    if (!turn.ticket_id || !turn.task_id) return null;
    let ticket;
    try {
      ticket = store.getTicket(turn.ticket_id);
    } catch {
      return null;
    }
    // A ticket already approved or dropped is reopened only by an explicit submit (or you).
    if (ticket.stage === "approved" || ticket.stage === "dropped" || ticket.status === "done" || ticket.status === "parked") return null;
    // What the ending is about to cite anyway, cited now, in one line, so these count as cited.
    if ((opts.cite ?? []).some((path) => inTicketDir(ticket.dir, path))) citePaths(turnId, opts.cite!);
    const paths = store.implicitSubmissionPaths(turnId);
    if (paths.length === 0) return null;
    const artifacts = await hash(paths);
    if (artifacts.length === 0) return null;
    let prepared;
    try {
      prepared = store.prepareSubmission({ turnId, origin: "implicit", artifacts });
    } catch (error) {
      log(`[submissions] turn ${turnId}: no implicit submission: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!prepared) return null;
    return settle(prepared.submission, opts.tell === true);
  }

  /**
   * Your answer on a hand-over's card. 放行 approves it once its gates have run (a gate not run yet
   * is run first, then the press resolves); 退回 sends it back. On a required-items card from before
   * 2026-10-07: confirming the item or removing it takes the submission up at once; confirming the
   * check makes it a gate, and the submission is taken up again once it has run — a failing gate
   * sends the hand-over back to its producer, now against a number you confirmed.
   */
  function act(message: Message, input: { action: unknown; note?: unknown }): ControlActionResult {
    const answered = store.answerReviewCard(message.id, input.action, { note: input.note });
    publishMessage(answered.message);
    if (answered.checkIds.length > 0) {
      const submission = answered.submission;
      // 放行 pressed while a gate had not run yet: wait for it, then resolve the press itself —
      // never a second ask, and never 已放行 for what actually failed.
      const pendingApproval = input.action === "approve";
      void track((async () => {
        try {
          await runBound(submission, isoNow());
          if (pendingApproval) {
            store.takeUpPendingApproval(submission.id);
            try {
              publishMessage(store.getMessage(message.id));
            } catch {
              // the card is gone: nothing to republish
            }
          } else {
            store.takeUpSubmission(submission.id);
          }
        } catch (error) {
          log(`[submissions] ${submission.id}: could not take it up after your confirm: ${error instanceof Error ? error.message : String(error)}`);
        }
        dispatchQueued();
      })());
    } else {
      dispatchQueued();
    }
    return { made: [], lifted: [] };
  }

  async function answer(turnId: string, text: string): Promise<SettledSubmission | null> {
    if (!on() || !text.trim()) return null;
    let sessionId: string | null = null;
    try {
      sessionId = store.getTurn(turnId).session_id;
    } catch {
      sessionId = null;
    }
    if (!isAnswerText(text, await deps.readBotLine(text.trim(), sessionId, { answering: store.segmentAnswering(turnId) }))) {
      throw new HttpError(422, "not_an_answer", notAnAnswerMessage(store.settingsCached().locale === "en"));
    }
    let prepared;
    try {
      prepared = store.prepareSubmission({ turnId, origin: "answer", artifacts: [], content: text });
    } catch (error) {
      log(`[submissions] turn ${turnId}: no answer handed over: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!prepared) return null;
    return settle(prepared.submission);
  }

  function noteComplaint(messageId: string, opts: { scribeAdded?: readonly string[]; reading?: UserLineReading } = {}): void {
    if (!on()) return;
    const note = (reading: UserLineReading): void => {
      try {
        const objecting = { clauses: reading.objections, source: reading.source };
        if (store.noteComplaint(messageId, { scribeAdded: opts.scribeAdded, objecting }).length > 0) dispatchQueued();
      } catch (error) {
        log(`[submissions] line ${messageId}: could not read it as a complaint: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (opts.reading) return note(opts.reading);
    let message: Message;
    try {
      message = store.getMessage(messageId);
    } catch {
      return;
    }
    if (message.kind !== "user") return;
    void track(deps.readUserLine(message).then(note));
  }

  function answerRework(message: Message, input: { action: unknown }): ControlActionResult {
    store.answerReworkCard(message.id, input.action);
    dispatchQueued();
    return { made: [], lifted: [] };
  }

  function answerCeiling(message: Message, input: { action: unknown }): ControlActionResult {
    store.answerCeilingCard(message.id, input.action);
    dispatchQueued();
    return { made: [], lifted: [] };
  }

  return { submit, review, implicit, act, answer, noteComplaint, answerRework, answerCeiling };
}
