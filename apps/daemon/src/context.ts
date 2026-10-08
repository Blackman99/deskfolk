import { USER_MEMBER, type Locale } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import { botDisplayName } from "./context/common";
import { memoryDigest } from "./context/memory-digest";
import { situationUserMessage } from "./context/situation";
import { transcriptWindow } from "./context/transcript";
import { loopPictureSpend } from "./loop-pictures";
import { turnSystemPrompt, type McpPromptGuide } from "./prompts";
import { promptPage, turnPromptTexts } from "./prompts/book";
import type { Store } from "./store";

/** Turns of the job the block recounts, newest last. */
export const JOB_TRACE_LIMIT = 12;

/**
 * Where a session is, said from one Bot's seat: `群「name」`, `你和用户的私聊`, `用户和X的私聊`,
 * `你和X的私聊`, `X和Y的私聊`. It is how a line heard from another session, a plan opened
 * elsewhere and a turn running elsewhere say where. Null once the session is gone.
 */
export function sessionLabel(store: Store, sessionId: string, selfBotId: string | null, locale: Locale): string | null {
  let session;
  try {
    session = store.getSession(sessionId);
  } catch {
    return null;
  }
  const en = locale === "en";
  if (session.kind === "group") {
    if (!session.name) return en ? "a group" : "一个群";
    return en ? `group "${session.name}"` : `群「${session.name}」`;
  }
  const bots = store.presentBotIds(sessionId);
  if (store.isPresent(sessionId, USER_MEMBER)) {
    const bot = bots[0];
    if (!bot || bot === selfBotId) return en ? "your direct with the user" : "你和用户的私聊";
    const name = botDisplayName(store, bot);
    return en ? `the user's direct with ${name}` : `用户和${name}的私聊`;
  }
  if (selfBotId && bots.includes(selfBotId)) {
    const other = bots.find((id) => id !== selfBotId);
    const name = other ? botDisplayName(store, other) : "?";
    return en ? `your direct with ${name}` : `你和${name}的私聊`;
  }
  const names = bots.map((id) => botDisplayName(store, id));
  return en ? `the direct between ${names.join(" and ")}` : `${names.join("和")}的私聊`;
}

export function assembleTurnMessages(
  store: Store,
  input: {
    sessionId: string;
    botId: string;
    turnId: string;
    triggerMessageId: string;
    locale: Locale;
    interrupt: boolean;
    loop: ChatMessage[];
    mcpGuides?: McpPromptGuide[];
  },
): ChatMessage[] {
  const bot = store.getBot(input.botId);
  // Guides only list enabled servers that connected and exposed tools, so "connected this turn"
  // is exactly the set a skill's `uses` can be checked against.
  const connectedMcp = new Set((input.mcpGuides ?? []).map((guide) => guide.name.toLowerCase()));
  const system = turnSystemPrompt({
    locale: input.locale,
    engineLevel: store.capabilities().engine_level,
    name: bot.name,
    duties: bot.duties,
    boundaries: bot.boundaries,
    interrupt: input.interrupt,
    skills: [
      ...store.listEnabledSkills(input.botId).map((skill) => ({
        name: skill.name,
        description: skill.description,
        uses: skill.uses,
        unavailable: skill.uses.filter((name) => !connectedMcp.has(name.toLowerCase())),
      })),
      // Project skills you shared (ADR 0052, level 8), less those this Bot has one of its own by the name.
      ...store.sharedSkillsFor(input.botId).map((skill) => ({
        name: skill.name,
        description: skill.description,
        uses: skill.uses,
        unavailable: skill.uses.filter((name) => !connectedMcp.has(name.toLowerCase())),
        sharedFrom: skill.source_bot_name,
      })),
    ],
    memories: memoryDigest(store, input.botId, input.locale),
    mcpGuides: input.mcpGuides,
    // Built-in prompts you edited (ADR 0064); what you did not edit is rendered as shipped.
    texts: turnPromptTexts(promptPage(store, input.locale)),
  });
  const window = transcriptWindow(store, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    triggerMessageId: input.triggerMessageId,
    selfBotId: input.botId,
    loopPictures: loopPictureSpend(input.loop),
    locale: input.locale,
  });
  const situation = situationUserMessage(
    store,
    input.sessionId,
    input.triggerMessageId,
    input.locale,
    input.botId,
    input.turnId,
  );
  return [{ role: "system", content: system }, ...(situation ? [situation] : []), ...window, ...input.loop];
}

/** One piece of a Claude Agent turn's first message: words, or a picture as base64 (ADR 0061). */
export type AgentInputPart = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string };

/**
 * A Claude Agent turn's first message (ADR 0061): the situation block and the transcript window the
 * app's own loop reads, in one user message — Claude Code keeps its own conversation from there.
 * Other people's lines keep their 【name】 prefix; the Bot's own lines are marked as its own, since
 * there is no assistant turn to carry them. Pictures in the window go along as images.
 */
export function assembleAgentTurnInput(
  store: Store,
  input: { sessionId: string; botId: string; turnId: string; triggerMessageId: string; locale: Locale },
): AgentInputPart[] {
  // Claude Code's file tools take host paths, so its dirs are named that way.
  const situation = situationUserMessage(store, input.sessionId, input.triggerMessageId, input.locale, input.botId, input.turnId, true);
  const window = transcriptWindow(store, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    triggerMessageId: input.triggerMessageId,
    selfBotId: input.botId,
    loopPictures: { images: 0, bytes: 0 },
    locale: input.locale,
  });
  const en = input.locale === "en";
  const parts: AgentInputPart[] = [];
  const text = (value: string) => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += `\n\n${value}`;
    else parts.push({ type: "text", text: value });
  };
  const add = (content: ChatMessage["content"], prefix = "") => {
    if (typeof content === "string") {
      text(`${prefix}${content}`);
      return;
    }
    let first = true;
    for (const part of content ?? []) {
      if (part.type === "text") {
        text(first ? `${prefix}${part.text}` : part.text);
        first = false;
        continue;
      }
      const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
      if (match) parts.push({ type: "image", mediaType: match[1]!, data: match[2]! });
    }
  };
  if (situation) add(situation.content);
  text(en ? "# Conversation (latest at the bottom)" : "# 对话（最新的在最下面）");
  const self = en ? "【you】" : "【你】";
  for (const line of window) add(line.content, line.role === "assistant" ? `${self}\n` : "");
  return parts;
}

export { trimToolContent } from "./tool-results";
