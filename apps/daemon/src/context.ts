import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { USER_MEMBER, type Attachment, type Locale, type Message, type PlanStatus, type TicketStatus } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage } from "./completions";
import { annotationContext } from "./annotation-context";
import { askTranscriptText } from "./ask";
import { turnSystemPrompt, type McpPromptGuide, type MemoryPromptEntry } from "./prompts";
import {
  COMPOSER_SUGGEST_BODY,
  COMPOSER_SUGGEST_RECENT,
  type ComposerSuggestPayload,
} from "./prompts/composer-suggestions";
import { parsePlanSpec, type PlanSpec, type Store } from "./store";
import { codePointCount, takeCodePoints } from "./text";
import { visionImage } from "./vision-image";
import { classifyPath } from "./workspace-paths";

const MAIN_LIMIT = 40;
const BODY_LIMIT = 4000;
/**
 * How much of a job's opening request the situation block quotes. The line itself is in the
 * transcript window on the first turn; this is for every turn after a handoff or forty lines on.
 */
export const BRIEF_LIMIT = 1200;
/** Files a job has handed over that the block lists; the newest cited come first. */
export const JOB_ARTIFACTS_LIMIT = 20;
/** Turns of the job the block recounts, newest last. */
export const JOB_TRACE_LIMIT = 12;
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
    input.turnId,
  );
  return [{ role: "system", content: system }, ...(situation ? [situation] : []), ...window, ...input.loop];
}

export type PlanTicketFact = {
  id: string;
  seq: number;
  title: string;
  status: TicketStatus;
  /** The Bot's display name, when one is on it. */
  worker: string | null;
  /** Up to a few of the files filed under it, newest cited first. */
  artifacts: string[];
};

export type PlanPrecedent = { goal: string; process: string[]; rules: string[]; outcome: string[] };

export type PlanFacts = {
  /** The plan has no spec yet and no other turn: the trigger is the request, and it can still be clarified. */
  first_turn: boolean;
  /** The request that opened the plan, one line, clipped to {@link BRIEF_LIMIT}. */
  brief: string | null;
  /** The organizer's reading of the plan; null until it has run. */
  goal: string | null;
  kind: string | null;
  status: PlanStatus;
  acceptance: string[];
  rules: string[];
  process: string[];
  progress: PlanSpec["progress"] | null;
  /** The plan's tickets, open ones first. */
  tickets: PlanTicketFact[];
  /** The ticket this turn works in, when it has one. */
  ticket: { id: string; seq: number; title: string; status: TicketStatus; spec: string; dir: string } | null;
  /** Finished plans of the same kind, newest first: how this kind of thing went last time. */
  precedents: PlanPrecedent[];
  /** Workspace paths the plan's messages cited and that still exist, newest cited first. */
  artifacts: string[];
  /** One line per earlier turn: who, and their last word or the question they are waiting on. */
  trace: string[];
  /** The appointment this Bot still has in this session, if any. */
  check_back: { in_minutes: number; note: string } | null;
};

/** Tickets the situation block lists; a plan past this says how many more there are. */
export const PLAN_TICKET_LINES = 20;
/** Finished plans of the same kind the block recounts. */
export const PLAN_PRECEDENTS_LIMIT = 3;
/** Files named on one ticket's line. */
const TICKET_ARTIFACT_LINES = 3;

const TICKET_ORDER: Record<TicketStatus, number> = { doing: 0, review: 1, todo: 2, parked: 3, done: 4 };

/**
 * What a plan looks like from outside the transcript window: what it is for as the organizer last
 * understood it, its rules and acceptance, its tickets and their state, what has been handed over,
 * who did what, and how the same kind of plan went before. Every line is read back from rows the
 * store already keeps; nothing here is summarised by a model at read time, so it costs no call and
 * cannot drift from the record. A handoff, a mention, a Bot↔Bot direct and a check-back all land in
 * the same plan, which is how the goal follows the work across sessions.
 */
