import type { Locale } from "@real-bot/protocol";

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

/**
 * The note the app calls a Bot back to a quiet plan with, behind the check-back mark: which
 * tickets are still open, which one is this Bot's, and what a useful answer is — finish and hand
 * it over, or say where it is stuck; a ticket that is someone else's goes to them by name.
 */
export function planNudgeNote(locale: Locale, input: { open: readonly OpenTicketLine[]; mine: OpenTicketLine | null }): string {
  const list = input.open.map((ticket) => ticketLine(locale, ticket));
  if (locale === "en") {
    const yours = input.mine ? ` Yours is ${ticketLine(locale, input.mine, false)}.` : "";
    return `The plan has gone quiet with tickets still open: ${list.join("; ")}.${yours} Finish it and hand it over — with how to start it, if it is something to run — or say plainly where it is stuck and what you need from whom. A ticket that is someone else's: name them.`;
  }
  const yours = input.mine ? `其中 ${ticketLine(locale, input.mine, false)} 是你的。` : "";
  return `规划静下来了，还有任务没收口：${list.join("；")}。${yours}接着做完并交出（要运行的东西附上启动方式），做不了就直说卡在哪、需要谁做什么；属于别人的任务点名交给对方。`;
}

/**
 * The line the plan's session gets when a call-back brought nothing new: the plan has stopped with
 * tickets open, and picking it up is now yours. A system line, so it wakes nobody.
 */
export function stalledPlanBody(locale: Locale, input: { open: readonly OpenTicketLine[]; called: string }): string {
  const list = input.open.map((ticket) => ticketLine(locale, ticket));
  if (locale === "en") {
    return `This plan has stopped with ${input.open.length} ticket${input.open.length === 1 ? "" : "s"} still open: ${list.join("; ")}. ${input.called} was called back once and nothing new was handed over since. To carry on, @ whoever should pick it up; or mark the tickets on the flow board.`;
  }
  return `这件事停下了，还有 ${input.open.length} 个任务没收口：${list.join("；")}。已经叫过${input.called}一次，之后没有新的交付。要继续就 @ 该接手的 Bot，或者在流程图里改任务状态。`;
}
