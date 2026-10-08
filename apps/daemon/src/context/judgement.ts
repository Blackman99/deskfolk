/** What the judgement and composer-suggestion calls read, and reading the judgement back. */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { askTranscriptText } from "../ask";
import { COMPOSER_SUGGEST_BODY, COMPOSER_SUGGEST_RECENT, type ComposerSuggestPayload } from "../prompts/composer-suggestions";
import { parsePlanSpec, type Store } from "../store";
import { takeCodePoints } from "../text";
import { botDisplayName, botDuties, BRIEF_LIMIT, LATEST_USER_LIMIT, oneLineClip } from "./common";
import { planFacts } from "./plan-facts";
import { situationFacts } from "./situation";

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
    const clipped = takeCodePoints(m.kind === "ask" ? askTranscriptText(m) : m.body, COMPOSER_SUGGEST_BODY);
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
  const open = store.sessionCurrentTask(sessionId);
  const spec = open ? parsePlanSpec(open.spec) : null;
  const payload: ComposerSuggestPayload = {
    session: { id: session.id, kind: session.kind, name: session.name },
    members,
    situation: {
      seats,
      waker,
      latest_user: latest ? latest.body.replace(/\s+/g, " ").trim().slice(0, LATEST_USER_LIMIT) || null : null,
    },
    plan: open
      ? {
          goal: spec?.goal ?? (open.brief ? oneLineClip(open.brief, BRIEF_LIMIT) : null),
          acceptance: spec?.acceptance ?? [],
          open_tickets: store
            .listTickets(open.id)
            .filter((ticket) => ticket.status !== "done" && ticket.status !== "parked")
            .map((ticket) => ticket.title),
        }
      : null,
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
    const clipped = takeCodePoints(m.kind === "ask" ? askTranscriptText(m) : m.body, 1500);
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
  // The plan this message lands in — the one the organizer filed it under, else the session's
  // current one: the judgement then weighs what the plan still lacks, not just whether this one
  // line sounds like the Bot's business.
  const filed = input.message.task_id ?? store.sessionCurrentTask(input.sessionId)?.id ?? null;
  const facts = filed
    ? planFacts(store, {
        taskId: filed,
        ticketId: input.message.ticket_id ?? null,
        turnId: null,
        triggerMessageId: input.message.id,
        botId: input.botId,
        sessionId: input.sessionId,
        locale: store.settingsCached().locale,
      })
    : null;
  const plan = facts
    ? {
        goal: facts.goal,
        kind: facts.kind,
        status: facts.status,
        brief: facts.brief,
        first_turn: facts.first_turn,
        acceptance: facts.acceptance,
        rules: facts.rules,
        tickets: facts.tickets.map((ticket) => ({ seq: ticket.seq, title: ticket.title, status: ticket.status, worker: ticket.worker })),
        message_ticket: facts.ticket ? { seq: facts.ticket.seq, title: facts.ticket.title, spec: facts.ticket.spec } : null,
        artifacts: facts.artifacts,
        trace: facts.trace,
        live_elsewhere: facts.elsewhere.map((turn) => ({ bot: turn.self ? "you" : turn.bot, where: turn.where })),
        you_heard_elsewhere: facts.elsewhere.some((turn) => turn.self && turn.heard),
      }
    : null;
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
    plan,
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