export function planFacts(
  store: Store,
  input: {
    taskId: string;
    /** The ticket the turn works in, when known. */
    ticketId?: string | null;
    /** The turn being assembled; null for a judgement, which has no turn yet. */
    turnId: string | null;
    triggerMessageId: string | null;
    botId: string;
    sessionId: string;
    locale: Locale;
    now?: Date;
  },
): PlanFacts | null {
  let task;
  try {
    task = store.getTask(input.taskId);
  } catch {
    return null;
  }
  const now = input.now ?? new Date();
  const spec = parsePlanSpec(task.spec);
  const firstTurn = !spec && !store.taskHasEarlierTurns(input.taskId, input.turnId ?? "");
  const brief = task.brief ? oneLineClip(task.brief, BRIEF_LIMIT) : null;
  const cited = store.taskArtifacts(input.taskId, (relpath) => workspaceFileExists(store, relpath), JOB_ARTIFACTS_LIMIT);
  const artifacts = cited.map((row) => row.path);
  const byTicket = new Map<string, string[]>();
  for (const row of cited) {
    if (!row.ticket_id) continue;
    const list = byTicket.get(row.ticket_id) ?? [];
    if (list.length < TICKET_ARTIFACT_LINES) list.push(row.path);
    byTicket.set(row.ticket_id, list);
  }
  const tickets: PlanTicketFact[] = store
    .listTickets(input.taskId)
    .map((ticket) => ({
      id: ticket.id,
      seq: ticket.seq,
      title: ticket.title,
      status: ticket.status,
      worker: ticket.worker ? botDisplayName(store, ticket.worker) : null,
      artifacts: byTicket.get(ticket.id) ?? [],
    }))
    .sort((a, b) => TICKET_ORDER[a.status] - TICKET_ORDER[b.status] || a.seq - b.seq);
  let ticket: PlanFacts["ticket"] = null;
  if (input.ticketId) {
    try {
      const row = store.getTicket(input.ticketId);
      ticket = { id: row.id, seq: row.seq, title: row.title, status: row.status, spec: row.spec, dir: row.dir };
    } catch {
      ticket = null;
    }
  }
  const precedents: PlanPrecedent[] = [];
  if (spec?.kind) {
    for (const earlier of store.precedentTasks(spec.kind, input.taskId, PLAN_PRECEDENTS_LIMIT)) {
      const done = parsePlanSpec(earlier.spec);
      if (!done) continue;
      precedents.push({ goal: done.goal, process: done.process, rules: done.rules, outcome: done.progress.done });
    }
  }
  const trace: string[] = [];
  if (!firstTurn) {
    const nodes = store
      .taskTrace(input.taskId)
      .nodes.filter(
        (node) =>
          node.turn_id !== input.turnId &&
          !(node.actor === USER_MEMBER && node.trigger_message_id === input.triggerMessageId),
      )
      .slice(-JOB_TRACE_LIMIT);
    for (const node of nodes) {
      const who = node.actor === USER_MEMBER ? "user" : botDisplayName(store, node.actor);
      const state = traceStateLabel(node.status, input.locale);
      trace.push(`【${who}】${node.summary}${state}`);
    }
  }
  const pending = store.pendingCheckBack(input.botId, input.sessionId);
  const check_back = pending
    ? {
        in_minutes: Math.max(0, Math.ceil((Date.parse(pending.due_at) - now.getTime()) / 60_000)),
        note: pending.note,
      }
    : null;
  return {
    first_turn: firstTurn,
    brief,
    goal: spec?.goal ?? null,
    kind: spec?.kind ?? task.kind,
    status: task.status,
    acceptance: spec?.acceptance ?? [],
    rules: spec?.rules ?? [],
    process: spec?.process ?? [],
    progress: spec?.progress ?? null,
    tickets,
    ticket,
    precedents,
    artifacts,
    trace,
    check_back,
  };
}

