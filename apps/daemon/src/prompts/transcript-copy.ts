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
