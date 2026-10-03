import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  USER_MEMBER,
  type AcceptanceCheck,
  type AcceptanceCheckOutcome,
  type Attachment,
  type Locale,
  type Message,
  type PlanStatus,
  type TicketStage,
  type TicketStatus,
} from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage } from "./completions";
import { describeCheck } from "./acceptance-eval";
import { measureLabel, measureOf, sameAsk, unconfirmedNote } from "./derived-checks";
import type { DimensionValue } from "./quote-dimensions";
import { annotationContext } from "./annotation-context";
import { askTranscriptText } from "./ask";
import { loopPictureSpend, pictureMime } from "./loop-pictures";
import { readOnlyLine, saidOf, turnSystemPrompt, type McpPromptGuide, type MemoryPromptEntry, type SaidLine } from "./prompts";
import {
  COMPOSER_SUGGEST_BODY,
  COMPOSER_SUGGEST_RECENT,
  type ComposerSuggestPayload,
} from "./prompts/composer-suggestions";
import { parsePlanSpec, type PlanSpec, type Store } from "./store";
import { ENGINE_LEVELS } from "./store/schema-gate";
import { codePointCount, takeCodePoints } from "./text";
import { visionImage } from "./vision-image";
import { asFolder, classifyPath } from "./workspace-paths";

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

/** The plan and ticket a line or a turn belongs to, as `task_id` / `ticket_id` carry them. */
export type PlanRef = { taskId: string | null; ticketId: string | null };

/** How much of a plan's title a tag spends; the situation block names it in full. */
export const PLAN_TAG_TITLE_MAX = 20;

/**
 * Names the plan and ticket a line belongs to, as seen from the turn reading it: another plan reads
 * `〔规划「title」· 任务 03〕`, another ticket of the same plan `〔任务 03〕`, and the turn's own
 * ticket — or a line nobody filed — nothing. The title is the plan's opening words, which never
 * change once it is open, so a plan keeps one name across turns and matches the messenger. The
 * lookups are cached for the one assembly that owns the tagger.
 */
export function planTagger(store: Store, relativeTo: PlanRef, locale: Locale): (ref: PlanRef) => string {
  const en = locale === "en";
  const titles = new Map<string, string | null>();
  const seqs = new Map<string, number | null>();
  const title = (id: string): string | null => {
    if (!titles.has(id)) {
      try {
        titles.set(id, oneLineClip(store.getTask(id).title, PLAN_TAG_TITLE_MAX));
      } catch {
        titles.set(id, null);
      }
    }
    return titles.get(id)!;
  };
  const seq = (id: string): number | null => {
    if (!seqs.has(id)) {
      try {
        seqs.set(id, store.getTicket(id).seq);
      } catch {
        seqs.set(id, null);
      }
    }
    return seqs.get(id)!;
  };
  return (ref) => {
    if (!ref.taskId) return "";
    const number = ref.ticketId ? seq(ref.ticketId) : null;
    const ticket = number === null ? null : `${en ? "ticket" : "任务"} ${String(number).padStart(2, "0")}`;
    if (ref.taskId !== relativeTo.taskId) {
      const name = title(ref.taskId);
      if (name === null) return "";
      const plan = en ? `plan "${name}"` : `规划「${name}」`;
      return `〔${ticket ? `${plan} · ${ticket}` : plan}〕`;
    }
    if (!ticket || ref.ticketId === relativeTo.ticketId) return "";
    return `〔${ticket}〕`;
  };
}

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

export type PlanTicketFact = {
  id: string;
  seq: number;
  title: string;
  status: TicketStatus;
  /** Its stage from engine level 5 (ADR 0046), when that says more than the status: submitted, in review, rework, approved. */
  stage?: TicketStage | null;
  /** The Bot's display name, when one is on it. */
  worker: string | null;
  /** Up to a few of the files filed under it, newest cited first. */
  artifacts: string[];
};

/** One thing the user said in the job, as the quote layer shows it: when, where, and the words. */
export type QuoteFact = { at: string; where: string; body: string };

/**
 * What the user said in the job (ADR 0040 P3), kept apart from the transcript: the first few lines,
 * which say what the job is, and the latest, which say where it stands, with how many between.
 */
export type QuoteLayer = { head: QuoteFact[]; tail: QuoteFact[]; omitted: number };

/** One entry of the requirements ledger bearing on the job, as the situation block lists it. */
export type RequirementFact = {
  seq: number;
  quote: string;
  restated: string | null;
  times: number;
  /** In how many plans the user said it. */
  plans: number;
  status: "open" | "proposed" | "unverified";
  /** How near it holds to this turn: its ticket 0, the plan 1, another ticket 2, the conversation 3, standing 4. */
  nearness: number;
  lastRaisedAt: string;
  /** Where it holds, in words, and the plan it came from when that is another. */
  appliesTo: string;
  /** The check from the user's words on the same number and bound, and whether it is in force. */
  check: string | null;
  /** A proposed replacement: the entry it would replace, which stays in force until the user chooses. */
  replaces: { seq: number; quote: string } | null;
};

