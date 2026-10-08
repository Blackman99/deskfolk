import type { Locale, PlanStatus, TicketStatus } from "@real-bot/protocol";

export const COMPLETION_FAIL = {
  zh: (reason: string) => `这一轮没写完：${reason}`,
  en: (reason: string) => `This turn did not finish: ${reason}`,
} as const;

export const FAIL_REASON = {
  unreachable: { zh: "连不上端点", en: "Couldn't reach the endpoint" },
  first_byte: { zh: "等不到第一条回复", en: "No first reply arrived" },
  stalled: { zh: "回复中途没有下文了", en: "The reply stalled mid-stream" },
  busy: { zh: "端点忙", en: "Endpoint is busy" },
  refused: { zh: "端点拒绝了这次补全", en: "Endpoint refused this completion" },
  endpoint_error: { zh: "端点出错", en: "Endpoint error" },
  incomplete: { zh: "回复不完整", en: "Incomplete reply" },
  repeat: { zh: "回复一直在重复同一句", en: "The reply kept repeating itself" },
  declined: { zh: "模型拒答了", en: "The model declined to answer" },
  truncated: { zh: "回复写到输出上限，接着写还是没写完", en: "The reply hit the output limit, even after carrying on" },
  overtime: { zh: "回复写了太久，超过了时间上限", en: "The reply ran past its time limit" },
  no_model: { zh: "没有可用的模型", en: "No model is configured" },
  // ADR 0067: a local server cuts a prompt past its window and answers anyway; the turn fails here instead.
  context_full: {
    zh: "提示词超出了模型的上下文窗口，把模型服务的上下文调大（如 Ollama 的 OLLAMA_CONTEXT_LENGTH）或换上下文更长的模型",
    en: "The prompt is larger than the model's context window; raise the model server's context (e.g. Ollama's OLLAMA_CONTEXT_LENGTH) or pick a model with a longer one",
  },
  stuck: { zh: "卡住了，很久没有任何进展", en: "It stopped making progress" },
  crashed: { zh: "运行时出错", en: "The runtime errored" },
  // A Claude Agent turn's own (ADR 0061): about the user's Claude Code, not an endpoint or a model.
  agent_missing: { zh: "这台电脑上没找到 Claude Code（claude）", en: "Claude Code (claude) was not found on this computer" },
  agent_signed_out: { zh: "本机的 Claude Code 没通过认证：在终端里运行 claude，确认它能用后再继续", en: "Your Claude Code could not authenticate: run claude in a terminal, check it works, then go on" },
  agent_limit: { zh: "Claude 的用量额度用完了", en: "Claude usage limit reached" },
  agent_exited: { zh: "Claude Code 中途退出了", en: "Claude Code exited mid-turn" },
} as const;

export type FailKind = keyof typeof FAIL_REASON;

/** Transcript note when a Bot's `@token` matched nobody present. */
export function unknownMentionBody(locale: Locale, tokens: string[], members: string[]): string {
  if (locale === "en") {
    const list = tokens.map((token) => `@${token}`).join(", ");
    const verb = tokens.length === 1 ? "does" : "do";
    const who = members.length > 0 ? members.join(", ") : "(none)";
    return `${list} ${verb} not match any member here. Members: ${who}. Mention people by their exact full name.`;
  }
  const list = tokens.map((token) => `@${token}`).join("、");
  const who = members.length > 0 ? members.join("、") : "（无）";
  return `${list} 没有匹配到群成员。在场：${who}。点名请逐字写全名。`;
}

/**
 * The numbers behind a `context_full` failure (ADR 0067): about how big this step's prompt is, what
 * the endpoint read of it when it cut it, and the window the server runs with, when it said.
 */
export function contextFullDetail(locale: Locale, cut: { estimated: number; read?: number; window?: number } | undefined): string | null {
  if (!cut) return null;
  const n = (value: number) => value.toLocaleString("en-US");
  const en = locale === "en";
  const parts = [en ? `this step is about ${n(cut.estimated)} tokens` : `这一步约 ${n(cut.estimated)} token`];
  if (cut.read) parts.push(en ? `the endpoint read only ${n(cut.read)} of them` : `端点只读进了 ${n(cut.read)} token`);
  if (cut.window) parts.push(en ? `its window is ${n(cut.window)}` : `窗口是 ${n(cut.window)}`);
  return parts.join(en ? "; " : "，");
}

