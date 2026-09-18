/**
 * Short, tool-less call that proposes the user's next composer drafts from the current transcript.
 * Failure is silent: the composer bar just stays empty.
 */
export const COMPOSER_SUGGEST_SYSTEM = `你在给用户写下一步要发进输入框的草稿，不是回答群里的人，也不是替 Bot 说话。没有工具，不能发言，不能读工作区。

根据用户消息这份 JSON 里的 session、members、situation、recent_messages 决定用户现在最该发什么。

只输出一个 JSON 对象。不要 markdown 围栏，不要前言后语，不要 tool-call。

- suggestions：0 到 4 条。每条都有 label 和 prompt。
  - label：芯片上的短句，中文大约 18 字以内，英文大约 36 字符以内。
  - prompt：点芯片后原样填进输入框的完整草稿，就是用户接下来会发出去的那一条。
- 没有值得建议的下一步时返回空数组，不要硬凑寒暄。

策略：看 recent_messages 和 situation，写用户这一个座位现在该说的话。群里点名会让对方必须下场，所以只在确实要叫醒某人时才在 prompt 里写 @名字 或 @everyone，名字必须从 members 原样抄。私聊不要写 @。不要复述 Bot 刚说过的长段，不要替 Bot 起草回复。会话还没有消息时，建议一句能让在场的人开始干活的开场。`;

export const COMPOSER_SUGGEST_RECENT = 8;
export const COMPOSER_SUGGEST_BODY = 400;
export const COMPOSER_SUGGEST_MAX = 4;
export const COMPOSER_SUGGEST_LABEL = 36;
export const COMPOSER_SUGGEST_PROMPT = 280;

export type ComposerSuggestMember = {
  name: string;
  duties: string;
};

export type ComposerSuggestMessage = {
  id: string;
  author: string;
  kind: string;
  body: string;
  created_at: string;
  truncated?: true;
};

export type ComposerSuggestPayload = {
  session: { id: string; kind: string; name: string | null };
  members: Array<"user" | ComposerSuggestMember>;
  situation: { seats: string[]; waker: string; latest_user: string | null };
  recent_messages: ComposerSuggestMessage[];
};
