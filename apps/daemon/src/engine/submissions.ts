/**
 * Submissions and reviews on the engine's side (ADR 0040 §2.8, §5.2; ADR 0046), from engine level
 * 5. The store decides what a submission's checks mean and whether a review stands
 * (`store/submissions.ts`); this reads the files (content hashes), cites what is handed over so a
 * check from your words can find its file, runs the checks and waits for them, and lets the queue
 * start whoever a submission or a review woke. Nothing here calls a model.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ControlActionResult, Message } from "@real-bot/protocol";
import type { ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { checkLines, inTicketDir, type SettledSubmission, type Store, type StoredSubmission, type SubmissionCheck } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { classifyPath } from "../workspace-paths";
import { promisesLaterWork } from "../closing-check";
import { isNoWorkCloser } from "../no-work";

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
};

/**
 * `end_turn(done, answer)`'s text must be more than one bare character — not a real content floor:
 * an `answer` hand-over always ends on your approve/reject card, so that card is the safeguard and a
 * short real deliverable (a title, a slogan) must reach it. The claim/ack/promise/question filters
 * below do the actual work.
 */
const ANSWER_TEXT_MIN_CODE_POINTS = 2;

/** A bare acknowledgement, in Chinese or English — never a hand-over by itself, however short or long. */
const ACK_SIGNAL = "好的|好嘞|嗯+|收到|明白|了解|知道了|没问题|^(?:行|好)[。！!~～]*$"
  + "|\\bok(?:ay)?\\b|\\bsure\\b|\\balright\\b|\\bgot it\\b|\\bunderstood\\b|\\bnoted\\b";

/**
 * Chinese/English fragments that only ever report status — done, mid-progress, can't do it — never
 * the deliverable itself ("母带剪好了" is not a master cut). `完成` needs no 已/已经 prefix ("任务完成，
 * 请查收" is as bare a claim as "已完成"), but 完成度 / 完成率 are content.
 */
const CLAIM_SIGNAL =
  "做完了|剪完了|弄完了|渲染完了|导出好了|传好了|剪好了|弄好了|办好了|处理好了|做好[了啦]|搞好了|搞定了?|(?:已经?)?完成(?![度率稿])"
  + "|已经?(?:提交|上传|发你)|发你了|正在做|在做(?:着)?|在弄了?|弄着呢|还没好|快好了|马上就?好|做不了|弄不了|搞不了"
  + "|\\bdone\\b|\\bfinished\\b|\\bcompleted\\b|\\bworking on (?:it|this)\\b|\\ball set\\b|\\bit'?s ready\\b|\\bhere you go\\b|\\bon it\\b";

/**
 * Waiting on someone or something. 等 inside a title or a line is content (「等风来」「等级：A」
 * 「《等待戈多》」「我们等你回来」): it reads as a wait only after 在/还在/正在, or opening a clause and
 * naming what it waits for within the clause.
 */
const WAIT_SIGNAL =
  "(?:还在|正在|在)等(?![》」”\"'])[^，。！？.!?：:—《》]{0,20}|稍等|等我一下|还在路上"
  + "|(?:^|[\\s，,。.!！；;])等[^，。！？.!?：:—《》]{0,20}?(?:那边|回复|回音|确认|审|结果|通知|反馈|处理|跑完|生成|出来|到了|一下|下载|上传|好了|完了)"
  + "|(?:^|\\b(?:i'?m|we'?re|still|am|are)\\s+)waiting\\b(?:\\s+(?:for|on)\\s+[^.!?]*)?";

/** A short, concrete promise of something still to come, beyond `promisesLaterWork`'s own vocabulary (a time-boxed "I'll get it to you", "let me just look first"). */
const SHORT_PROMISE_SIGNAL = "[一二三四五六七八九十0-9]+\\s*分钟(?:内|后)|我先[^，。！？.!?]{0,8}(?:看|核|查|检|搞|弄|处理|跑)|先看一下|先看看"
  + "|(?:让我|我去|去)?看看(?=[^\\p{L}]|素材|$)|我看[看下]|我瞅瞅|我想想|我(?:研究|查|核对|确认)一下|^看一?下[。！!~～]*$|^看看[。！!~～]*$"
  + "|我这就去|这就去|开始干|(?:^|[，,。！!])(?:我来(?:吧|了)?|交给我吧?|安排(?:上|一下)?)[。！!~～]*$";

/** Padding that dresses a status line up without adding content: thanks, a file's location, "go check it yourself". */
const STATUS_FILLER = "请查收|请查阅|请验收|请过目|放在[^，。！？.!?]{0,20}(?:里|目录|文件夹|下)|给你|没有素材|没有(?:文件|资料|原始素材)";

const STATUS_SIGNAL = `${ACK_SIGNAL}|${CLAIM_SIGNAL}|${WAIT_SIGNAL}|${SHORT_PROMISE_SIGNAL}`;

/**
 * Whether `text` is nothing more than an ack, a claim or a short promise (however it is dressed up):
 * once those and their filler are stripped out, only a few stray characters are left. The card every
 * `answer`/`organizer` hand-over ends on regardless is the real safeguard, so this
 * only has to catch the common case — a Bot's reflexive "好的" or "母带剪好了" — not every way of
 * saying nothing; a long real answer that happens to open with "已经做完了" keeps the rest of its
 * content and so keeps a remainder well past the threshold.
 */
