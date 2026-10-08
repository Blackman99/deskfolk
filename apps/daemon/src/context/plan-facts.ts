/** Gathering what a turn is told about its plan: tickets, checks, quotes, requirements. */
import { USER_MEMBER, type AcceptanceCheck, type AcceptanceCheckOutcome, type Locale, type PlanStatus, type TicketStage, type TicketStatus } from "@real-bot/protocol";
import { existsSync } from "node:fs";
import { describeCheck } from "../acceptance-eval";
import { JOB_TRACE_LIMIT, sessionLabel } from "../context";
import { measureLabel, measureOf, sameAsk, unconfirmedNote } from "../derived-checks";
import type { DimensionValue } from "../quote-dimensions";
import { parsePlanSpec, type PlanSpec, type Store } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { classifyPath } from "../workspace-paths";
import { botDisplayName, BRIEF_LIMIT, oneLineClip, PLAN_TAG_TITLE_MAX, quoteTime } from "./common";
import { ELSEWHERE_LINES, OTHER_WORK_LINES, PLAN_CHECK_LINES, traceStateLabel } from "./plan-lines";

/** Files a job has handed over that the block lists; the newest cited come first. */
export const JOB_ARTIFACTS_LIMIT = 20;

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
  /** You renamed the plan after its goal was last written: the goal may be about what it was before. */
  goal_before_rename?: boolean;
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
  ticket: {
    id: string; seq: number; title: string; status: TicketStatus; stage?: TicketStage | null; spec: string; dir: string;
    /** Its parts, as declared; a hand-over names the ones it covers (ADR 0057: no file name makes one). */
    parts?: Array<{ key: string; title: string; stage: string }>;
  } | null;
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
  /**
   * A large job (大活, ADR 0060): what showed it, what one unit is, whether it is laid out yet, its
   * sample and how it stands, and the ticket this turn's ticket waits for. Absent for other jobs.
   */
  large?: {
    why: string | null; unit: string | null; laid_out: boolean;
    sample: { seq: number; title: string; stage: string } | null;
    waiting_on: { seq: number; title: string; sample: boolean } | null;
  };
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
/** The user's first and latest lines the quote layer carries (ADR 0040 P3). */
export const QUOTE_LAYER_HEAD = 4;
export const QUOTE_LAYER_TAIL = 6;
/** How much of one line of the user's the quote layer quotes. */
export const QUOTE_LAYER_BODY = 400;
/** How much of an entry's words one line of the block quotes. */
const REQUIREMENT_QUOTE_LINE = 200;
/** Files named on one ticket's line. */
const TICKET_ARTIFACT_LINES = 3;
/** Parts named on the turn's own ticket. */
const TICKET_PART_LINES = 30;

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
      const parts = store.listTicketParts(row.id).slice(0, TICKET_PART_LINES);
      ticket = { id: row.id, seq: row.seq, title: row.title, status: row.status, ...(row.stage ? { stage: row.stage } : {}), spec: row.spec, dir: row.dir,
        ...(parts.length > 0 ? { parts } : {}) };
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
    ...(spec?.goal && goalBeforeRename(store, input.taskId) ? { goal_before_rename: true } : {}),
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
    ...largeJobFacts(store, input.taskId, ticket?.id ?? null),
    ...reworkAsked(store, input.triggerMessageId),
  };
}

/** A large job's standing for the situation (ADR 0060); nothing for another job. */
function largeJobFacts(store: Store, taskId: string, ticketId: string | null): Pick<PlanFacts, "large"> {
  const scale = store.planScale(taskId);
  const sample = store.sampleOf(taskId);
  const waiting = ticketId ? store.waitingOn(ticketId) : null;
  if (scale?.value !== "large" && !sample && !waiting?.sample) return {};
  return { large: { why: scale?.why ?? null, unit: scale?.unit ?? null, laid_out: !store.layoutMissing(taskId),
    sample: sample ? { seq: sample.seq, title: sample.title, stage: sample.stage } : null,
    waiting_on: waiting ? { seq: waiting.seq, title: waiting.title, sample: waiting.sample } : null } };
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

/**
 * Whether you renamed the plan after its spec was last written: the goal then still says what the job
 * was before. On 2026-10-04 a job renamed 「做《一拳超人》动画」 kept the goal 「制作一部未来世界题材、
 * 时长超过2分钟…的短片」 at the head of every turn's picture; you told 视频导演 「制作《一拳超人》动画」
 * in its direct, and the goal still said otherwise — only you edit it, on the board.
 */
function goalBeforeRename(store: Store, taskId: string): boolean {
  const renamed = store.db.query<{ at: string }, [string]>(
    "SELECT at FROM work_events WHERE task_id = ? AND kind = 'plan.renamed' AND actor = 'user' ORDER BY seq DESC LIMIT 1").get(taskId)?.at;
  if (!renamed) return false;
  const written = store.db.query<{ at: string }, [string]>(
    "SELECT created_at AS at FROM task_spec_revisions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId)?.at;
  return !written || written < renamed;
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
            : quote.edit_of
              ? en ? `changed a line in ${place}` : `在${place}改了一句`
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