/** `detail` says more where the kind alone cannot, e.g. when a usage limit resets. */
export function completionFailBody(locale: Locale, kind: FailKind, detail?: string | null): string {
  const base = FAIL_REASON[kind][locale];
  const reason = detail ? (locale === "en" ? `${base} (${detail})` : `${base}（${detail}）`) : base;
  return locale === "en" ? COMPLETION_FAIL.en(reason) : COMPLETION_FAIL.zh(reason);
}

/** The system line a check-back wakes a Bot with: the note it left itself, marked as such. */
export function checkBackNoteBody(locale: Locale, note: string): string {
  return locale === "en" ? `Check-back: ${note}` : `回看：${note}`;
}

/** How much of the direct's last line a report-back quotes. */
const REPORT_BACK_EXCERPT = 200;

/** One line of someone else's words, whitespace folded, cut at `max` code points with an ellipsis. */
function excerptOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max).join("")}…` : flat;
}

/**
 * The note a quiet Bot↔Bot direct calls its opener back with, behind the check-back mark: who it
 * was with, the last word when the other Bot said anything, and to report how it came out.
 */
export function reportBackNote(
  locale: Locale,
  input: { peer: string; last: { mine: boolean; body: string } | null; peerSpoke: boolean },
): string {
  const en = locale === "en";
  if (!input.peerSpoke || !input.last) {
    return en
      ? `Your direct with ${input.peer} has gone quiet; ${input.peer} did not answer your last message. Say here where things stand, then decide the next step.`
      : `你和${input.peer}的私聊静下来了，${input.peer}没有回你最后那条。先在这里交代现状，再决定下一步。`;
  }
  const excerpt = excerptOf(input.last.body, REPORT_BACK_EXCERPT);
  if (en) {
    const whose = input.last.mine ? "yours" : `${input.peer}'s`;
    return `Your direct with ${input.peer} has gone quiet; the last word was ${whose}: "${excerpt}". Report here how it came out.`;
  }
  const who = input.last.mine ? "你" : input.peer;
  return `你和${input.peer}的私聊静下来了，最后一条是${who}说的：「${excerpt}」。在这里交代这次私聊的结果。`;
}

/**
 * The system line a routine fires with, under its Bot: the app woke it, so the instruction never
 * reads as something you just said.
 */
export function routineFireBody(locale: Locale, title: string, instruction: string): string {
  return locale === "en" ? `Routine "${title}": ${instruction}` : `日程「${title}」：${instruction}`;
}

/** One ticket of a plan not yet closed out (to do, in progress or awaiting review), as a plan call-back names it. */
export type OpenTicketLine = { seq: number; title: string; status: "todo" | "doing" | "review"; worker: string | null };

const TICKET_STATE: Record<OpenTicketLine["status"], { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  doing: { zh: "进行中", en: "in progress" },
  review: { zh: "待验收", en: "awaiting review" },
};

/** One failing acceptance check, as a plan call-back or a stalled notice names it. */
export type FailingCheckLine = { item: string; what: string; detail: string; output: string | null };

function ticketLine(locale: Locale, ticket: OpenTicketLine, withWorker = true): string {
  const number = String(ticket.seq).padStart(2, "0");
  if (locale === "en") {
    const who = withWorker ? (ticket.worker ? `, ${ticket.worker}` : ", nobody on it") : "";
    return `${number} "${ticket.title}" (${TICKET_STATE[ticket.status].en}${who})`;
  }
  const who = withWorker ? (ticket.worker ? `，${ticket.worker}` : "，还没人接") : "";
  return `${number}《${ticket.title}》（${TICKET_STATE[ticket.status].zh}${who}）`;
}

/** Code points of a failing check's captured output a nudge or a stalled notice keeps — the tail, not the head. */
const FAILING_CHECK_OUTPUT_MAX = 400;