export type PlanCheckFact = {
  item: string;
  /** One line describing what it verifies, e.g. "文件存在：report.md". */
  what: string;
  /** null when it has never run. */
  outcome: AcceptanceCheckOutcome | null;
  detail: string;
  /** Minutes since its last run; null alongside `outcome` when it has never run. */
  ageMinutes: number | null;
  /**
   * A check from the user's words not confirmed yet (ADR 0040 P3): what the cut measured against it
   * and that it waits for them, in place of an outcome. Null on every other check.
   */
  unconfirmed?: string | null;
  /** Its last verdict came from a model looking at pictures: from level 5 a reference only, never a block (ADR 0046). */
  reference?: boolean;
};

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
  /** The plan's active acceptance checks — the app's own evidence, run on this machine. */
  checks: PlanCheckFact[];
  /** The ticket this turn works in, when it has one. */
  ticket: { id: string; seq: number; title: string; status: TicketStatus; stage?: TicketStage | null; spec: string; dir: string } | null;
  /** What the user said in the job; null when nothing is kept, and on the first turn, whose trigger is the request. */
  quotes: QuoteLayer | null;
  /** The requirements ledger's entries bearing on the job, less those the user set not to hold for it. */
  requirements: RequirementFact[];
  /**
   * This Bot's calibration record (ADR 0046, from level 5): its approvals the user overturned in the
   * plan's conversation, newest first, with what the user said. Empty for a Bot never overturned.
   */
  calibration: Array<{ ticket: string; quote: string; at: string }>;
  /** The checklist items of this Bot's you adopted from its reflections (ADR 0051, level 8), each with its moment. */
  checklist?: Array<{ hook: "before_review" | "before_submit" | "before_generate"; text: string }>;
  /** Workspace paths the plan's messages cited and that still exist, newest cited first. */
  artifacts: string[];
  /** One line per earlier turn: who, and their last word or the question they are waiting on. */
  trace: string[];
  /** The appointment this Bot still has in this session, if any. */
  check_back: { in_minutes: number; note: string } | null;
  /** The plan's name, the one every tag on a line from it uses. */
  title: string;
  /** Where the plan was opened, when that is not this session. */
  home: string | null;
  /**
   * Turns working in this plan right now in other sessions: who, and where. A turn a hold covers is
   * not working, and is left out. `heard` marks the ones that were already live when the trigger —
   * your line filed in this plan, here — came in, and so got it in their inbox.
   */
  elsewhere: Array<{ bot: string; self: boolean; where: string; heard: boolean }>;
  /** This Bot's other live turns, on other plans: where, which plan, which ticket. */
  other_work: Array<{ where: string; plan: string; ticket: string | null }>;
  /**
   * Tickets the line that opened this turn was read as a complaint about, where a card still asks
   * the user whether to send them back to rework: theirs to decide, not this turn's to act on.
   */
  rework_asked?: Array<{ seq: number; title: string }>;
};

/** Turns elsewhere on the same plan the block names. */
export const ELSEWHERE_LINES = 6;
/** This Bot's other live turns the block names. */
export const OTHER_WORK_LINES = 3;

/** Tickets the situation block lists; a plan past this says how many more there are. */
export const PLAN_TICKET_LINES = 20;
/** Checks the situation block lists; matches the store's own cap on active checks per plan. */
export const PLAN_CHECK_LINES = 10;
/** The user's first and latest lines the quote layer carries (ADR 0040 P3). */
export const QUOTE_LAYER_HEAD = 4;
export const QUOTE_LAYER_TAIL = 6;
/** How much of one line of the user's the quote layer quotes. */
export const QUOTE_LAYER_BODY = 400;
/**
 * Requirements said once that the block lists besides those said twice or more, which are always
 * all there: at most this many lines, and this many code points between them.
 */
export const REQUIREMENT_LINES = 20;
export const REQUIREMENT_BUDGET = 2000;
/** Proposed entries, and old unverified rules, the block lists, each. */
export const REQUIREMENT_ASIDE_LINES = 10;
/** How much of an entry's words one line of the block quotes. */
const REQUIREMENT_QUOTE_LINE = 200;
/** Files named on one ticket's line. */
const TICKET_ARTIFACT_LINES = 3;

const TICKET_ORDER: Record<TicketStatus, number> = { doing: 0, review: 1, todo: 2, parked: 3, done: 4 };

