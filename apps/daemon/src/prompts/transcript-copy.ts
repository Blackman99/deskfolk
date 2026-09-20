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
