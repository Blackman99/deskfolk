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
  no_model: { zh: "没有可用的模型", en: "No model is configured" },
  stuck: { zh: "卡住了，很久没有任何进展", en: "It stopped making progress" },
  crashed: { zh: "运行时出错", en: "The runtime errored" },
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

export function completionFailBody(locale: Locale, kind: FailKind): string {
  const reason = FAIL_REASON[kind][locale];
  return locale === "en" ? COMPLETION_FAIL.en(reason) : COMPLETION_FAIL.zh(reason);
}

/** The system line a check-back wakes a Bot with: the note it left itself, marked as such. */
export function checkBackNoteBody(locale: Locale, note: string): string {
  return locale === "en" ? `Check-back: ${note}` : `回看：${note}`;
}

/** How much of the direct's last line a report-back quotes. */
const REPORT_BACK_EXCERPT = 200;

/**
 * The note a quiet Bot↔Bot direct calls its opener back with, behind the check-back mark: who it
 * was with, the last word when the other Bot said anything, and to report before moving on.
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
  const flat = input.last.body.replace(/\s+/g, " ").trim();
  const points = [...flat];
  const excerpt = points.length > REPORT_BACK_EXCERPT ? `${points.slice(0, REPORT_BACK_EXCERPT).join("")}…` : flat;
  if (en) {
    const whose = input.last.mine ? "yours" : `${input.peer}'s`;
    return `Your direct with ${input.peer} has gone quiet; the last word was ${whose}: "${excerpt}". Report here how it came out, then carry on with the next step.`;
  }
  const who = input.last.mine ? "你" : input.peer;
  return `你和${input.peer}的私聊静下来了，最后一条是${who}说的：「${excerpt}」。先在这里交代这次私聊的结果，再接着推进下一步。`;
}

/**
 * The system line a routine fires with, under its Bot: the app woke it, so the instruction never
 * reads as something you just said.
 */
export function routineFireBody(locale: Locale, title: string, instruction: string): string {
  return locale === "en" ? `Routine "${title}": ${instruction}` : `日程「${title}」：${instruction}`;
}

/** One ticket of a plan that is still to do or in progress, as a plan call-back names it. */
export type OpenTicketLine = { seq: number; title: string; status: "todo" | "doing"; worker: string | null };

/** One failing acceptance check, as a plan call-back or a stalled notice names it. */
export type FailingCheckLine = { item: string; what: string; detail: string; output: string | null };

function ticketLine(locale: Locale, ticket: OpenTicketLine, withWorker = true): string {
  const number = String(ticket.seq).padStart(2, "0");
  if (locale === "en") {
    const state = ticket.status === "todo" ? "to do" : "in progress";
    const who = withWorker ? (ticket.worker ? `, ${ticket.worker}` : ", nobody on it") : "";
    return `${number} "${ticket.title}" (${state}${who})`;
  }
  const state = ticket.status === "todo" ? "待做" : "进行中";
  const who = withWorker ? (ticket.worker ? `，${ticket.worker}` : "，还没人接") : "";
  return `${number}《${ticket.title}》（${state}${who}）`;
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
        ? `The plan has gone quiet with tickets still open: ${list.join("; ")}.${yours} Finish it and hand it over — with how to start it, if it is something to run — or say plainly where it is stuck and what you need from whom. A ticket that is someone else's: name them.`
        : `规划静下来了，还有任务没收口：${list.join("；")}。${yours}接着做完并交出（要运行的东西附上启动方式），做不了就直说卡在哪、需要谁做什么；属于别人的任务点名交给对方。`,
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

/**
 * The line the plan's session gets when a call-back brought nothing new: the plan has stopped with
 * tickets open, or its checks still failing, and picking it up is now yours. A system line, so it
 * wakes nobody.
 */
export function stalledPlanBody(
  locale: Locale,
  input: { open: readonly OpenTicketLine[]; called: string; failing?: readonly FailingCheckLine[] },
): string {
  const en = locale === "en";
  const failing = input.failing ?? [];
  const parts: string[] = [];
  if (input.open.length > 0) {
    const list = input.open.map((ticket) => ticketLine(locale, ticket));
    parts.push(
      en
        ? `This plan has stopped with ${input.open.length} ticket${input.open.length === 1 ? "" : "s"} still open: ${list.join("; ")}. ${input.called} was called back once and nothing new was handed over since. To carry on, @ whoever should pick it up; or mark the tickets on the flow board.`
        : `这件事停下了，还有 ${input.open.length} 个任务没收口：${list.join("；")}。已经叫过${input.called}一次，之后没有新的交付。要继续就 @ 该接手的 Bot，或者在流程图里改任务状态。`,
    );
  } else {
    parts.push(
      en
        ? `This plan has stopped: ${input.called} was called back once over its failing checks, and nothing changed since. To carry on, @ whoever should pick it up; or change the checks on the flow board.`
        : `这件事停下了：为验收检查没过叫过${input.called}一次，之后没有变化。要继续就 @ 该接手的 Bot，或者在流程图里改检查。`,
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
    /** The Bot `reconcilePlan` just called back to a quiet plan, when it booked one. */
    nudgedBot: string | null;
    /** Turns of this plan waiting on you; they are not in `working`. */
    waiting?: readonly StatusWaitingLine[];
    /** Check-backs booked in this plan, not rung yet. */
    checkBacks?: readonly StatusCheckBackLine[];
  },
): string {
  const en = locale === "en";
  const lines: string[] = [];
  lines.push(
    en
      ? `Plan: ${input.plan.title} (${STATUS_PLAN_LABEL[input.plan.status].en})`
      : `这件事：${input.plan.title}（${STATUS_PLAN_LABEL[input.plan.status].zh}）`,
  );
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
  if (input.nudgedBot) {
    lines.push(en ? `${input.nudgedBot} has been nudged to carry on.` : `已叫 ${input.nudgedBot} 接着做。`);
  }
  return lines.join("\n");
}