/**
 * What a plan looks like from outside the transcript window: what it is for as the organizer last
 * understood it, what the user said in it and asked of it (their words and the requirements
 * ledger, ADR 0040 P3), its tickets and their state, what has been handed over and who did what.
 * Every line is read back from rows the store already keeps; nothing here is summarised by a model
 * at read time, so it costs no call and cannot drift from the record. A handoff, a mention, a
 * Bot↔Bot direct, a check-back and a routine all land in the same plan, which is how the goal and
 * the user's words follow the work across sessions.
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
      ...(ticket.stage ? { stage: ticket.stage } : {}),
      worker: ticket.worker ? botDisplayName(store, ticket.worker) : null,
      artifacts: byTicket.get(ticket.id) ?? [],
    }))
    .sort((a, b) => TICKET_ORDER[a.status] - TICKET_ORDER[b.status] || a.seq - b.seq);
  const allChecks = store.listChecks(input.taskId);
  const checks: PlanCheckFact[] = allChecks
    .slice(0, PLAN_CHECK_LINES)
    .map((check) => {
      const last = check.last_run;
      const at = last ? (last.finished_at ?? last.started_at) : null;
      return {
        item: check.item,
        what: describeCheck(check, input.locale),
        outcome: last?.outcome ?? null,
        detail: last?.detail ?? "",
        ageMinutes: at ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000)) : null,
        unconfirmed: check.origin === "derived" && check.derived_state !== "active" ? unconfirmedNote(check, input.locale) : null,
        reference: last?.judged_by === "vision" && store.capabilities().engine_level >= ENGINE_LEVELS.submissions,
      };
    });
  let ticket: PlanFacts["ticket"] = null;
  if (input.ticketId) {
    try {
      const row = store.getTicket(input.ticketId);
      ticket = { id: row.id, seq: row.seq, title: row.title, status: row.status, ...(row.stage ? { stage: row.stage } : {}), spec: row.spec, dir: row.dir };
    } catch {
      ticket = null;
    }
  }
  // A Bot's own items, each marked with the moment it is for; they are few (twelve at most).
  const checklist = store.checklistFor(input.botId, ["before_review", "before_submit", "before_generate"]);
  const en = input.locale === "en";
  const places = new Map<string, string>();
  const where = (sessionId: string): string => {
    if (!places.has(sessionId)) {
      places.set(sessionId, sessionLabel(store, sessionId, input.botId, input.locale) ?? (en ? "a deleted session" : "已删除的会话"));
    }
    return places.get(sessionId)!;
  };
  // A turn a stop holds reads what the user said and asked as it stood when the stop was made: what
  // came since is for after the lift, not for a turn that may not act on it (ADR 0040 I3), and
  // reading it there would hand a held Bot a fresh instruction all the same.
  const heldSince = input.turnId
    ? store.turnHeldBy(input.turnId).reduce<string | null>((at, hold) => (at === null || hold.created_at < at ? hold.created_at : at), null)
    : null;
  const quotes = firstTurn ? null : quoteLayer(store, input.taskId, where, input.locale, heldSince);
  const requirements = requirementFacts(store, {
    taskId: input.taskId,
    ticketId: input.ticketId ?? null,
    tickets,
    checks: allChecks,
    locale: input.locale,
    heldSince,
  });
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
      // A plan follows its work into other sessions; a step taken in one of them says so.
      const there = node.session_id !== input.sessionId ? (en ? ` (in ${where(node.session_id)})` : `（在${where(node.session_id)}）`) : "";
      trace.push(`【${who}】${node.summary}${state}${there}`);
    }
  }
  // Mirrors `hearAcross`: your line filed in this plan went into the inbox of every turn on it
  // elsewhere that was live when it came in and that no hold covered. A turn that opened later never
  // got it. One a hold covers now is left out whether it got it or not: it can act on nothing.
  let spokenAt: string | null = null;
  if (input.triggerMessageId) {
    try {
      const trigger = store.getMessage(input.triggerMessageId);
      if (trigger.author === USER_MEMBER && trigger.task_id === input.taskId && trigger.session_id === input.sessionId) {
        spokenAt = trigger.created_at;
      }
    } catch {
      spokenAt = null;
    }
  }
  const live = store.listLiveTurns();
  const elsewhere = live
    .filter((turn) => turn.task_id === input.taskId && turn.session_id !== input.sessionId && turn.id !== input.turnId)
    .filter((turn) => store.turnHeldBy(turn.id).length === 0)
    .slice(0, ELSEWHERE_LINES)
    .map((turn) => ({
      bot: botDisplayName(store, turn.bot_id),
      self: turn.bot_id === input.botId,
      where: where(turn.session_id),
      heard: spokenAt !== null && turn.created_at < spokenAt,
    }));
  const other_work: PlanFacts["other_work"] = [];
  for (const turn of live) {
    if (other_work.length >= OTHER_WORK_LINES) break;
    if (turn.bot_id !== input.botId || turn.id === input.turnId || !turn.task_id || turn.task_id === input.taskId) continue;
    let plan: string;
    try {
      plan = store.getTask(turn.task_id).title;
    } catch {
      continue;
    }
    let ticket: string | null = null;
    if (turn.ticket_id) {
      try {
        const row = store.getTicket(turn.ticket_id);
        ticket = `${String(row.seq).padStart(2, "0")} ${row.title}`;
      } catch {
        ticket = null;
      }
    }
    other_work.push({ where: where(turn.session_id), plan, ticket });
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
    checks,
    ticket,
    quotes,
    requirements,
    calibration: task.session_id ? store.reviewMisses({ botId: input.botId, sessionId: task.session_id }) : [],
    ...(checklist.length > 0 ? { checklist } : {}),
    artifacts,
    trace,
    check_back,
    title: task.title,
    home: task.session_id && task.session_id !== input.sessionId ? where(task.session_id) : null,
    elsewhere,
    other_work,
    ...reworkAsked(store, input.triggerMessageId),
  };
}

/**
 * The cards still asking the user whether to send a ticket back over the line that opened this
 * turn. The line went to the lead as well as to the card: on 2026-10-04's walkthrough 「第三句不好，
 * 换一句」 after the slogans were approved woke the lead, which was not told a card was asking, and
 * could hand the fix to the writer while the user was about to press 转回返工 — the work twice.
 */
function reworkAsked(store: Store, triggerMessageId: string | null): Pick<PlanFacts, "rework_asked"> {
  if (!triggerMessageId) return {};
  const rows = store.db.query<{ seq: number; title: string }, [string]>(`SELECT t.seq, t.title FROM messages m
    JOIN tickets t ON t.id = json_extract(m.control, '$.ticket_id')
    WHERE json_extract(m.control, '$.kind') = 'rework' AND json_extract(m.control, '$.message_id') = ?
      AND COALESCE(json_array_length(json_extract(m.control, '$.acted')), 0) = 0
      AND EXISTS (SELECT 1 FROM json_each(json_extract(m.control, '$.offer')) WHERE value = 'rework')
    ORDER BY t.seq`).all(triggerMessageId);
  return rows.length > 0 ? { rework_asked: rows } : {};
}

/** When a line was said, in this machine's time: 「09-28 12:02」. */
function quoteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * The quote layer (ADR 0040 P3): the user's first {@link QUOTE_LAYER_HEAD} and latest
 * {@link QUOTE_LAYER_TAIL} lines filed under the plan, from wherever they were said — a group, a
 * direct, an answer to a question, an annotation, the board — and kept when a transcript is
 * cleared, so a Bot in a Bot↔Bot direct, a check-back or a routine reads them as one in the group
 * does. Erased words are left out, and so, for a turn a stop holds, is anything said after the
 * stop (`heldSince`).
 */
