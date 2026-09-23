import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { USER_MEMBER, type Attachment, type Locale, type Message } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage } from "./completions";
import { annotationContext } from "./annotation-context";
import { turnSystemPrompt, type McpPromptGuide, type MemoryPromptEntry } from "./prompts";
import {
  COMPOSER_SUGGEST_BODY,
  COMPOSER_SUGGEST_RECENT,
  type ComposerSuggestPayload,
} from "./prompts/composer-suggestions";
import type { Store } from "./store";
import { codePointCount, takeCodePoints } from "./text";

const MAIN_LIMIT = 40;
const BODY_LIMIT = 4000;
/**
 * A backstop, not a working limit: the per-Bot cap's worst case already fits under it, so a Bot
 * always sees every memory it wrote. It only bites if someone raises the per-Bot cap or the body
 * cap without redoing the arithmetic — exactly when a silent trim beats a blown context. The
 * derivation is pinned by a test, which is why the cost is a shared function and not a literal.
 */
export const MEMORY_DIGEST_LIMIT = 4_600;
/** Longest an age label gets ("10 个月前" / "10mo ago"), with room to spare. */
export const MEMORY_AGE_MAX = 12;

/** What one rendered entry costs against the budget: the text plus its `##` and blank lines. */
export function memoryEntryCost(subject: string, body: string, age: string): number {
  return codePointCount(subject) + codePointCount(body) + codePointCount(age) + 11;
}

/** Marks the message that opened this turn. Chinese in every locale, like transcript prefixes. */
export const TRIGGER_FLAG = "（本轮触发）";

/** Group-only fact block. Chinese heading in every locale, like TRIGGER_FLAG. */
export const SITUATION_HEADING = "# 局面";

const LATEST_USER_LIMIT = 200;

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
  // Guides only list enabled servers that connected and exposed tools, so "connected this turn"
  // is exactly the set a skill's `uses` can be checked against.
  const connectedMcp = new Set((input.mcpGuides ?? []).map((guide) => guide.name.toLowerCase()));
  const system = turnSystemPrompt({
    locale: input.locale,
    name: bot.name,
    duties: bot.duties,
    boundaries: bot.boundaries,
    interrupt: input.interrupt,
    skills: store.listEnabledSkills(input.botId).map((skill) => ({
      name: skill.name,
      description: skill.description,
      uses: skill.uses,
      unavailable: skill.uses.filter((name) => !connectedMcp.has(name.toLowerCase())),
    })),
    memories: memoryDigest(store, input.botId, input.locale),
    mcpGuides: input.mcpGuides,
  });
  const window = transcriptWindow(store, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    triggerMessageId: input.triggerMessageId,
    selfBotId: input.botId,
  });
  const situation = situationUserMessage(
    store,
    input.sessionId,
    input.triggerMessageId,
    input.locale,
    input.botId,
    store.turnWorkDir(input.turnId),
  );
  return [{ role: "system", content: system }, ...(situation ? [situation] : []), ...window, ...input.loop];
}

export type SituationFacts = {
  seats: string[];
  waker: string;
  latest_user: string | null;
};

export function situationFacts(
  store: Store,
  sessionId: string,
  trigger: Message,
): SituationFacts {
  const live = store.listLiveTurns({ sessionId });
  const seats: string[] = [];
  const seen = new Set<string>();
  for (const turn of live) {
    const name = botDisplayName(store, turn.bot_id);
    if (seen.has(name)) continue;
    seen.add(name);
    seats.push(name);
  }
  const waker = trigger.author === USER_MEMBER ? "user" : botDisplayName(store, trigger.author);
  const latest = store.listMainMessages(sessionId, 40).find((m) => m.kind === "user");
  let latest_user: string | null = null;
  if (latest) {
    const clipped = takeCodePoints(latest.body.replace(/\s+/g, " ").trim(), LATEST_USER_LIMIT);
    latest_user = clipped.text.length > 0 ? clipped.text : null;
  }
  return { seats, waker, latest_user };
}

/**
 * The facts this turn opens on. Groups get who is here, who has a live turn and who woke this one;
 * every turn, group or direct, gets its work dir — that path is the whole point of the shell's
 * default cwd, and a Bot that cannot see it cannot write anywhere on purpose. A direct with no
 * work dir (a turn from before work dirs) still gets no situation block at all.
 */