function isBareStatus(text: string): boolean {
  if (!new RegExp(STATUS_SIGNAL, "iu").test(text)) return false;
  const remainder = text
    .replace(new RegExp(STATUS_SIGNAL, "giu"), " ")
    .replace(new RegExp(STATUS_FILLER, "giu"), " ")
    .replace(/[\s,，.。!！;；:：、'"“”‘’~～…—\-–`]+/g, " ")
    .trim();
  return [...remainder].length <= 8;
}

/**
 * Whether words handed over explicitly (`end_turn(done, answer)`, on a ticket no file was ever
 * handed over on) read as the deliverable itself rather than a step on the way: not empty, not a
 * no-work closer, not a promise of more to come, not a question, and not a bare ack, claim or short
 * promise with nothing else behind it. Replaces `readsAsAnswer`, which used to infer a hand-over
 * from any plain-text closing reply — a verbal hand-over that let "母带剪好了" approve a ticket
 * nobody checked. Words are handed over only through this explicit call
 * now, and only when they pass this check; a plain-text closing reply never hands anything over on
 * its own. `isBareRemark` (no-work.ts) does not fit here and is deliberately left out: its "no file,
 * code or link" shape is exactly what a real text answer ("海边的灯塔", an outline, a paragraph of
 * copy) looks like, so it would reject one wholesale. A padded ack that slips past this is not a
 * bypass: it still lands on your approve/reject card like any other.
 */
export function isAnswerText(text: string): boolean {
  const body = text.trim();
  if ([...body].length < ANSWER_TEXT_MIN_CODE_POINTS) return false;
  if (isNoWorkCloser(body) || promisesLaterWork(body)) return false;
  if (/[?？]\s*$/.test(body)) return false;
  return !isBareStatus(body);
}

/** The tool message `end_turn(done, answer)` gets when its text does not read as the deliverable. */
function notAnAnswerMessage(en: boolean): string {
  return en
    ? "This does not read as the deliverable: hand over the words themselves as the answer — a title, a line, a list, a paragraph. If the work is a file, keep working until that file exists."
    : "这读不出是要交的内容本身：把要交的话本身写进 answer——一个标题、一行字、一份清单、一段话。如果这张任务的成果是一个文件，那就接着做，直到那个文件真的存在。";
}

function failure(error: unknown): ToolResult {
  if (error instanceof HttpError) return { ok: false, error: { code: error.code, message: error.message }, emitted: [] };
  return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) }, emitted: [] };
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
      if (!on()) return { ok: false, error: { code: "submissions_unavailable", message: "submit is not on at this engine level" }, emitted: [] };
      const raw = Array.isArray(args.artifacts) ? args.artifacts : typeof args.artifacts === "string" ? [args.artifacts] : null;
      if (!raw || raw.length === 0 || raw.some((entry) => typeof entry !== "string" || !entry.trim())) {
        return { ok: false, error: { code: "invalid_args", message: "artifacts must list the files you hand over" }, emitted: [] };
      }
      if (args.continue !== undefined && typeof args.continue !== "boolean") {
        return { ok: false, error: { code: "invalid_args", message: "continue must be true or false" }, emitted: [] };
      }
      const paths: string[] = [];
      for (const entry of raw as string[]) {
        const path = resolve(turnId, entry.trim());
        if (!path) return { ok: false, error: { code: "invalid_args", message: `${entry} is not a file in the workspace` }, emitted: [] };
        if (!paths.includes(path)) paths.push(path);
      }
      const artifacts = await hash(paths);
      const missing = paths.filter((path) => !artifacts.some((artifact) => artifact.path === path));
      if (missing.length > 0) return { ok: false, error: { code: "invalid_args", message: `could not read ${missing.join(", ")}` }, emitted: [] };
      const prepared = store.prepareSubmission({ turnId, origin: "submit", artifacts, parts: args.parts, claims: args.claims, note: args.note });
      if (!prepared) return { ok: false, error: { code: "failed", message: "nothing to submit" }, emitted: [] };
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
      if (!on()) return { ok: false, error: { code: "submissions_unavailable", message: "review is not on at this engine level" }, emitted: [] };
      if (args.submission_id !== undefined && typeof args.submission_id !== "string") {
        return { ok: false, error: { code: "invalid_args", message: "submission_id must be a string" }, emitted: [] };
      }
      const target = store.reviewTarget(turnId, (args.submission_id as string | undefined) ?? null);
      if (!target) return { ok: false, error: { code: "invalid_args", message: "there is no submission here to review: name its submission_id" }, emitted: [] };
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
        return { ok: false, error: { code: result.code, message: `approval of submission ${result.submission.id} waits on the user: ${result.reasons.join(" | ")}. A card asks the user to confirm the check or the item, or to drop it; there is nothing more for you to do on this submission — end your turn.` },
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
   * Your answer on a card about a hand-over's required items. Confirming the item or removing it
   * takes the submission up at once (approved when nothing else is open); confirming the check makes
   * it a gate, and the submission is taken up again once it has run — a failing gate sends the
   * hand-over back to its producer, now against a number you confirmed.
   */
  function act(message: Message, input: { action: unknown }): ControlActionResult {
    const answered = store.answerReviewCard(message.id, input.action);
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
    if (!isAnswerText(text)) {
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

  return { submit, review, implicit, act, answer };
}
