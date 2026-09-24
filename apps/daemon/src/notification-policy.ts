import {
  parseMentions,
  USER_MEMBER,
  type MessageKind,
  type NotificationKind,
} from "@real-bot/protocol";

export type ClassifyMessageParams = {
  kind: MessageKind;
  body: string;
  author: string;
  sessionKind: "direct" | "group";
  isUserPresent: boolean;
  triggerAuthor?: string | null;
  parentAuthor?: string | null;
  rosterNames: string[];
  isRoutineRoot?: boolean;
};

/**
 * Classifies a Bot message for user-facing notification.
 * Rules per notifications-design.md §4.1:
 * - Direct with user: always user-facing ("routine_result" if routine root, else "reply").
 * - Bot↔Bot direct (user not present): excluded (returns null).
 * - Group: belongs to user if triggered by user or quoting user, UNLESS handing off
 *   work to another bot via mention.
 * - Empty bodies, tool hops, token streams, non-bot kinds: excluded (returns null).
 */
export function classifyBotMessage(params: ClassifyMessageParams): "reply" | "routine_result" | null {
  if (params.kind !== "bot") return null;
  const trimmed = params.body.trim();
  if (!trimmed) return null;

  // If user is not in the session (e.g. Bot↔Bot direct), suppress
  if (!params.isUserPresent) return null;

  if (params.sessionKind === "direct") {
    return params.isRoutineRoot ? "routine_result" : "reply";
  }

  // In a group:
  // Must be triggered by user message or explicitly quote user message
  const triggeredByUser = params.triggerAuthor === USER_MEMBER;
  const quotesUser = params.parentAuthor === USER_MEMBER;
  if (!triggeredByUser && !quotesUser) {
    return null;
  }

  // Exclude messages that hand off work to other bots via mention
  const parse = parseMentions(trimmed, params.rosterNames);
  const mentionsOtherBot = parse.mentions.some(
    (name) =>
      name !== USER_MEMBER &&
      name !== "@everyone" &&
      name !== params.author,
  );
  if (mentionsOtherBot) {
    return null;
  }

  return params.isRoutineRoot ? "routine_result" : "reply";
}

export function truncateCodePoints(str: string, maxPoints: number): string {
  const points = Array.from(str);
  if (points.length <= maxPoints) return str;
  return points.slice(0, maxPoints).join("");
}

export function sanitizeSummaryText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type DisplayRenderParams = {
  kind: NotificationKind;
  botName?: string | null;
  sessionName?: string | null;
  routineTitle?: string | null;
  bodySnippet?: string | null;
  approvalSummary?: string | null;
  failKind?: string | null;
  resolutionReason?: string | null;
};

export function renderNotificationDisplay(params: DisplayRenderParams): {
  title: string;
  summary: string;
} {
  const actor = params.botName || params.sessionName || "Deskfolk";
  switch (params.kind) {
    case "approval": {
      const title = truncateCodePoints(`${actor} · 等你批准`, 80);
      const summary = truncateCodePoints(
        sanitizeSummaryText(params.approvalSummary || "有操作需要你授权"),
        160,
      );
      return { title, summary };
    }
    case "ask": {
      const title = truncateCodePoints(`${actor} · 等你回答`, 80);
      const summary = truncateCodePoints(
        sanitizeSummaryText(params.bodySnippet || "向你提出了一个问题"),
        160,
      );
      return { title, summary };
    }
    case "failure": {
      const title = truncateCodePoints(`${actor} · 本轮未完成`, 80);
      const reason = params.failKind ? `失败原因：${params.failKind}` : "执行失败";
      const summary = truncateCodePoints(sanitizeSummaryText(params.bodySnippet || reason), 160);
      return { title, summary };
    }
    case "interrupted": {
      const title = truncateCodePoints(`${actor} · 任务已中断`, 80);
      const summary = truncateCodePoints("轮次已中断，可点击继续接手", 160);
      return { title, summary };
    }
    case "routine_result": {
      const prefix = params.routineTitle || actor;
      const title = truncateCodePoints(`${prefix} · 日程新结果`, 80);
      const summary = truncateCodePoints(
        sanitizeSummaryText(params.bodySnippet || "日程已产生新结果"),
        160,
      );
      return { title, summary };
    }
    case "reply":
    default: {
      const title = truncateCodePoints(`${actor} · 有新回复`, 80);
      const summary = truncateCodePoints(
        sanitizeSummaryText(params.bodySnippet || "收到来自 Bot 的新消息"),
        160,
      );
      return { title, summary };
    }
  }
}
