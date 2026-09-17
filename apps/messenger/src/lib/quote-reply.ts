import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { isBotMentionedInDraft } from "./mention-chips.ts";

const PREVIEW_LIMIT = 80;

export function canQuoteReply(message: Pick<Message, "kind" | "parent_id">): boolean {
  return (message.kind === "user" || message.kind === "bot") && !message.parent_id;
}

export function quotePreview(body: string, limit = PREVIEW_LIMIT): string {
  const text = body.replace(/\s+/g, " ").trim();
  if ([...text].length <= limit) return text;
  return `${[...text].slice(0, limit).join("")}…`;
}

export function quotedBotName(
  message: Pick<Message, "author">,
  botsById: ReadonlyMap<string, { name: string }>,
): string | null {
  if (message.author === USER_MEMBER) return null;
  return botsById.get(message.author)?.name ?? null;
}

/** Prepend @Name in the composer draft when quoting a Bot. */
export function draftWithQuoteMention(draft: string, botName: string | null): string {
  if (!botName) return draft;
  if (isBotMentionedInDraft(botName, draft)) return draft;
  const rest = draft.replace(/^\s+/, "");
  return rest ? `@${botName} ${rest}` : `@${botName} `;
}