function quoteLayer(store: Store, taskId: string, where: (sessionId: string) => string, locale: Locale, heldSince: string | null): QuoteLayer | null {
  const en = locale === "en";
  const said = store
    .listQuotes({ taskId })
    .filter((quote) => !quote.redacted_at && quote.body.trim() && (heldSince === null || quote.created_at <= heldSince));
  if (said.length === 0) return null;
  const fact = (quote: (typeof said)[number]): QuoteFact => {
    const place = quote.session_id ? where(quote.session_id) : en ? "a deleted session" : "已删除的会话";
    const label =
      quote.via === "board"
        ? en ? "on the board" : "在流程图写"
        : quote.via === "ask_answer"
          ? en ? `answering a question in ${place}` : `在${place}回答提问`
          : quote.via === "annotation"
            ? en ? `annotation in ${place}` : `在${place}批注`
            : en ? `in ${place}` : `在${place}`;
    return { at: quoteTime(quote.created_at), where: label, body: oneLineClip(quote.body, QUOTE_LAYER_BODY) };
  };
  if (said.length <= QUOTE_LAYER_HEAD + QUOTE_LAYER_TAIL) return { head: said.map(fact), tail: [], omitted: 0 };
  return {
    head: said.slice(0, QUOTE_LAYER_HEAD).map(fact),
    tail: said.slice(-QUOTE_LAYER_TAIL).map(fact),
    omitted: said.length - QUOTE_LAYER_HEAD - QUOTE_LAYER_TAIL,
  };
}

/**
 * The requirements ledger's entries bearing on the plan (ADR 0040 P3), as the block lists them:
 * where each holds relative to this turn, where it came from when another plan set it, and the
 * check from the user's words on the same number when there is one. Entries the user set not to
 * hold for this plan are left out, and so, for a turn a stop holds, are those written after the
 * stop (`heldSince`).
 */
