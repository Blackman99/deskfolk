import { parseMentions } from "@real-bot/protocol";

export {
  hasDigit,
  lenientMatch,
  looksLikeMention,
  mentionToken,
  parseMentions,
  type MentionCorrection,
  type MentionOptions,
  type MentionParse,
  type MentionSpan,
} from "@real-bot/protocol";

/** Prepend `@Name` when quoting a Bot that the body has not already named. */
export function ensureReplyMention(
  body: string,
  input: { parentAuthor: string; parentName: string | null; selfAuthor: string; rosterNames: string[] },
): string {
  const name = input.parentName;
  if (!name) return body;
  if (input.parentAuthor === input.selfAuthor) return body;
  const parsed = parseMentions(body, input.rosterNames);
  if (parsed.everyone || parsed.mentions.includes(name)) return body;
  const rest = body.replace(/^\s+/, "");
  return rest ? `@${name} ${rest}` : `@${name} `;
}
