/** The approval card a hand-over puts on your line, and letting go of it. */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { sampleSums, sampleSumsLines, yoursToApprove } from "./large-jobs";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import type { UnbackedItem } from "./submission-evidence";
import { cardPlace, checkLines, fileNames, producerIsBot, truncatedAnswer, type AwaitingYou, type ReviewRecord, type Submission } from "./submission-rows";
import { stagedTicket } from "./ticket-stage";

/**
 * The required items nothing backs, as the 放行 card lists them: what each is, why it must be judged,
 * what the app measured on it. One that only repeats the job's or the ticket's name, which the
 * card's first line already gives, with nothing measured on it, is left out of the words.
 */
function unbackedLines(items: readonly UnbackedItem[], titles: readonly string[], en: boolean): string[] {
  const named = new Set(titles.map((title) => title.trim()));
  const shown = items.filter((item) => item.checks.length > 0 || !named.has(item.quote.trim()));
  if (shown.length === 0) return [];
  return [en ? "Approving it counts these as met:" : "放行就算这几条做到了：", ...shown.map((item) => {
    const measured = item.checks.length > 0 ? (en ? ` — measured: ${checkLines(item.checks, "en").join("; ")}` : `——应用量到：${checkLines(item.checks, "zh").join("；")}`) : "";
    const why = item.reasons.includes("raised") ? (en ? `you said it ${item.times_raised} times` : `你说过 ${item.times_raised} 次`) : (en ? "about the picture" : "关于画面");
    return en ? `- "${item.quote}" (${why})${measured}` : `- 「${item.quote}」（${why}）${measured}`;
  })];
}

/** The reviewer's verdict, for a card that shows it rather than acting on it: name, model, whether it ran on the producer's own, and its notes. */
/** Whether both the reviewer's and the producer's models are known: otherwise "the same model" is only how it is counted. */
function modelKnown(review: ReviewRecord, submission: Pick<Submission, "model">): boolean {
  return Boolean(review.reviewer_model && submission.model);
}

/**
 * The reviewer's word on the card, and why it is not enough on its own, in plain words: a reviewer on
 * the producer's own model judging its own kind of work, or one that gave no grounds on what you
 * asked. "设计师（fixture，和生产者同模型）判了通过" read as jargon (2026-10-03).
 */
function reviewerVerdictLine(ctx: StoreContext, review: ReviewRecord, submission: Pick<Submission, "model" | "origin">, en: boolean): string {
  const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(review.reviewer_bot_id)?.name ?? review.reviewer_bot_id;
  const model = review.reviewer_model ?? (en ? "an unknown model" : "未知模型");
  const notes = [review.note, ...review.verdicts.map((v) => `${v.requirement_id}: ${v.verdict}${v.evidence.length > 0 ? ` (${v.evidence.join("; ")})` : ""}`)]
    .filter((line): line is string => Boolean(line));
  // A note that ends its own sentence is not given a second full stop (「……12 个字。。」).
  const closed = (text: string, stop: string) => /[。．.!！?？]$/.test(text) ? text : `${text}${stop}`;
  const said = en
    ? closed(`${name} reviewed it and judged it ${review.outcome === "approve" ? "good" : "not good"}${notes.length > 0 ? `: ${notes.join("; ")}` : ""}`, ".")
    : closed(`${name}审过了，判${review.outcome === "approve" ? "通过" : "不通过"}${notes.length > 0 ? `：${notes.join("；")}` : ""}`, "。");
  // An answer's words or the organizer's reading are the card's reason already (its first line says so).
  if (submission.origin === "answer" || submission.origin === "organizer") return said;
  const why = review.same_model
    ? modelKnown(review, submission)
      ? (en ? ` But it runs on the same model as the Bot that made it (${model}), and a model passing its own kind of work does not count, so it is yours to decide.`
        : `但它和做的 Bot 用的是同一个模型（${model}），同一个模型审自己的活不算数，所以要你来定。`)
      : (en ? " But one of the two models is not known, so it counts as the same model, and it is yours to decide."
        : "但有一方的模型不明，按同一个模型算，所以要你来定。")
    : (en ? " But it gave no grounds on what you asked for, so it is yours to decide." : "但它没在你的要求上给出依据，所以要你来定。");
  return `${said}${why}`;
}

/**
 * The one card a hand-over waits on you with: 放行 or 退回 (ADR 0046, ADR 0058 §13). Shown for an
 * `answer` or `organizer` submission, reviewed or not; for a `submit`/`implicit` file hand-over no
 * active (confirmed) gate backs, when no reviewer judged it, or when the reviewer ran on the
 * producer's own model or gave no evidence; and for one with required items nothing backs (`items`:
 * said twice or more, or about the picture), which it lists with what the app measured on them —
 * 放行 takes them as met. Until 2026-10-07 those items had a card of their own first, and each item
 * read after it another: 「生成一张猫坐在阳台的图片」 asked three times in 26 s, the last time to 放行.
 * `review`, when given, is the reviewer's own clean approve — shown on the card, not acted on; your
 * two buttons are the submission's own outcome (`approve`, `reject` — `answerReviewCard`). `backed`:
 * a gate of yours passed, so only the items are yours to decide.
 */