function requirementFacts(
  store: Store,
  input: { taskId: string; ticketId: string | null; tickets: PlanTicketFact[]; checks: AcceptanceCheck[]; locale: Locale; heldSince: string | null },
): RequirementFact[] {
  const en = input.locale === "en";
  const since = input.heldSince;
  const newer = new Set(
    since === null
      ? []
      : store
          .requirementsBearingOn(input.taskId, ["open", "proposed", "unverified"])
          .filter((entry) => entry.created_at > since)
          .map((entry) => entry.id),
  );
  return store
    .planRequirements(input.taskId)
    .filter((entry) => !entry.excluded && !newer.has(entry.id))
    .map((entry) => {
      let nearness = 1;
      let place = en ? "this job" : "这件事";
      if (entry.scope === "ticket" || entry.scope === "part") {
        const ticket = input.tickets.find((row) => row.id === entry.ticket_id);
        nearness = entry.ticket_id === input.ticketId ? 0 : 2;
        const number = ticket ? String(ticket.seq).padStart(2, "0") : null;
        place = number
          ? en ? `ticket ${number} ${oneLineClip(ticket!.title, PLAN_TAG_TITLE_MAX)}` : `任务 ${number} ${oneLineClip(ticket!.title, PLAN_TAG_TITLE_MAX)}`
          : en ? "one ticket" : "一个任务";
      } else if (entry.scope === "project") {
        nearness = 3;
        place = en ? "every job in this conversation" : "这个会话的每件事";
      } else if (entry.scope === "standing") {
        nearness = 4;
        place = entry.domain ? (en ? `standing (${entry.domain})` : `常设（${entry.domain}）`) : en ? "standing" : "常设";
      }
      if (entry.inherited_from) {
        const from = oneLineClip(entry.inherited_from.title, PLAN_TAG_TITLE_MAX);
        place += en ? ` (inherited from "${from}")` : `（继承自「${from}」）`;
      }
      // The check from the user's words on this very number (the same number and bound), not merely
      // on the same dimension: an offer for a newer number belongs to the entry saying that one.
      const asked = entry.dimension && entry.value ? measureOf({ dimension: entry.dimension, ...(entry.value as object) } as DimensionValue) : null;
      const same = asked
        ? input.checks
            .filter((check) => check.origin === "derived" && check.measure && sameAsk(check.measure, asked))
            .sort((a, b) => Number(b.derived_state === "active") - Number(a.derived_state === "active"))[0]
        : undefined;
      const check = same?.measure
        ? `${measureLabel(same.measure, input.locale)}${
            same.derived_state === "active" ? (en ? " (in force)" : "（生效）") : en ? " (waiting for the user to confirm)" : "（待用户确认）"
          }`
        : null;
      return {
        seq: entry.seq,
        quote: oneLineClip(entry.quote, REQUIREMENT_QUOTE_LINE),
        restated: entry.restated ? oneLineClip(entry.restated, REQUIREMENT_QUOTE_LINE) : null,
        times: entry.times_raised,
        plans: entry.plans_raised,
        status: entry.status,
        nearness,
        lastRaisedAt: entry.last_raised_at,
        appliesTo: place,
        check,
        replaces: entry.supersedes ? { seq: entry.supersedes.seq, quote: oneLineClip(entry.supersedes.quote, REQUIREMENT_QUOTE_LINE) } : null,
      };
    });
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

/** The stages a status does not say (ADR 0046), named in their place. */
const TICKET_STAGE_LABEL: Partial<Record<TicketStage, { zh: string; en: string }>> = {
  submitted: { zh: "已交付，待审查", en: "submitted, awaiting review" },
  in_review: { zh: "审查中", en: "in review" },
  rework: { zh: "返工", en: "rework" },
  approved: { zh: "已通过", en: "approved" },
  dropped: { zh: "作废", en: "dropped" },
};

function ticketWord(ticket: Pick<PlanTicketFact, "status" | "stage">, locale: Locale): string {
  return (ticket.stage ? TICKET_STAGE_LABEL[ticket.stage]?.[locale] : undefined) ?? TICKET_STATUS_LABEL[ticket.status][locale];
}

function ticketLine(ticket: PlanTicketFact, locale: Locale): string {
  const en = locale === "en";
  const number = String(ticket.seq).padStart(2, "0");
  const bits = [ticketWord(ticket, locale)];
  // Who is on it only while it is open: an approved one says who made it, one set aside nobody's.
  const closed = ticket.stage === "approved" || (!ticket.stage && ticket.status === "done");
  if (ticket.worker && closed) bits.push(en ? `made by ${ticket.worker}` : `${ticket.worker}做的`);
  else if (ticket.worker && ticket.status !== "parked") bits.push(en ? `${ticket.worker} on it` : `${ticket.worker}在做`);
  if (ticket.artifacts.length > 0) bits.push(ticket.artifacts.join(en ? ", " : "、"));
  return en ? `${number} ${ticket.title} (${bits.join("; ")})` : `${number} ${ticket.title}（${bits.join("；")}）`;
}

const CHECK_OUTCOME_LABEL: Record<AcceptanceCheckOutcome, { zh: string; en: string }> = {
  pass: { zh: "通过", en: "pass" },
  fail: { zh: "不通过", en: "fail" },
  blocked: { zh: "受阻", en: "blocked" },
  error: { zh: "出错", en: "error" },
};

/** 「item」what：outcome（detail；N 分钟前）— or, unrun, just 「item」what：未跑. */
function checkLine(check: PlanCheckFact, locale: Locale): string {
  const en = locale === "en";
  // Information for the reviewer, never a block: the user has not confirmed it.
  if (check.unconfirmed) return en ? `"${check.item}" ${check.unconfirmed}` : `「${check.item}」${check.unconfirmed}`;
  if (!check.outcome || check.ageMinutes === null) {
    return en ? `"${check.item}" ${check.what}: not run yet` : `「${check.item}」${check.what}：未跑`;
  }
  const outcome = CHECK_OUTCOME_LABEL[check.outcome][locale];
  const age = en ? `${check.ageMinutes}min ago` : `${check.ageMinutes} 分钟前`;
  const reference = check.reference ? (en ? " — judged by a model looking at pictures: for reference only, not a block" : "——看图判定，只作参考，不挡交付") : "";
  return en
    ? `"${check.item}" ${check.what}: ${outcome} (${check.detail}; ${age})${reference}`
    : `「${check.item}」${check.what}：${outcome}（${check.detail}；${age}）${reference}`;
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
    lines.push(
      en
        ? `Plan "${facts.title}": ${facts.goal} (${tags.join(", ")})`
        : `规划「${facts.title}」：${facts.goal}（${tags.join("，")}）`,
    );
    if (facts.process.length > 0) lines.push(`${en ? "Process: " : "流程与分工："}${facts.process.join(sep)}`);
    if (facts.progress) {
      const parts: string[] = [];
      if (facts.progress.done.length > 0) parts.push(`${en ? "done: " : "已完成 "}${facts.progress.done.join(en ? ", " : "、")}`);
      if (facts.progress.open.length > 0) parts.push(`${en ? "open: " : "待做 "}${facts.progress.open.join(en ? ", " : "、")}`);
      if (facts.progress.blocked.length > 0) parts.push(`${en ? "blocked: " : "卡住 "}${facts.progress.blocked.join(en ? ", " : "、")}`);
      if (parts.length > 0) lines.push(`${en ? "Progress: " : "进展："}${parts.join(sep)}`);
    }
  } else if (facts.first_turn) {
    lines.push(
      en ? `This is the first turn of this job (plan "${facts.title}").` : `这是这件事的第一轮（规划「${facts.title}」）。`,
    );
  } else if (facts.brief) {
    lines.push(
      en
        ? `What this job was asked for (plan "${facts.title}"): ${facts.brief}`
        : `这件事最初的要求（规划「${facts.title}」）：${facts.brief}`,
    );
  }
  // The user's own words and what they asked, before anything the app or a Bot made of them. The
  // plan's rules and Done-when lines are in the ledger now, typed on the board or taken in as old rules.
  if (facts.quotes) lines.push(quoteLines(facts.quotes, locale));
  lines.push(...requirementLines(facts.requirements, locale));
  if (facts.calibration.length > 0) {
    const rows = facts.calibration.map((miss) => en
      ? `- "${miss.ticket}" (${quoteTime(miss.at)}): the user said "${miss.quote}"`
      : `- 「${miss.ticket}」（${quoteTime(miss.at)}）：用户说「${miss.quote}」`);
    lines.push(`${en
      ? "Your calibration record — approvals of yours the user overturned here; weigh the same kind of thing harder before passing it:"
      : "你的校准记录——你放行后被用户推翻的；再审同类问题时要更严："}\n${rows.join("\n")}`);
  }
  if (facts.checklist && facts.checklist.length > 0) {
    const moment = { before_review: en ? "before passing it" : "放行前", before_submit: en ? "before handing it over" : "交付前", before_generate: en ? "before generating" : "生成前" };
    const rows = facts.checklist.map((item) => `- ${moment[item.hook]}${en ? ": " : "："}${item.text}`);
    lines.push(`${en ? "Your own checklist — from your reflections the user adopted; go through it at that moment:" : "你自己的清单——用户采用了的你的反思；到那个时机逐条过一遍："}\n${rows.join("\n")}`);
  }
  if (facts.checks.length > 0) {
    const rows = facts.checks.map((check) => `- ${checkLine(check, locale)}`);
    lines.push(`${en ? "Acceptance checks (the app runs these itself, on this machine):" : "验收检查（应用在本机自己跑）："}\n${rows.join("\n")}`);
  }
  if (facts.home) {
    lines.push(en ? `This plan was opened in ${facts.home}.` : `这件事是在${facts.home}里开的。`);
  }
  if (facts.elsewhere.length > 0) {
    const who = facts.elsewhere.map((turn) =>
      en ? `${turn.self ? "you" : turn.bot} (${turn.where})` : `${turn.self ? "你" : turn.bot}（${turn.where}）`,
    );
    lines.push(en ? `Also working on this plan elsewhere: ${who.join(", ")}.` : `这件事别处进行中的轮：${who.join("、")}。`);
    const heard = facts.elsewhere.filter((turn) => turn.heard);
    if (heard.length > 0) {
      const names = [...new Set(heard.map((turn) => (turn.self ? (en ? "you" : "你") : turn.bot)))];
      const mine = heard.some((turn) => turn.self);
      lines.push(
        en
          ? `The line that opened this turn has been passed to ${names.join(", ")}.${mine ? " Your turn there got it too and does any work it calls for; here, answer the user and do not make the same change twice." : ""}`
          : `触发这一轮的那句已经转给了${names.join("、")}。${mine ? "你在那边的那一轮也收到了，要动手的由它接着做；这里回应用户就好，不要重复做同样的改动。" : ""}`,
      );
    }
  }
  if (facts.other_work.length > 0) {
    const rows = facts.other_work.map((work) => {
      const ticket = work.ticket ? (en ? ` · ticket ${work.ticket}` : `· 任务 ${work.ticket}`) : "";
      return en ? `plan "${work.plan}"${ticket} in ${work.where}` : `${work.where}里的规划「${work.plan}」${ticket}`;
    });
    lines.push(en ? `Your other live turns: ${rows.join("; ")}.` : `你同时在干的别的事：${rows.join("；")}。`);
  }
  // A dropped ticket is no task (the job's opening ticket, folded once the lead laid the job out,
  // read 「搁置；设计师在做」 here), unless it is this turn's own.
  const listed = facts.tickets.filter((ticket) => ticket.stage !== "dropped" || ticket.id === facts.ticket?.id);
  if (listed.length > 0) {
    const shown = listed.slice(0, PLAN_TICKET_LINES);
    const rest = listed.length - shown.length;
    const rows = shown.map((ticket) => `- ${ticketLine(ticket, locale)}`);
    if (rest > 0) rows.push(en ? `- … and ${rest} more` : `- …还有 ${rest} 条`);
    lines.push(`${en ? "Tickets:" : "任务清单："}\n${rows.join("\n")}`);
  }
  if (facts.rework_asked && facts.rework_asked.length > 0) {
    const named = facts.rework_asked.map((ticket) => `${String(ticket.seq).padStart(2, "0")}${en ? ` "${ticket.title}"` : `「${ticket.title}」`}`).join(en ? ", " : "、");
    lines.push(en
      ? `(App) The line that opened this turn reads as a complaint about ${named}, already handed over: a card is asking the user whether to send it back to rework. That is theirs to decide — do not change it or hand the fix to anyone meanwhile; if they send it back, the app wakes its maker with these words.`
      : `（应用）叫醒这一轮的那句话读成了对已交出的 ${named}的意见：卡片正在问用户要不要转回返工。这由用户定——定之前别改它，也别另派人改；用户选了返工，应用会带着这句话叫做的 Bot 改。`);
  }
  if (facts.ticket) {
    const number = String(facts.ticket.seq).padStart(2, "0");
    const head = en
      ? `This turn's ticket: ${number} ${facts.ticket.title} (${ticketWord(facts.ticket, "en")})`
      : `本轮任务：${number} ${facts.ticket.title}（${ticketWord(facts.ticket, "zh")}）`;
    lines.push(facts.ticket.spec ? `${head}${en ? " — " : "——"}${oneLineClip(facts.ticket.spec, 600)}` : head);
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

/** The quote layer as block text: the first lines, how many between, the latest. */
function quoteLines(layer: QuoteLayer, locale: Locale): string {
  const en = locale === "en";
  const row = (quote: QuoteFact) => (en ? `- ${quote.at} ${quote.where}: ${quote.body}` : `- ${quote.at} ${quote.where}：${quote.body}`);
  const rows = layer.head.map(row);
  if (layer.omitted > 0) rows.push(en ? `- … ${layer.omitted} more in between` : `- …中间还有 ${layer.omitted} 条`);
  rows.push(...layer.tail.map(row));
  const head = layer.omitted > 0
    ? en
      ? `What the user said in this job (verbatim; the first ${QUOTE_LAYER_HEAD} and the latest ${QUOTE_LAYER_TAIL}):`
      : `用户在这件事里的话（原文，最早 ${QUOTE_LAYER_HEAD} 条和最新 ${QUOTE_LAYER_TAIL} 条）：`
    : en
      ? "What the user said in this job (verbatim):"
      : "用户在这件事里的话（原文）：";
  return `${head}\n${rows.join("\n")}`;
}

/** R-31｜「words」（转述：…）｜用户已说 7 次（跨 3 个规划）｜适用：…｜挂检查：… */
function requirementLine(entry: RequirementFact, locale: Locale): string {
  const en = locale === "en";
  const bits = [en ? `R-${entry.seq} | "${entry.quote}"` : `R-${entry.seq}｜「${entry.quote}」`];
  if (entry.restated) bits[0] += en ? ` (restated: ${entry.restated})` : `（转述：${entry.restated}）`;
  if (entry.replaces) bits.push(en ? `would replace R-${entry.replaces.seq} "${entry.replaces.quote}"` : `要取代 R-${entry.replaces.seq}「${entry.replaces.quote}」`);
  if (entry.times >= 2) {
    const across = entry.plans >= 2 ? (en ? ` (across ${entry.plans} plans)` : `（跨 ${entry.plans} 个规划）`) : "";
    bits.push(en ? `the user said it ${entry.times} times${across}` : `用户已说 ${entry.times} 次${across}`);
  }
  bits.push(en ? `holds for: ${entry.appliesTo}` : `适用：${entry.appliesTo}`);
  if (entry.check) bits.push(en ? `check: ${entry.check}` : `挂检查：${entry.check}`);
  return bits.join(en ? " | " : "｜");
}

/**
 * The requirements section (ADR 0040 P3): the entries in force, nearest to this turn first and then
 * the most often and most recently said, every one said twice or more and the rest up to
 * {@link REQUIREMENT_LINES} lines and {@link REQUIREMENT_BUDGET} code points; then the proposed ones
 * and the old unverified rules, each in a section of its own, since neither is a requirement yet.
 */
function requirementLines(entries: RequirementFact[], locale: Locale): string[] {
  const en = locale === "en";
  const more = (n: number) => (en ? `- … and ${n} more` : `- …还有 ${n} 条`);
  const order = (a: RequirementFact, b: RequirementFact) =>
    a.nearness - b.nearness || b.times - a.times || (a.lastRaisedAt < b.lastRaisedAt ? 1 : a.lastRaisedAt > b.lastRaisedAt ? -1 : 0) || a.seq - b.seq;
  const lines: string[] = [];
  const open = entries.filter((entry) => entry.status === "open").sort(order);
  if (open.length > 0) {
    const rows: string[] = [];
    let once = 0;
    let spent = 0;
    let left = 0;
    for (const entry of open) {
      const row = `- ${requirementLine(entry, locale)}`;
      if (entry.times >= 2) {
        rows.push(row);
        continue;
      }
      const cost = codePointCount(row);
      if (once < REQUIREMENT_LINES && spent + cost <= REQUIREMENT_BUDGET) {
        rows.push(row);
        once += 1;
        spent += cost;
      } else {
        left += 1;
      }
    }
    if (left > 0) rows.push(more(left));
    lines.push(`${en ? "User requirements (nearest first):" : "用户要求（按适用范围由近到远）："}\n${rows.join("\n")}`);
  }
  const aside = (status: RequirementFact["status"], head: string): void => {
    const listed = entries.filter((entry) => entry.status === status).sort(order);
    if (listed.length === 0) return;
    const rows = listed.slice(0, REQUIREMENT_ASIDE_LINES).map((entry) => `- ${requirementLine(entry, locale)}`);
    if (listed.length > REQUIREMENT_ASIDE_LINES) rows.push(more(listed.length - REQUIREMENT_ASIDE_LINES));
    lines.push(`${head}\n${rows.join("\n")}`);
  };
  aside(
    "proposed",
    en ? "Waiting for the user to confirm (not in force; do not act on these as requirements):" : "待用户确认的取代或建议（还没生效，不要当要求执行）：",
  );
  aside("unverified", en ? "Old rules (source unverified; for reference only):" : "旧规则（出处未核实，只作参考）：");
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
  // The prompt speaks in workspace-relative paths, so a Bot that has to name a host path (a file the
  // user points at outside the workspace, a cwd) used to guess the root and `~` — often `/Users/me`.
  const root = workDir ? store.workspacePath() : null;
  const rootLine = root
    ? locale === "en"
      ? `The workspace root on this machine is ${asFolder(root)} and ~ is ${homedir()}; write host paths from these, never guess.`
      : `工作区根在这台机器上是 ${asFolder(root)}，~ 是 ${homedir()}；要写宿主路径就照这两个写，不要猜。`
    : null;
  const dirLines = [rootLine, workDirLine].filter((line): line is string => !!line);
  const facts = taskId
    ? planFacts(store, { taskId, ticketId, turnId, triggerMessageId, botId: selfBotId, sessionId, locale })
    : null;
  const job = facts ? planLines(facts, locale) : [];
  if (store.getTurn(turnId).mode === "desk") {
    const candidates = store.deskCandidateIds(turnId).map((id) => {
      try {
        const plan = store.planCandidateEvidence(id);
        const activity = locale === "en" ? `Last activity: ${plan.lastActivityAt}` : `最后活动：${plan.lastActivityAt}`;
        const files = plan.recentArtifacts.length ? (locale === "en" ? `Recent artifacts: ${plan.recentArtifacts.join(", ")}` : `最近产物：${plan.recentArtifacts.join("、")}`) : "";
        const quote = plan.lastUserQuote ? (locale === "en" ? `Latest user words: ${oneLineClip(plan.lastUserQuote, 300)}` : `最近用户原话：${oneLineClip(plan.lastUserQuote, 300)}`) : "";
        return [ `${plan.id} · ${plan.title}`, activity, files, quote ].filter(Boolean).join(" · ");
      } catch { return `${id} · ${locale === "en" ? "no longer available" : "已不可用"}`; }
    });
    job.push(locale === "en"
      ? "Desk segment: read and reply before choosing a job; work_on selects only the captured candidates below."
      : "桌面段：先读与回答，work_on 只可选本轮已列出的候选。",
      ...candidates.map((line) => `- ${line}`));
    if (candidates.length === 1) job.push(locale === "en"
      ? "The first effect defaults to that job; if unrelated, use work_on({new}) and quote the user first."
      : "第一次副作用默认归到这件事；不相干就先 work_on({new}) 引用用户原话。" );
    else if (candidates.length === 0) job.push(locale === "en"
      ? "No captured candidates: a user's first effect opens one visible job and a produce ticket."
      : "没有候选：用户请求的第一次副作用会可见地新开一件事与产出任务。" );
    else job.push(locale === "en" ? "Choose with work_on before any effect; an ambiguous effect is refused." : "先 work_on 选定再动手；未选归属的副作用会被拒绝。");
  }
  // A read-only turn opens on the stop over it and what it may do, before anything else (ADR 0040).
  const held = readOnlyHeld(store, turnId, locale);
  if (sessionKind !== "group") {
    const lines = [...held, ...job, ...dirLines];
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
  const lines = [...held, membersLine, seatLine, wakerLine, latestLine, ...job];
  lines.push(...dirLines);
  return { role: "user", content: `${SITUATION_HEADING}\n\n${lines.join("\n")}` };
}

/** For a read-only turn, the line naming the stop over it — the newest you said, if you said one; else nothing. */
function readOnlyHeld(store: Store, turnId: string, locale: Locale): string[] {
  let mode;
  try {
    mode = store.getTurn(turnId).mode;
  } catch {
    return [];
  }
  if (mode !== "readonly") return [];
  const holds = store.turnHeldBy(turnId);
  let said: SaidLine = null;
  for (const hold of [...holds].reverse()) {
    if (!hold.source_message_id) continue;
    try {
      said = saidOf(store.getMessage(hold.source_message_id));
      break;
    } catch {
      // that line was cleared; an older stop may still name one
    }
  }
  return [readOnlyLine(locale, said)];
}

/**
 * How old a memory reads in the prompt, counted from when it was last written: a conclusion
 * rewritten today is today's. Bucketed rather than dated: an ISO timestamp would change the system
 * text every day and cost the prefix cache for no gain, and the Bot only has to know whether a
 * conclusion is fresh or stale. The messenger shows the same buckets.
 */
export function memoryAgeLabel(locale: Locale, writtenAt: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(writtenAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return locale === "en" ? "today" : "今天";
  if (days < 7) return locale === "en" ? "this week" : "本周";
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return locale === "en" ? `${weeks}w ago` : `${weeks} 周前`;
  const months = Math.floor(days / 30);
  return locale === "en" ? `${months}mo ago` : `${months} 个月前`;
}

/**
 * Two passes on purpose. The cut takes newest-written first, so when the budget ever bites it is
 * the stalest conclusion that falls out. The survivors then render oldest-written first: a new
 * memory lands at the end, where it costs the prefix cache least, and when two say different
 * things about the same matter the Bot can see which one is newer.
 */
export function memoryDigest(store: Store, botId: string, locale: Locale, now: Date = new Date()): MemoryPromptEntry[] {
  const kept: MemoryPromptEntry[] = [];
  let used = 0;
  for (const memory of store.listEnabledMemories(botId)) {
    const age = memoryAgeLabel(locale, memory.updated_at, now);
    const cost = memoryEntryCost(memory.subject, memory.body, age);
    if (used + cost > MEMORY_DIGEST_LIMIT) break;
    used += cost;
    kept.push({ subject: memory.subject, body: memory.body, age });
  }
  return kept.reverse();
}

function transcriptWindow(
  store: Store,
  input: {
    sessionId: string;
    turnId: string;
    triggerMessageId: string;
    selfBotId: string;
    /** What the pictures this turn has read already spend; the window gets what is left. */
    loopPictures: { images: number; bytes: number };
    locale: Locale;
  },
): ChatMessage[] {
  const trigger = store.getMessage(input.triggerMessageId);
  // A session carries more than one job, and a line from another plan or ticket says which.
  const tag = planTagger(
    store,
    { taskId: store.taskOfTurn(input.turnId), ticketId: store.ticketOfTurn(input.turnId) },
    input.locale,
  );
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
  const { images, cropsSent } = windowImages(store, unique, input.selfBotId, input.triggerMessageId, annotated, input.loopPictures);
  return unique.map((m) =>
    serializeTranscript(
      store,
      m,
      input.selfBotId,
      input.triggerMessageId,
      annotated.get(m.id)?.textFor(cropsSent.get(m.id) ?? 0) ?? "",
      images.get(m.id) ?? [],
      tag({ taskId: m.task_id ?? null, ticketId: m.ticket_id ?? null }),
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
 * Pictures the Bot read this turn with `read_file` ride the loop and come off the top of it.
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
  loopPictures: { images: number; bytes: number },
): { images: Map<string, ChatContentPart[]>; cropsSent: Map<string, number> } {
  const budget: VisionBudget = {
    images: Math.max(0, VISION_WINDOW_IMAGES - loopPictures.images),
    bytes: Math.max(0, VISION_WINDOW_BYTES - loopPictures.bytes),
    closed: false,
  };
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
  /** The line's plan and ticket when they are not this turn's; empty otherwise. */
  tag: string,
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
  // The Bot's own lines stay bare: a tag in its own voice is one it would start writing itself.
  if (message.kind === "bot" && message.author === selfBotId) {
    return { role: "assistant", content: `${triggerLine}${body}` };
  }
  const text = `${prefix(store, message)}${tag}\n${triggerLine}${body}`;
  return {
    role: "user",
    content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
  };
}

function visionImageParts(store: Store, attachments: Attachment[], budget: VisionBudget): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const att of attachments) {
    if (budget.closed) break;
    const mime = pictureMime(att.original_filename) ?? pictureMime(att.workspace_relpath);
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

export { trimToolContent } from "./tool-results";