function tailCodePoints(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

function failingCheckLines(locale: Locale, failing: readonly FailingCheckLine[]): string {
  return failing
    .map((check) => {
      const output = check.output ? tailCodePoints(check.output, FAILING_CHECK_OUTPUT_MAX) : "";
      return locale === "en"
        ? `- "${check.item}" — ${check.what}: ${check.detail}${output ? `\n  ${output}` : ""}`
        : `- 「${check.item}」——${check.what}：${check.detail}${output ? `\n  ${output}` : ""}`;
    })
    .join("\n");
}

/**
 * The note the app calls a Bot back to a quiet plan with, behind the check-back mark: which
 * tickets are still open, which one is this Bot's, and what a useful answer is — finish and hand
 * it over, or say where it is stuck; a ticket that is someone else's goes to them by name. Failing
 * checks (the app's own evidence, run on this machine) are named too, with the guidance to fix the
 * deliverable rather than the check.
 */
export function planNudgeNote(
  locale: Locale,
  input: { open: readonly OpenTicketLine[]; mine: OpenTicketLine | null; failing?: readonly FailingCheckLine[] },
): string {
  const en = locale === "en";
  const failing = input.failing ?? [];
  const parts: string[] = [];
  if (input.open.length > 0) {
    const list = input.open.map((ticket) => ticketLine(locale, ticket));
    const yours = input.mine ? (en ? ` Yours is ${ticketLine(locale, input.mine, false)}.` : `其中 ${ticketLine(locale, input.mine, false)} 是你的。`) : "";
    parts.push(
      en
        ? `The plan has gone quiet with tickets still open: ${list.join("; ")}.${yours} A useful answer is either handing it over — with how to start it, if it is something to run — or saying plainly where it is stuck and what you need from whom. A ticket that is someone else's: name them.`
        : `规划静下来了，还有任务没收口：${list.join("；")}。${yours}有用的回应是做完并交出（要运行的东西附上启动方式），或者直说卡在哪、需要谁做什么；属于别人的任务点名交给对方。`,
    );
  }
  if (failing.length > 0) {
    parts.push(
      en
        ? `There are also failing acceptance checks (the app ran these itself, on this machine):\n${failingCheckLines(locale, failing)}\nFix the deliverable, not the check: do not weaken a test, loosen an assertion, or delete what is being checked just to pass it; run the same command yourself to confirm before you hand it over again. If a check itself looks wrong, say so plainly — the user changes it on the flow board.`
        : `还有验收检查没过（应用自己在本机跑的）：\n${failingCheckLines(locale, failing)}\n修交付物，不是改检查：别为了过检查去改测试、放宽断言或删掉被检查的内容；自己跑一遍同一条命令确认再交出。觉得检查本身写错了就直说，由用户在流程图里改。`,
    );
  }
  return parts.join("\n\n");
}

/** Tickets awaiting review a plan call-back names; the rest are only counted. */
export const PLAN_LEFT_REVIEW_MAX = 6;

/**
 * The note the app calls a Bot back to a quiet group plan with once everything is handed over but
 * the plan's progress still lists work not done: what a useful answer is comes first, then the
 * tickets awaiting review. The work not done is not repeated: the situation block shows it under
 * Progress, and the organizer's words copied into the Bot's reminder to itself would read as the
 * Bot's own instruction.
 */
export function planLeftNote(locale: Locale, input: { review: readonly OpenTicketLine[] }): string {
  const shown = input.review.slice(0, PLAN_LEFT_REVIEW_MAX).map((ticket) => ticketLine(locale, ticket));
  const more = input.review.length - shown.length;
  if (locale === "en") {
    const review = shown.length > 0 ? ` Awaiting review: ${shown.join("; ")}${more > 0 ? `; ${more} more` : ""}.` : "";
    return `The plan has been quiet for a while with nothing to do or in progress, yet Progress in your situation still lists work not done or held up. What's useful next: check each ticket awaiting review against its acceptance and give the commands you ran and what they showed; do not pass anyone's work for them, nor your own; hand what is not done yet to a Bot who can take it, by name; for what is held up, the situation records who set that pause or freeze; ask the user what needs the user's decision or what only the user can give. If none of that is possible, say plainly where it is stuck and what you need from whom.${review}`;
  }
  const review = shown.length > 0 ? `待验收：${shown.join("；")}${more > 0 ? `；还有 ${more} 个` : ""}。` : "";
  return `规划静下来一阵了：没有待做或进行中的任务，局面「进展」里却还记着没做完或卡住的。接下来：待验收的照它的验收核对，附上跑过的命令和结果，不替别人宣布通过，自己交的也不自己判；还没做的，点名交给接得了的 Bot；卡住的，局面里记着谁定的暂停或冻结；要用户拿主意、或只有用户给得了的，直接问用户。哪样都做不了，就直说卡在哪、需要谁做什么。${review}`;
}

/** A ticket or a plan as the supervisor's lines name it (ADR 0045): 任务 03《Shot 11》, or 规划「EP01」. */
export function supervisorJobLabel(locale: Locale, input: { plan: string; ticket: { seq: number; title: string } | null }): string {
  if (input.ticket) {
    const number = String(input.ticket.seq).padStart(2, "0");
    return locale === "en" ? `ticket ${number} "${input.ticket.title}"` : `任务 ${number}《${input.ticket.title}》`;
  }
  return locale === "en" ? `the plan "${input.plan}"` : `规划「${input.plan}」`;
}

/**
 * The line the supervisor wakes a Bot with (ADR 0045), read only by the turn it opens: what is
 * true of the job now, and the same choice the ending contract offers — go on, or end the turn
 * saying who it waits for or what blocks it. No pressure, no guess about why it went quiet.
 * - `orphan`: a ticket whose ball is with this Bot (its owner, the plan's lead, or the recipient of
 *   an open request) has had no live segment, wait or queued line for `quietMinutes`.
 * - `wait_invalid`: what it was waiting for is gone (the request was cancelled, or the other side's
 *   work closed).
 * - `resume`: its last segment did not end properly (`reason`), and this is automatic pick-up number
 *   `attempt` of at most three an hour.
 */
export function supervisorWakeNote(
  locale: Locale,
  input:
    | { kind: "orphan"; job: string; role: "owner" | "lead" | "delegation" | "reviewer"; ask?: string | null; submissionId?: string | null; quietMinutes: number }
    | { kind: "wait_invalid"; job: string }
    | { kind: "resume"; job: string; reason: "interrupted" | "failed" | "contract_budget" | "lost_segment"; lastStep: string | null; attempt: number },
): string {
  const en = locale === "en";
  const choice = en
    ? "Carry on, or call end_turn saying who you are waiting for or what blocks you."
    : "接着做，或者用 end_turn 说明在等谁、卡在哪。";
  if (input.kind === "orphan") {
    const role = input.role === "owner"
      ? (en ? "You own it." : "你是它的负责人。")
      : input.role === "lead"
        ? (en ? "It has no owner the app can call, and you lead the plan." : "它没有能叫到的负责人，你是这件事的负责人。")
        : input.role === "reviewer"
          ? (en ? `You review it, and submission ${input.submissionId ?? ""} is waiting for your review: judge it with review.`
            : `你是它的审查者，交付 ${input.submissionId ?? ""} 在等你审：用 review 给结论。`)
        : (en ? `You still owe a reply to a request on it${input.ask ? `: "${input.ask}"` : ""}.` : `你还欠这张任务上一个委派的回复${input.ask ? `：「${input.ask}」` : ""}。`);
    return en
      ? `(App) ${input.job} is still open, and for ${input.quietMinutes} minutes nothing has been working on it: no live segment, no wait, no queued line. ${role} ${choice}`
      : `（应用）${input.job}还没收口，已经 ${input.quietMinutes} 分钟没有进行中的执行段、等待或排着的收件。${role}${choice}`;
  }
  if (input.kind === "wait_invalid") {
    return en
      ? `(App) What you were waiting for on ${input.job} is gone: the request was cancelled or the other side's work closed, so that wait no longer stands. Look at where things are now. ${choice}`
      : `（应用）你在${input.job}上等的东西已经不在了：委派被取消，或者对方的工作已经关闭，这一等不再成立。先看看现在的局面，${choice}`;
  }
  const reason = {
    interrupted: { zh: "被中断了", en: "was interrupted" },
    failed: { zh: "没写完就失败了", en: "failed before it finished" },
    contract_budget: { zh: "两次没能按结束的约定收尾", en: "twice failed to end the way the ending contract asks" },
    lost_segment: { zh: "没有正常结束", en: "did not end properly" },
  }[input.reason];
  const step = input.lastStep ? (en ? ` Its last step: ${input.lastStep}.` : `最后一步：${input.lastStep}。`) : "";
  return en
    ? `(App) Your last segment on ${input.job} ${reason.en}.${step} This is automatic pick-up ${input.attempt} of at most 3 an hour. Do not repeat an external call whose outcome you do not know; check it first. ${choice}`
    : `（应用）你在${input.job}上的上一段${reason.zh}。${step}这是第 ${input.attempt} 次自动接着做（每小时最多 3 次）。结果不明的外部调用不要重做，先核实。${choice}`;
}

/** Items of the plan's progress a stalled line quotes, and how long each may run. */
export const STALLED_LEFT_ITEMS = 3;
export const STALLED_LEFT_ITEM_MAX = 60;

/**
 * The review the notification quotes when the app stops calling Bots back: the plan has stopped with
 * tickets open, its checks still failing, or everything handed over while its progress still lists
 * work not done or held up, and picking it up is now yours. `capped` is how many call-backs went out
 * since you last said something in the plan when that budget is what stopped the next one;
 * otherwise the last call-back moved nothing. Kept on a line only the woken turn would read, so the
 * conversation never shows it and it wakes nobody.
 */
export function stalledPlanBody(
  locale: Locale,
  input: {
    open: readonly OpenTicketLine[];
    called: string;
    failing?: readonly FailingCheckLine[];
    left?: readonly string[];
    capped?: number | null;
  },
): string {
  const en = locale === "en";
  const failing = input.failing ?? [];
  const left = input.left ?? [];
  const capped = input.capped
    ? en
      ? `Bots have been called back ${input.capped} times since you last spoke in this plan, most recently ${input.called}; there will be no more.`
      : `你上次在这件事里说话之后已经叫回 ${input.capped} 次，最近一次叫的是${input.called}，不再叫了。`
    : null;
  const parts: string[] = [];
  if (input.open.length > 0) {
    const list = input.open.map((ticket) => ticketLine(locale, ticket));
    parts.push(
      en
        ? `This plan has stopped with ${input.open.length} ticket${input.open.length === 1 ? "" : "s"} still open: ${list.join("; ")}. ${capped ?? `${input.called} was called back once and nothing new was handed over since.`} To carry on, @ whoever should pick it up; or mark the tickets on the flow board.`
        : `这件事停下了，还有 ${input.open.length} 个任务没收口：${list.join("；")}。${capped ?? `已经叫过${input.called}一次，之后没有新的交付。`}要继续就 @ 该接手的 Bot，或者在流程图里改任务状态。`,
    );
  } else if (failing.length > 0) {
    parts.push(
      en
        ? `This plan has stopped: ${capped ?? `${input.called} was called back once over its failing checks, and nothing changed since.`} To carry on, @ whoever should pick it up; or change the checks on the flow board.`
        : `这件事停下了：${capped ?? `为验收检查没过叫过${input.called}一次，之后没有变化。`}要继续就 @ 该接手的 Bot，或者在流程图里改检查。`,
    );
  } else {
    const shown = left.slice(0, STALLED_LEFT_ITEMS).map((item) => excerptOf(item, STALLED_LEFT_ITEM_MAX));
    const more = left.length - shown.length;
    parts.push(
      en
        ? `This plan has stopped: nothing is to do or in progress, yet its progress still lists work not done or held up: ${shown.join("; ")}${more > 0 ? ` (${more} more)` : ""}. ${capped ?? `${input.called} was called back once and no ticket has been handed over or closed since.`} To carry on, @ whoever should pick it up; or edit the plan and its tickets on the flow board.`
        : `这件事停下了：没有待做或进行中的任务，进展里还记着没做完或卡住的：${shown.join("；")}${more > 0 ? `（还有 ${more} 条）` : ""}。${capped ?? `已经叫过${input.called}一次，之后没有任务交出或收口。`}要继续就 @ 该接手的 Bot，或者在流程图里改要点和任务。`,
    );
  }
  if (failing.length > 0) {
    parts.push(
      en
        ? `Still failing (the app ran these itself, on this machine):\n${failingCheckLines(locale, failing)}`
        : `还没过的验收检查（应用自己在本机跑的）：\n${failingCheckLines(locale, failing)}`,
    );
  }
  return parts.join("\n\n");
}

const STATUS_PLAN_LABEL: Record<PlanStatus, { zh: string; en: string }> = {
  active: { zh: "进行中", en: "active" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

const STATUS_TICKET_LABEL: Record<TicketStatus, { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  doing: { zh: "进行中", en: "in progress" },
  review: { zh: "待验收", en: "in review" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

/** One live turn on the plan, as `statusQuestionBody` names it. */
export type StatusWorkingLine = {
  bot: string;
  ticket: { seq: number; title: string } | null;
  /** Minutes since the turn started. */
  minutes: number;
  /** The latest `turn_runs` command for this turn, already clipped; null renders as "still thinking". */
  lastStep: string | null;
  /** Set when the turn is running in a session other than the one being asked. */
  elsewhere: string | null;
};

/** One ticket of the plan, in any status — unlike {@link OpenTicketLine}, which is only the open ones. */
export type StatusTicketLine = { seq: number; title: string; status: TicketStatus; worker: string | null };

/** One recently cited file of the plan. */
export type StatusArtifactLine = { path: string; author: string; minutesAgo: number };

/** The plan's acceptance checks, already tallied. */
/**
 * A span of minutes as people say it: minutes under an hour and a half, then hours, then days past
 * two days. A render that has run for 340 minutes reads better as "5 hours".
 */
/** How long ago, as people say it: "刚刚" under a minute, then "N 分钟前" and so on. */
export function agoOf(minutes: number, locale: "zh" | "en"): string {
  if (minutes < 1) return locale === "en" ? "just now" : "刚刚";
  return locale === "en" ? `${spanOf(minutes, "en")} ago` : `${spanOf(minutes, "zh")}前`;
}

export function spanOf(minutes: number, locale: "zh" | "en"): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 90) return locale === "en" ? `${m} min` : `${m} 分钟`;
  const hours = Math.round(m / 60);
  if (hours < 48) return locale === "en" ? `${hours} h` : `${hours} 小时`;
  const days = Math.round(hours / 24);
  return locale === "en" ? `${days} d` : `${days} 天`;
}

export type StatusCheckSummary = {
  passed: number;
  total: number;
  failing: readonly { item: string; detail: string }[];
};

function statusWorkingLine(locale: Locale, line: StatusWorkingLine): string {
  const en = locale === "en";
  const parts: string[] = [line.bot];
  if (line.ticket) {
    const seq = String(line.ticket.seq).padStart(2, "0");
    parts.push(en ? `ticket ${seq} "${line.ticket.title}"` : `任务 ${seq}《${line.ticket.title}》`);
  }
  parts.push(en ? `${spanOf(line.minutes, "en")} in` : `已经 ${spanOf(line.minutes, "zh")}`);
  const step = line.lastStep ?? (en ? "still thinking" : "还在想");
  parts.push(en ? `last step: ${step}` : `最近一步：${step}`);
  if (line.elsewhere) parts.push(en ? `in ${line.elsewhere}` : `在「${line.elsewhere}」`);
  return parts.join(" · ");
}

function statusTicketLine(locale: Locale, ticket: StatusTicketLine): string {
  const en = locale === "en";
  const seq = String(ticket.seq).padStart(2, "0");
  const label = STATUS_TICKET_LABEL[ticket.status][locale];
  const worker = ticket.worker ?? (en ? "nobody on it" : "还没人接");
  return en ? `${seq} "${ticket.title}" ${label} (${worker})` : `${seq}《${ticket.title}》${label}（${worker}）`;
}

function statusArtifactLine(locale: Locale, artifact: StatusArtifactLine): string {
  const en = locale === "en";
  return en
    ? `${artifact.path} — ${artifact.author} (${agoOf(artifact.minutesAgo, "en")})`
    : `${artifact.path} — ${artifact.author}（${agoOf(artifact.minutesAgo, "zh")}）`;
}

/**
 * The app's own answer to a status question (进度询问): built only from rows the store already
 * keeps, so it costs no model call and cannot say anything a Bot did not actually do. Nothing here
 * wakes anyone — it is posted as a `system` line and left out of every Bot's context window.
 */
/** A turn of the plan held up on you: an approval card or a question it asked. */
export type StatusWaitingLine = { bot: string; kind: "approval" | "ask"; text: string; elsewhere: string | null };
/** A check-back a Bot booked in this plan and that has not rung yet. */
export type StatusCheckBackLine = { bot: string; inMinutes: number; note: string };

export function statusQuestionBody(
  locale: Locale,
  input: {
    plan: { title: string; status: PlanStatus };
    /** Every live turn on this plan, in any session. */
    working: readonly StatusWorkingLine[];
    /** Every ticket of the plan, in any status. */
    tickets: readonly StatusTicketLine[];
    /** Up to three of the plan's most recently cited files. */
    artifacts: readonly StatusArtifactLine[];
    checks: StatusCheckSummary;
    /** Minutes since the plan last moved; read only when `working` is empty. */
    idleMinutes: number | null;
    /** Turns of this plan waiting on you; they are not in `working`. */
    waiting?: readonly StatusWaitingLine[];
    /** Check-backs booked in this plan, not rung yet. */
    checkBacks?: readonly StatusCheckBackLine[];
    /** Your stops over the plan or its Bots, and what was found running under one and ended, a line each (control-copy.ts). */
    held?: readonly string[];
  },
): string {
  const en = locale === "en";
  const lines: string[] = [];
  lines.push(
    en
      ? `Plan: ${input.plan.title} (${STATUS_PLAN_LABEL[input.plan.status].en})`
      : `这件事：${input.plan.title}（${STATUS_PLAN_LABEL[input.plan.status].zh}）`,
  );
  lines.push(...(input.held ?? []));
  const waiting = input.waiting ?? [];
  if (waiting.length > 0) {
    // First: in a job of several Bots, what most often holds everything up is you.
    lines.push(en ? "Waiting on you" : "等你处理");
    for (const line of waiting) {
      const what =
        line.kind === "approval" ? (en ? `approve: ${line.text}` : `批准：${line.text}`) : en ? `answer: ${line.text}` : `回答：${line.text}`;
      const where = line.elsewhere ? (en ? ` · in ${line.elsewhere}` : ` · 在「${line.elsewhere}」`) : "";
      lines.push(`- ${line.bot} · ${what}${where}`);
    }
  }
  if (input.working.length > 0) {
    lines.push(en ? "Working now" : "正在做");
    for (const line of input.working) lines.push(`- ${statusWorkingLine(locale, line)}`);
  } else if (waiting.length === 0) {
    lines.push(en ? "Nobody is working on it right now." : "现在没有人在做。");
    if (input.idleMinutes !== null) {
      lines.push(en ? `It last moved ${agoOf(input.idleMinutes, "en")}.` : `最近一次动静：${agoOf(input.idleMinutes, "zh")}。`);
    }
  }
  if (input.tickets.length > 0) {
    lines.push(en ? "Tickets" : "任务");
    for (const ticket of input.tickets) lines.push(`- ${statusTicketLine(locale, ticket)}`);
  }
  const checkBacks = input.checkBacks ?? [];
  if (checkBacks.length > 0) {
    lines.push(en ? "Coming back" : "约好回来看");
    for (const line of checkBacks) {
      const when = line.inMinutes < 1 ? (en ? "any moment" : "马上") : en ? `in ${spanOf(line.inMinutes, "en")}` : `${spanOf(line.inMinutes, "zh")}后`;
      lines.push(en ? `- ${line.bot} · ${when} · ${line.note}` : `- ${line.bot} · ${when} · ${line.note}`);
    }
  }
  if (input.artifacts.length > 0) {
    lines.push(en ? "Recently delivered" : "最近交出");
    for (const artifact of input.artifacts) lines.push(`- ${statusArtifactLine(locale, artifact)}`);
  }
  if (input.checks.total > 0) {
    lines.push(en ? "Acceptance checks" : "验收检查");
    lines.push(
      en ? `${input.checks.passed}/${input.checks.total} passing` : `${input.checks.passed}/${input.checks.total} 通过`,
    );
    for (const failing of input.checks.failing) {
      lines.push(en ? `"${failing.item}": ${failing.detail}` : `「${failing.item}」：${failing.detail}`);
    }
  }
  return lines.join("\n");
}