export function askApproval(ctx: StoreContext, submission: Submission, now: string, review: ReviewRecord | null = null,
  opts: { items?: readonly UnbackedItem[]; backed?: boolean } = {}): Message | null {
  const previous = submission.awaiting;
  // One card per hand-over: put up again only after the last one came down for a line of yours (`held`).
  if (previous?.kind === "approval" && !previous.held) return null;
  if (previous?.message_id) letGoOfCard(ctx, previous.message_id, { reason: "replaced" });
  const items = opts.items ?? [];
  const requirementIds = items.map((item) => item.requirement_id).sort();
  const plan = ctx.db.query<{ session_id: string | null; title: string }, [string]>("SELECT session_id, title FROM tasks WHERE id = ?").get(submission.task_id);
  const ticket = stagedTicket(ctx, submission.ticket_id);
  let message: Message | null = null;
  if (plan?.session_id) {
    const en = localeOf(ctx) === "en";
    const number = String(ticket.seq).padStart(2, "0");
    const verdict = review ? `\n${reviewerVerdictLine(ctx, review, submission, en)}` : "";
    const yours = submission.origin === "answer" || submission.origin === "organizer" ? null : yoursToApprove(ctx, submission.ticket_id);
    const head = yours === "sample"
      ? (en ? `The sample of ${plan.title} is in: ticket ${number} "${ticket.title}" (${fileNames(submission, en)}). It sets the standard for the rest: once you approve it, they start, and each is compared with it when handed over.\n${sampleSumsLines(sampleSums(ctx, ticket.id), "en")}`
        : `${plan.title} 的样片交上来了：任务 ${number}「${ticket.title}」（${fileNames(submission, en)}）。它定下其余各件的水准：放行后它们才开工，交上来时拿它对照。\n${sampleSumsLines(sampleSums(ctx, ticket.id), "zh")}`)
      : yours === "last"
        ? (en ? `The last part of ${plan.title} is in: ticket ${number} "${ticket.title}" (${fileNames(submission, en)}). Approving it delivers the job.`
          : `${plan.title} 的最后一件交上来了：任务 ${number}「${ticket.title}」（${fileNames(submission, en)}）。放行后整件事就交付了。`)
      : submission.origin === "answer"
      ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: the words themselves — "${truncatedAnswer(submission.content ?? "")}"`
        : `${plan.title} 的任务 ${number}「${ticket.title}」：交的话本身——「${truncatedAnswer(submission.content ?? "")}」`)
      : submission.origin === "organizer"
        ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title}: the organizer read this as done.`
          : `${plan.title} 的任务 ${number}「${ticket.title}」：整理跳认为这张任务做完了。`)
        : review
          ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title} is in (${fileNames(submission, en)}), and it is yours to decide.`
            : `${plan.title} 的任务 ${number}「${ticket.title}」交上来了（${fileNames(submission, en)}），等你定。`)
          : opts.backed && items.length > 0
            ? (en ? `Ticket ${number} "${ticket.title}" of ${plan.title} is in (${fileNames(submission, en)}). The checks you confirmed passed, but they do not cover what is below, so it is yours to decide.`
              : `${plan.title} 的任务 ${number}「${ticket.title}」交上来了（${fileNames(submission, en)}）。你确认过的检查都过了，但它们管不到下面这几条，所以要你来定。`)
            : (en ? `Ticket ${number} "${ticket.title}" of ${plan.title} is in (${fileNames(submission, en)}). Nobody reviews it and no check you confirmed stands behind it, so it is yours to decide.`
              : `${plan.title} 的任务 ${number}「${ticket.title}」交上来了（${fileNames(submission, en)}）。没有审查者，也没有你确认过的检查替你把关，所以要你来定。`);
    const tail = en ? "Have a look, then approve it or send it back." : "看过之后，放行或者退回。";
    // Put to you again after its card came down for a line of yours: why the same hand-over is back.
    const bot = previous?.held ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(submission.bot_id)?.name ?? submission.bot_id : null;
    const again = bot ? [en ? `${bot} handed over nothing new this time.` : `${bot}这次没交新的一版。`] : [];
    const body = [...again, head + verdict, ...unbackedLines(items, [plan.title, ticket.title], en), tail].join("\n");
    const place = cardPlace(ctx, submission, plan.session_id);
    const isDirect = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(place)?.kind === "direct"
      && producerIsBot(ctx, submission);
    // A file hand-over's card links the files themselves, to open and look.
    const paths = submission.origin !== "answer" && submission.origin !== "organizer" ? submission.artifacts.map((a) => a.path) : undefined;
    message = insertMessage(ctx, {
      sessionId: place, kind: "system", author: isDirect ? submission.bot_id : USER_MEMBER, hiddenFromBots: true, body,
      ...(paths && paths.length > 0 ? { paths } : {}),
      control: { kind: "review_item", submission_id: submission.id, task_id: submission.task_id, ticket_id: submission.ticket_id,
        requirement_ids: requirementIds, check_ids: [], offer: ["approve", "reject"] },
    });
    createNotification(ctx, { semantic_key: `review_item:${message.id}`, kind: "ask", session_id: place, message_id: message.id, action_state: "open" });
  }
  const awaiting: AwaitingYou = { requirement_ids: requirementIds, check_ids: [], message_id: message?.id ?? null, review, at: now, kind: "approval" };
  ctx.db.run("UPDATE submissions SET awaiting = ?, updated_at = ? WHERE id = ?", [JSON.stringify(awaiting), now, submission.id]);
  return message;
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
