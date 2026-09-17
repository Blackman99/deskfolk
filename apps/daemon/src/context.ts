import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { USER_MEMBER, type Attachment, type Locale, type Message } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage } from "./completions";
import { turnSystemPrompt, type McpPromptGuide } from "./prompts";
import type { Store } from "./store";
import { takeCodePoints } from "./text";

const MAIN_LIMIT = 40;
const BODY_LIMIT = 4000;

/** Marks the message that opened this turn. Chinese in every locale, like transcript prefixes. */
export const TRIGGER_FLAG = "（本轮触发）";

function botDisplayName(store: Store, id: string): string {
  try {
    return store.getBot(id).name;
  } catch {
    return id;
  }
}

function botDuties(store: Store, id: string): string {
  try {
    return store.getBot(id).duties;
  } catch {
    return "";
  }
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
  const system = turnSystemPrompt({
    locale: input.locale,
    name: bot.name,
    duties: bot.duties,
    boundaries: bot.boundaries,
    interrupt: input.interrupt,
    mcpGuides: input.mcpGuides,
  });
  const window = transcriptWindow(store, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    triggerMessageId: input.triggerMessageId,
    selfBotId: input.botId,
  });
  return [{ role: "system", content: system }, ...window, ...input.loop];
}

function transcriptWindow(
  store: Store,
  input: { sessionId: string; turnId: string; triggerMessageId: string; selfBotId: string },
): ChatMessage[] {
  const trigger = store.getMessage(input.triggerMessageId);
  const main = store
    .listMainMessages(input.sessionId, MAIN_LIMIT)
    .filter((m) => m.turn_id !== input.turnId)
    .reverse();
  const byId = new Map<string, Message>();
  for (const m of main) byId.set(m.id, m);
  const ordered: Message[] = [];
  if (!trigger.parent_id && !byId.has(trigger.id) && trigger.turn_id !== input.turnId) {
    ordered.push(trigger);
  }
  for (const m of main) ordered.push(m);
  if (trigger.parent_id) {
    for (const m of store.listThreadMessages(trigger.parent_id)) {
      if (m.turn_id === input.turnId) continue;
      if (byId.has(m.id) || ordered.some((x) => x.id === m.id)) continue;
      ordered.push(m);
    }
  }
  const seen = new Set<string>();
  const unique: Message[] = [];
  for (const m of ordered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }
  return unique.map((m) => serializeTranscript(store, m, input.selfBotId, input.triggerMessageId));
}

const VISION_BYTES_MAX = 10_000_000;

function serializeTranscript(
  store: Store,
  message: Message,
  selfBotId: string,
  triggerMessageId: string,
): ChatMessage {
  const clipped = takeCodePoints(message.body, BODY_LIMIT);
  let body = clipped.text;
  if (clipped.truncated) body += `\n…（truncated，原 ${clipped.original} 字）`;
  for (const att of message.attachments) {
    body += `\n附件：${att.workspace_relpath}`;
  }
  const triggerLine = message.id === triggerMessageId ? `${TRIGGER_FLAG}\n` : "";
  if (message.kind === "bot" && message.author === selfBotId) {
    return { role: "assistant", content: `${triggerLine}${body}` };
  }
  const text = `${prefix(store, message)}\n${triggerLine}${body}`;
  const images = visionImageParts(store, message.attachments);
  return {
    role: "user",
    content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
  };
}

function visionMime(filename: string): string | null {
  switch (extname(filename).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function visionImageParts(store: Store, attachments: Attachment[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const att of attachments) {
    const mime = visionMime(att.original_filename) ?? visionMime(att.workspace_relpath);
    if (!mime) continue;
    try {
      const abs = store.getAttachmentFilePath(att);
      if (!existsSync(abs)) continue;
      if (statSync(abs).size > VISION_BYTES_MAX) continue;
      const buf = readFileSync(abs);
      if (buf.byteLength > VISION_BYTES_MAX) continue;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
      });
    } catch {
      // Missing or unreadable files stay as the path line only.
    }
  }
  return parts;
}

function prefix(store: Store, message: Message): string {
  switch (message.kind) {
    case "user":
      return "【user】";
    case "ask":
      return "【提问】";
    case "approval":
      return "【批准】";
    case "profile_change":
      return "【人设】";
    case "system":
      return "【系统】";
    case "bot":
      return `【${botDisplayName(store, message.author)}】`;
    default:
      return "【user】";
  }
}

export function assembleJudgementUser(store: Store, input: {
  sessionId: string;
  botId: string;
  message: Message;
  mentions: string[];
  everyone: boolean;
}): string {
  const you = store.getBot(input.botId);
  const session = store.getSession(input.sessionId);
  const present = store.presentParticipants(input.sessionId);
  const members: unknown[] = [];
  for (const p of present) {
    if (p.member === USER_MEMBER) {
      members.push("user");
      continue;
    }
    members.push({ name: botDisplayName(store, p.member), duties: botDuties(store, p.member) });
  }
  const recent = store.listMainMessages(input.sessionId, 12).reverse().map((m) => {
    const clipped = takeCodePoints(m.body, 1500);
    const row: Record<string, unknown> = {
      id: m.id,
      author: m.author === USER_MEMBER ? "user" : botDisplayName(store, m.author),
      kind: m.kind,
      body: clipped.text,
      created_at: m.created_at,
    };
    if (clipped.truncated) row.truncated = true;
    return row;
  });
  const payload = {
    you: { name: you.name, duties: you.duties, boundaries: you.boundaries },
    session: { id: session.id, name: session.name },
    members,
    message: {
      id: input.message.id,
      author: input.message.author === USER_MEMBER ? "user" : botDisplayName(store, input.message.author),
      body: input.message.body,
      created_at: input.message.created_at,
      mentions: input.mentions,
      everyone: input.everyone,
    },
    recent_messages: recent,
  };
  return JSON.stringify(payload);
}

export function extractJudgement(content: string | null, hadToolCalls: boolean): {
  decision: "join" | "pass";
  reason: string | null;
  error: "invalid_output" | null;
} {
  if (hadToolCalls || content == null) {
    return { decision: "pass", reason: null, error: "invalid_output" };
  }
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1]!.trim();
  const slice = firstObject(text);
  if (!slice) return { decision: "pass", reason: null, error: "invalid_output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return { decision: "pass", reason: null, error: "invalid_output" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { decision: "pass", reason: null, error: "invalid_output" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.decision !== "join" && obj.decision !== "pass") {
    return { decision: "pass", reason: null, error: "invalid_output" };
  }
  let reason: string | null = null;
  if ("reason" in obj) {
    if (typeof obj.reason !== "string") return { decision: "pass", reason: null, error: "invalid_output" };
    reason = obj.reason.length === 0 ? null : obj.reason;
  }
  return { decision: obj.decision, reason, error: null };
}

function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export { trimToolContent } from "./tool-results";