function situationUserMessage(
  store: Store,
  sessionId: string,
  triggerMessageId: string,
  locale: Locale,
  selfBotId: string,
  workDir: string | null,
): ChatMessage | null {
  let sessionKind: string;
  try {
    sessionKind = store.getSession(sessionId).kind;
  } catch {
    return null;
  }
  const workDirLine = workDir
    ? locale === "en"
      ? `This turn's work dir: ${workDir}/`
      : `本轮工作目录：${workDir}/`
    : null;
  if (sessionKind !== "group") {
    return workDirLine
      ? { role: "user", content: `${SITUATION_HEADING}\n\n${workDirLine}` }
      : null;
  }
  let trigger: Message;
  try {
    trigger = store.getMessage(triggerMessageId);
  } catch {
    return null;
  }
  const facts = situationFacts(store, sessionId, trigger);
  const members = store
    .presentBotIds(sessionId)
    .filter((id) => id !== selfBotId)
    .map((id) => `@${botDisplayName(store, id)}`);
  const membersLine =
    locale === "en"
      ? members.length > 0
        ? `Members here (mention by exact full name): ${members.join(", ")}.`
        : "Members here: only you."
      : members.length > 0
        ? `在场成员（点名请逐字写全名）：${members.join("、")}。`
        : "在场成员：只有你。";
  const seatLine =
    locale === "en"
      ? facts.seats.length > 0
        ? `Live turns in this group: ${facts.seats.join(", ")}.`
        : "Live turns in this group: none."
      : facts.seats.length > 0
        ? `本群进行中的轮：${facts.seats.join("、")}。`
        : "本群没有进行中的轮。";
  const wakerLabel = facts.waker === "user" ? "user" : facts.waker;
  const wakerLine =
    locale === "en"
      ? `This turn was opened by 【${wakerLabel}】.`
      : `本轮由【${wakerLabel}】叫醒。`;
  const latestLine =
    locale === "en"
      ? facts.latest_user
        ? `Latest user line: ${facts.latest_user}`
        : "Latest user line: (none)"
      : facts.latest_user
        ? `用户最近一条：${facts.latest_user}`
        : "用户最近一条：（无）";
  const lines = [membersLine, seatLine, wakerLine, latestLine];
  if (workDirLine) lines.push(workDirLine);
  return { role: "user", content: `${SITUATION_HEADING}\n\n${lines.join("\n")}` };
}

/**
 * How old a memory reads in the prompt. Bucketed rather than dated: an ISO timestamp would
 * change the system text every day and cost the prefix cache for no gain, and the Bot only has
 * to know whether a conclusion is fresh or stale. The messenger shows the same buckets.
 */
export function memoryAgeLabel(locale: Locale, createdAt: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return locale === "en" ? "today" : "今天";
  if (days < 7) return locale === "en" ? "this week" : "本周";
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return locale === "en" ? `${weeks}w ago` : `${weeks} 周前`;
  const months = Math.floor(days / 30);
  return locale === "en" ? `${months}mo ago` : `${months} 个月前`;
}

/**
 * Two passes on purpose. The cut takes newest-written first, so when the budget ever bites it is
 * the stalest conclusion that falls out. The survivors are then sorted by subject, so the
 * rendered text does not reshuffle every time one memory is rewritten.
 */
export function memoryDigest(store: Store, botId: string, locale: Locale, now: Date = new Date()): MemoryPromptEntry[] {
  const kept: MemoryPromptEntry[] = [];
  let used = 0;
  for (const memory of store.listEnabledMemories(botId)) {
    const age = memoryAgeLabel(locale, memory.created_at, now);
    const cost = memoryEntryCost(memory.subject, memory.body, age);
    if (used + cost > MEMORY_DIGEST_LIMIT) break;
    used += cost;
    kept.push({ subject: memory.subject, body: memory.body, age });
  }
  return kept.sort((a, b) => a.subject.localeCompare(b.subject));
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
  // A batch of annotations is spelled out under the message that carries it, crops as pixels.
  const annotated = message.kind === "user" ? annotationContext(store, message.id, store.settingsCached().locale) : { text: "", images: [] };
  body += annotated.text;
  const triggerLine = message.id === triggerMessageId ? `${TRIGGER_FLAG}\n` : "";
  if (message.kind === "bot" && message.author === selfBotId) {
    return { role: "assistant", content: `${triggerLine}${body}` };
  }
  const text = `${prefix(store, message)}\n${triggerLine}${body}`;
  const images = [...visionImageParts(store, message.attachments), ...annotated.images];
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

export function assembleComposerSuggestUser(store: Store, sessionId: string): string {
  const session = store.getSession(sessionId);
  const present = store.presentParticipants(sessionId);
  const members: ComposerSuggestPayload["members"] = [];
  for (const p of present) {
    if (p.member === USER_MEMBER) {
      members.push("user");
      continue;
    }
    members.push({ name: botDisplayName(store, p.member), duties: botDuties(store, p.member) });
  }
  const recent = store.listMainMessages(sessionId, COMPOSER_SUGGEST_RECENT).reverse().map((m) => {
    const clipped = takeCodePoints(m.body, COMPOSER_SUGGEST_BODY);
    const row: ComposerSuggestPayload["recent_messages"][number] = {
      id: m.id,
      author: m.author === USER_MEMBER ? "user" : botDisplayName(store, m.author),
      kind: m.kind,
      body: clipped.text,
      created_at: m.created_at,
    };
    if (clipped.truncated) row.truncated = true;
    return row;
  });
  const latest = [...recent].reverse().find((m) => m.kind === "user" || m.author === "user");
  const seats: string[] = [];
  const seen = new Set<string>();
  for (const turn of store.listLiveTurns({ sessionId })) {
    const name = botDisplayName(store, turn.bot_id);
    if (seen.has(name)) continue;
    seen.add(name);
    seats.push(name);
  }
  const last = store.listMainMessages(sessionId, 1)[0];
  const waker = last
    ? last.author === USER_MEMBER
      ? "user"
      : botDisplayName(store, last.author)
    : "user";
  const payload: ComposerSuggestPayload = {
    session: { id: session.id, kind: session.kind, name: session.name },
    members,
    situation: {
      seats,
      waker,
      latest_user: latest ? latest.body.replace(/\s+/g, " ").trim().slice(0, LATEST_USER_LIMIT) || null : null,
    },
    recent_messages: recent,
  };
  return JSON.stringify(payload);
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
    situation: situationFacts(store, input.sessionId, input.message),
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
