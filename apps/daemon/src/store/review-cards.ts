/**
 * A hand-over waiting on your word (ADR 0084), the mark on the line of yours that let it through,
 * and the 放行/退回 cards older builds put up (`review_item`): none is put up any more, but one a
 * database still holds takes its press, and is let go of when its hand-over moves on.
 */
import type { Message } from "@real-bot/protocol";
import { getMessage, setMessageControl } from "./messages";
import { updateNotificationActionState } from "./notifications";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import type { UnbackedItem } from "./submission-evidence";
import { checkLines, gateFailed, getSubmission, type AwaitingYou, type ReviewRecord, type Submission } from "./submission-rows";
import { stagedTicket } from "./ticket-stage";
import { recordWorkEvent } from "./work-events";

/**
 * A hand-over waiting on your word (ADR 0084): no card, no notification. The Bot that made it has
 * told you what it handed over; what you say next about it is read as letting it through or sending
 * it back (`passByYourWord`, `noteComplaint`). `review` is a reviewer's clean approve it would
 * complete, kept with it; `items` the required items nothing backs, which your word letting it
 * through takes as met. Waiting already, it is left as it is.
 */
export function awaitYourWord(ctx: StoreContext, submission: Submission, now: string, review: ReviewRecord | null, items: readonly UnbackedItem[]): void {
  if (submission.awaiting?.kind === "approval") return;
  // A required-items card an older build left up (`kind: "items"`) stays linked, so its press still answers.
  const awaiting: AwaitingYou = { requirement_ids: items.map((item) => item.requirement_id).sort(), check_ids: [], message_id: submission.awaiting?.message_id ?? null,
    review, at: now, kind: "approval" };
  ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify(awaiting), now, submission.id]);
  recordWorkEvent(ctx, { kind: "submission.awaiting_word", actor: "app", botId: submission.bot_id, taskId: submission.task_id, ticketId: submission.ticket_id,
    payload: { submission_id: submission.id, work_item_id: submission.work_item_id, requirement_ids: awaiting.requirement_ids, reviewed: review !== null } });
}

/**
 * The mark under a line of yours that let hand-overs through (ADR 0084, `control.kind = "passed"`),
 * written again from where each of them stands now: let through, sent back because a gate failed
 * when it ran, or still waiting on a gate before it is let through. A line marked some other way (it
 * also sent work back) keeps that mark.
 */
export function markPassedLine(ctx: StoreContext, lineId: string, submissionIds?: readonly string[]): Message | null {
  let control: Message["control"];
  try {
    control = getMessage(ctx, lineId).control;
  } catch {
    return null;
  }
  if (control && control.kind !== "passed") return null;
  const ids = submissionIds ?? (control?.kind === "passed" ? control.submission_ids : []);
  if (ids.length === 0) return null;
  const en = localeOf(ctx) === "en";
  const through: string[] = [];
  const back: string[] = [];
  const waiting: string[] = [];
  for (const id of ids) {
    let submission: Submission;
    try {
      submission = getSubmission(ctx, id);
    } catch {
      continue;
    }
    const plan = ctx.db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(submission.task_id)?.title ?? "";
    const ticket = stagedTicket(ctx, submission.ticket_id);
    const number = String(ticket.seq).padStart(2, "0");
    const label = en ? `ticket ${number} "${ticket.title}" of ${plan}` : `${plan} 的任务 ${number}「${ticket.title}」`;
    if (submission.state === "approved") through.push(label);
    else if (submission.state === "checks_failed") back.push(`${label}${en ? ` (${checkLines(submission.checks.filter(gateFailed), "en").join("; ")})` : `（${checkLines(submission.checks.filter(gateFailed), "zh").join("；")}）`}`);
    else if (submission.awaiting?.pending) waiting.push(label);
  }
  const sep = en ? "; " : "；";
  const result = [
    through.length > 0 ? (en ? `Approved: ${through.join(sep)}.` : `已放行：${through.join(sep)}。`) : null,
    back.length > 0 ? (en ? `Its checks failed, so it went back: ${back.join(sep)}.` : `检查没过，已退回：${back.join(sep)}。`) : null,
    waiting.length > 0 ? (en ? `Approving once its checks have run: ${waiting.join(sep)}.` : `等检查跑完再放行：${waiting.join(sep)}。`) : null,
  ].filter((line): line is string => line !== null).join(en ? " " : "");
  if (!result) return null;
  return setMessageControl(ctx, lineId, { kind: "passed", submission_ids: [...ids], message_id: lineId, offer: [], result });
}

/** Why a card no longer waits on you, as it then reads in place of its buttons. */
type LetGo =
  | { reason: "superseded"; by: "submission" | "board" | "complaint" }
  | { reason: "checks_failed"; lines: readonly string[] }
  | { reason: "said_more"; bot: string }
  | { reason: "approved" | "replaced" };

function letGoLine(ctx: StoreContext, why: LetGo): string {
  const en = localeOf(ctx) === "en";
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
    case "said_more":
      return en ? `You said more about it, so this waits until ${why.bot} is done with that.` : `你又说了这件事，等${why.bot}按你说的做完再问你。`;
    case "approved":
      return en ? "Approved." : "已放行。";
    case "replaced":
      return en ? "A newer card about this hand-over replaced this one." : "这份交付换了一张新卡片来问。";
  }
}

/** A card about a submission that no longer waits on you: its buttons go, it says why, its notification resolves. */
export function letGoOfCard(ctx: StoreContext, messageId: string, why: LetGo): void {
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

export type ReviewCardAction = "confirm_check" | "confirm_item" | "remove_item" | "approve" | "reject";
export const REVIEW_CARD_ACTIONS: readonly ReviewCardAction[] = ["confirm_check", "confirm_item", "remove_item", "approve", "reject"];

/** The approve/reject card's own record of the outcome, shown in place of the generic 已放行/已退回 label when it differs from the button pressed. */
export function markApprovalCard(ctx: StoreContext, messageId: string, outcome: "approve" | "reject", failingLines: readonly string[]): void {
  let control: Message["control"];
  try {
    control = getMessage(ctx, messageId).control;
  } catch {
    return;
  }
  if (control?.kind !== "review_item") return;
  const en = localeOf(ctx) === "en";
  const result = outcome === "reject"
    ? (en ? `Its checks failed, so it was sent back${failingLines.length > 0 ? `: ${failingLines.join("; ")}` : "."}`
      : `检查没过，已退回${failingLines.length > 0 ? `：${failingLines.join("；")}` : "。"}`)
    : undefined;
  setMessageControl(ctx, messageId, { ...control, offer: [], acted: [outcome], ...(result ? { result } : {}) });
  updateNotificationActionState(ctx, `review_item:${messageId}`, "resolved", outcome, true);
}