const PLAN_STATUS_LABEL: Record<PlanStatus, { zh: string; en: string }> = {
  active: { zh: "进行中", en: "active" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

const TICKET_STATUS_LABEL: Record<TicketStatus, { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  doing: { zh: "进行中", en: "doing" },
  review: { zh: "待验收", en: "review" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

function ticketLine(ticket: PlanTicketFact, locale: Locale): string {
  const en = locale === "en";
  const number = String(ticket.seq).padStart(2, "0");
  const bits = [TICKET_STATUS_LABEL[ticket.status][locale]];
  if (ticket.worker) bits.push(en ? `${ticket.worker} on it` : `${ticket.worker}在做`);
  if (ticket.artifacts.length > 0) bits.push(ticket.artifacts.join(en ? ", " : "、"));
  return en ? `${number} ${ticket.title} (${bits.join("; ")})` : `${number} ${ticket.title}（${bits.join("；")}）`;
}

/** A turn that is not simply done says so on its trace line; a completed one needs no label. */
function traceStateLabel(status: string, locale: Locale): string {
  const labels: Record<string, { zh: string; en: string }> = {
    running: { zh: "（进行中）", en: " (running)" },
    waiting_ask: { zh: "（等用户回答）", en: " (waiting on the user)" },
    waiting_approval: { zh: "（等批准）", en: " (waiting for approval)" },
    interrupted: { zh: "（中断）", en: " (interrupted)" },
    stopped: { zh: "（已停止）", en: " (stopped)" },
    redirected: { zh: "（改道）", en: " (redirected)" },
  };
  const label = labels[status];
  return label ? label[locale] : "";
}

function oneLineClip(text: string, limit: number): string {
  const clipped = takeCodePoints(text.replace(/\s+/g, " ").trim(), limit);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

function workspaceFileExists(store: Store, relpath: string): boolean {
  const root = store.workspacePath();
  if (!root) return false;
  const classified = classifyPath(root, relpath);
  if (classified.zone !== "inside") return false;
  try {
    return existsSync(classified.abs);
  } catch {
    return false;
  }
}

/** The plan's lines of the situation block, after the group facts and before the work dir. */
export function planLines(facts: PlanFacts, locale: Locale): string[] {
  const en = locale === "en";
  const sep = en ? "; " : "；";
  const lines: string[] = [];
  if (facts.goal) {
    const tags = [facts.kind, PLAN_STATUS_LABEL[facts.status][locale]].filter((tag): tag is string => Boolean(tag));
    lines.push(en ? `Plan: ${facts.goal} (${tags.join(", ")})` : `规划：${facts.goal}（${tags.join("，")}）`);
    if (facts.acceptance.length > 0) lines.push(`${en ? "Acceptance: " : "验收："}${facts.acceptance.join(sep)}`);
    if (facts.rules.length > 0) lines.push(`${en ? "Rules: " : "规则："}${facts.rules.join(sep)}`);
    if (facts.process.length > 0) lines.push(`${en ? "Process: " : "流程与分工："}${facts.process.join(sep)}`);
    if (facts.progress) {
      const parts: string[] = [];
      if (facts.progress.done.length > 0) parts.push(`${en ? "done: " : "已完成 "}${facts.progress.done.join(en ? ", " : "、")}`);
      if (facts.progress.open.length > 0) parts.push(`${en ? "open: " : "待做 "}${facts.progress.open.join(en ? ", " : "、")}`);
      if (facts.progress.blocked.length > 0) parts.push(`${en ? "blocked: " : "卡住 "}${facts.progress.blocked.join(en ? ", " : "、")}`);
      if (parts.length > 0) lines.push(`${en ? "Progress: " : "进展："}${parts.join(sep)}`);
    }
  } else if (facts.first_turn) {
    lines.push(en ? "This is the first turn of this job." : "这是这件事的第一轮。");
  } else if (facts.brief) {
    lines.push(en ? `What this job was asked for: ${facts.brief}` : `这件事最初的要求：${facts.brief}`);
  }
  if (facts.tickets.length > 0) {
    const shown = facts.tickets.slice(0, PLAN_TICKET_LINES);
    const rest = facts.tickets.length - shown.length;
    const rows = shown.map((ticket) => `- ${ticketLine(ticket, locale)}`);
    if (rest > 0) rows.push(en ? `- … and ${rest} more` : `- …还有 ${rest} 条`);
    lines.push(`${en ? "Tickets:" : "任务清单："}\n${rows.join("\n")}`);
  }
  if (facts.ticket) {
    const number = String(facts.ticket.seq).padStart(2, "0");
    const head = en
      ? `This turn's ticket: ${number} ${facts.ticket.title} (${TICKET_STATUS_LABEL[facts.ticket.status].en})`
      : `本轮任务：${number} ${facts.ticket.title}（${TICKET_STATUS_LABEL[facts.ticket.status].zh}）`;
    lines.push(facts.ticket.spec ? `${head}${en ? " — " : "——"}${oneLineClip(facts.ticket.spec, 600)}` : head);
  }
  if (facts.precedents.length > 0) {
    const rows = facts.precedents.map((earlier) => {
      const bits: string[] = [];
      if (earlier.process.length > 0) bits.push(`${en ? "process: " : "流程 "}${earlier.process.join(en ? ", " : "、")}`);
      if (earlier.rules.length > 0) bits.push(`${en ? "rules: " : "规则 "}${earlier.rules.join(en ? ", " : "、")}`);
      if (earlier.outcome.length > 0) bits.push(`${en ? "outcome: " : "结局 "}${earlier.outcome.join(en ? ", " : "、")}`);
      return en ? `- "${earlier.goal}": ${bits.join("; ") || "(no notes)"}` : `- 「${earlier.goal}」：${bits.join("；") || "（没有记录）"}`;
    });
    lines.push(`${en ? "Precedents (finished plans of this kind):" : "先例（同类做完的）："}\n${rows.join("\n")}`);
  }
  if (facts.artifacts.length > 0) {
    lines.push(
      en ? `Handed over so far: ${facts.artifacts.join(", ")}` : `这件事已交出：${facts.artifacts.join("、")}`,
    );
  }
  if (facts.trace.length > 0) {
    lines.push(`${en ? "So far:" : "经过："}\n${facts.trace.map((line) => `- ${line}`).join("\n")}`);
  }
  if (facts.check_back) {
    lines.push(
      en
        ? `Your check-back: in ${facts.check_back.in_minutes} min (${facts.check_back.note})`
        : `你约的回看：${facts.check_back.in_minutes} 分钟后（${facts.check_back.note}）`,
    );
  }
  return lines;
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
 * every turn, group or direct, gets its job — what it was asked for, what it has handed over, who
 * did what, and this Bot's pending check-back — and its work dir, because that path is the whole
 * point of the shell's default cwd, and a Bot that cannot see it cannot write anywhere on purpose.
 * A direct with no job (a turn from before work dirs) still gets no situation block at all.
 */
function situationUserMessage(
  store: Store,
  sessionId: string,
  triggerMessageId: string,
  locale: Locale,
  selfBotId: string,
  turnId: string,
): ChatMessage | null {
  let sessionKind: string;
  try {
    sessionKind = store.getSession(sessionId).kind;
  } catch {
    return null;
  }
  const taskId = store.taskOfTurn(turnId);
  const ticketId = store.ticketOfTurn(turnId);
  const workDir = store.turnWorkDir(turnId);
  const planDir = ticketId ? store.turnPlanDir(turnId) : null;
  const workDirLine = workDir
    ? ticketId && planDir
      ? locale === "en"
        ? `This turn's ticket dir: ${workDir}/ (plan dir: ${planDir}/)`
        : `本轮任务目录：${workDir}/（规划目录：${planDir}/）`
      : locale === "en"
        ? `This turn's work dir: ${workDir}/`
        : `本轮工作目录：${workDir}/`
    : null;
  const facts = taskId
    ? planFacts(store, { taskId, ticketId, turnId, triggerMessageId, botId: selfBotId, sessionId, locale })
    : null;
  const job = facts ? planLines(facts, locale) : [];
  if (sessionKind !== "group") {
    const lines = [...job, ...(workDirLine ? [workDirLine] : [])];
    return lines.length > 0 ? { role: "user", content: `${SITUATION_HEADING}\n\n${lines.join("\n")}` } : null;
  }
  let trigger: Message;
  try {
    trigger = store.getMessage(triggerMessageId);
  } catch {
    return null;
  }
  const group = situationFacts(store, sessionId, trigger);
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
      ? group.seats.length > 0
        ? `Live turns in this group: ${group.seats.join(", ")}.`
        : "Live turns in this group: none."
      : group.seats.length > 0
        ? `本群进行中的轮：${group.seats.join("、")}。`
        : "本群没有进行中的轮。";
  const wakerLabel = group.waker === "user" ? "user" : group.waker;
  const wakerLine =
    locale === "en"
      ? `This turn was opened by 【${wakerLabel}】.`
      : `本轮由【${wakerLabel}】叫醒。`;
  const latestLine =
    locale === "en"
      ? group.latest_user
        ? `Latest user line: ${group.latest_user}`
        : "Latest user line: (none)"
      : group.latest_user
        ? `用户最近一条：${group.latest_user}`
        : "用户最近一条：（无）";
  const lines = [membersLine, seatLine, wakerLine, latestLine, ...job];
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
  const ordered: Message[] = [...main];
  // A trigger the window leaves out, older than it or a check-back's line nobody else is shown,
  // still reads where it happened.
  if (!trigger.parent_id && !byId.has(trigger.id) && trigger.turn_id !== input.turnId) {
    const at = ordered.findIndex((m) => m.created_at > trigger.created_at);
    ordered.splice(at < 0 ? ordered.length : at, 0, trigger);
  }
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
  // A batch of annotations is spelled out under the user's message that carries it, crops as pixels.
  const locale = store.settingsCached().locale;
  const annotated = new Map<string, ReturnType<typeof annotationContext>>();
  for (const m of unique) {
    if (m.kind === "user") annotated.set(m.id, annotationContext(store, m.id, locale));
  }
  const { images, cropsSent } = windowImages(store, unique, input.selfBotId, input.triggerMessageId, annotated);
  return unique.map((m) =>
    serializeTranscript(
      store,
      m,
      input.selfBotId,
      input.triggerMessageId,
      annotated.get(m.id)?.textFor(cropsSent.get(m.id) ?? 0) ?? "",
      images.get(m.id) ?? [],
    ),
  );
}

/** One image over this is skipped on its own; it never counts against the window. */
const VISION_BYTES_MAX = 10_000_000;
/**
 * What the whole window may carry as pictures. Every raster in the last forty lines used to ride
 * on every request, and a storyboard group grew one turn to 54 images and 85 MB of base64: the
 * endpoint never answered, and the turn read as "couldn't reach the endpoint" however often it
 * was continued. Spent newest first with the trigger ahead of everything, and the first picture
 * that does not fit closes it, so what drops out is always the oldest. Those keep their path line.
 * Bytes are counted as sent, after `visionImage` has shrunk them. An annotation batch's crops
 * (up to 50, a megabyte each) spend the same budget, after the attachments of their message.
 */
export const VISION_WINDOW_IMAGES = 20;
export const VISION_WINDOW_BYTES = 20_000_000;

type VisionBudget = { images: number; bytes: number; closed: boolean };

function windowImages(
  store: Store,
  messages: Message[],
  selfBotId: string,
  triggerMessageId: string,
  annotated: Map<string, { images: ChatContentPart[] }>,
): { images: Map<string, ChatContentPart[]>; cropsSent: Map<string, number> } {
  const budget: VisionBudget = { images: VISION_WINDOW_IMAGES, bytes: VISION_WINDOW_BYTES, closed: false };
  const trigger = messages.find((m) => m.id === triggerMessageId);
  const newestFirst = [...(trigger ? [trigger] : []), ...messages.filter((m) => m !== trigger).reverse()];
  const out = new Map<string, ChatContentPart[]>();
  const cropsSent = new Map<string, number>();
  for (const message of newestFirst) {
    if (budget.closed) break;
    // The Bot's own lines go out as assistant text, which carries no pictures.
    if (message.kind === "bot" && message.author === selfBotId) continue;
    const attached = visionImageParts(store, message.attachments, budget);
    const crops = cropParts(annotated.get(message.id)?.images ?? [], budget);
    cropsSent.set(message.id, crops.length);
    const parts = [...attached, ...crops];
    if (parts.length > 0) out.set(message.id, parts);
  }
  return { images: out, cropsSent };
}

function serializeTranscript(
  store: Store,
  message: Message,
  selfBotId: string,
  triggerMessageId: string,
  annotationText: string,
  images: ChatContentPart[],
): ChatMessage {
  const clipped = takeCodePoints(message.body, BODY_LIMIT);
  let body = clipped.text;
  if (clipped.truncated) body += `\n…（truncated，原 ${clipped.original} 字）`;
  if (message.kind === "ask") body = askTranscriptText(message, body);
  for (const att of message.attachments) {
    body += `\n附件：${att.workspace_relpath}`;
  }
  body += annotationText;
  const triggerLine = message.id === triggerMessageId ? `${TRIGGER_FLAG}\n` : "";
  if (message.kind === "bot" && message.author === selfBotId) {
    return { role: "assistant", content: `${triggerLine}${body}` };
  }
  const text = `${prefix(store, message)}\n${triggerLine}${body}`;
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

function visionImageParts(store: Store, attachments: Attachment[], budget: VisionBudget): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const att of attachments) {
    if (budget.closed) break;
    const mime = visionMime(att.original_filename) ?? visionMime(att.workspace_relpath);
    if (!mime) continue;
    try {
      const abs = store.getAttachmentFilePath(att);
      if (!existsSync(abs)) continue;
      const stat = statSync(abs);
      if (stat.size > VISION_BYTES_MAX) continue;
      if (budget.images === 0) {
        budget.closed = true;
        break;
      }
      const image = visionImage(abs, mime, stat);
      if (image.bytes.byteLength > VISION_BYTES_MAX) continue;
      if (image.bytes.byteLength > budget.bytes) {
        budget.closed = true;
        break;
      }
      budget.images -= 1;
      budget.bytes -= image.bytes.byteLength;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` },
      });
    } catch {
      // Missing or unreadable files stay as the path line only.
    }
  }
  return parts;
}

/**
 * An annotation batch's crops under the window budget. They are already small (1 MB at most, see
 * `ANNOTATION_CROP_MAX_BYTES`), so nothing is shrunk; a dropped crop leaves the annotation's text.
 */
function cropParts(crops: ChatContentPart[], budget: VisionBudget): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const crop of crops) {
    if (budget.closed) break;
    if (crop.type !== "image_url") continue;
    const { url } = crop.image_url;
    const bytes = Buffer.byteLength(url.slice(url.indexOf(",") + 1), "base64");
    if (budget.images === 0 || bytes > budget.bytes) {
      budget.closed = true;
      break;
    }
    budget.images -= 1;
    budget.bytes -= bytes;
    parts.push(crop);
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

export { trimToolContent } from "./tool-results";
