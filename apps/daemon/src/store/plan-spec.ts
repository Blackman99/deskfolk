/**
 * A plan's spec over time, and the two ways it changes: the organizer's run and the user's edit.
 * Every change is a revision that names its cause — the message or turn that prompted it, or the
 * user — so the board can show how the goal moved. The organizer's ticket list is applied here
 * too, in one transaction with the spec, so a plan is never half-updated.
 */
import { ballHolder } from "./supervisor";
import { planScale } from "./large-jobs";
import { listRetrospectives } from "./retrospectives";
import type { AcceptanceCheck, TaskDetail, TaskSpecRevision, Ticket, TicketBall, TicketStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { applyOrganizerChecks, checkNeverRanSinceDefinition, checksHoldingPlanOpen, listChecks, rebindCheckItems, type OrganizerCheckInput } from "./acceptance-checks";
import { planHeldBy, setPlanStatusByUser } from "./holds";
import { boardLedgerOps, planRequirements } from "./plan-requirements";
import { normalizePlanSpec, parsePlanSpec, type PlanSpec } from "./plan-shape";
import { changedWords, recordQuote } from "./quotes";
import { settingsMap, type StoreContext } from "./shared";
import {
  elsewherePlans,
  getTask,
  openTask,
  reopenTask,
  sessionRecentTasks,
  setTaskSpec,
  taskLastActivityAt,
  taskSummary,
  taskTitle,
  wakeDormantPlan,
  type Task,
} from "./tasks";
import { recordWorkEvent } from "./work-events";
import { createTicket, isTicketStatus, listTickets, patchTicket, ticketArtifacts, ticketDependencies, ticketModel, TICKETS_MAX, type TicketRow } from "./tickets";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { noteBoardStatus, organizerSaysDone } from "./submissions";

export type SpecRevisionRow = {
  id: string;
  task_id: string;
  revision: number;
  spec: string;
  tickets_snapshot: string;
  source_message_id: string | null;
  source_turn_id: string | null;
  actor: "app" | "user";
  created_at: string;
  /** `hold`: written by a hold parking or restoring the plan, not by a filing (store/holds.ts). */
  cause: "hold" | null;
};

export function currentRevision(ctx: StoreContext, taskId: string): number {
  const row = ctx.db
    .query<{ n: number | null }, [string]>(`SELECT MAX(revision) AS n FROM task_spec_revisions WHERE task_id = ?`)
    .get(taskId);
  return row?.n ?? 0;
}

/**
 * When the spec was last filed — by the organizer or by you — else when the plan was opened: the
 * organizer reads what came after. A version a hold wrote files nothing, so it does not count: the
 * lines before the stop are still to be read.
 */
export function lastSpecRevisionAt(ctx: StoreContext, taskId: string): string {
  const row = ctx.db
    .query<{ at: string | null }, [string]>(`SELECT MAX(created_at) AS at FROM task_spec_revisions WHERE task_id = ? AND cause IS NULL`)
    .get(taskId);
  return row?.at ?? getTask(ctx, taskId).created_at;
}

function toRevision(ctx: StoreContext, row: SpecRevisionRow): TaskSpecRevision {
  let tickets: Ticket[] = [];
  try {
    const parsed = JSON.parse(row.tickets_snapshot) as unknown;
    if (Array.isArray(parsed)) tickets = parsed as Ticket[];
  } catch {
    tickets = [];
  }
  const sessionId = row.source_message_id
    ? (ctx.db.query<{ session_id: string }, [string]>(`SELECT session_id FROM messages WHERE id = ?`).get(row.source_message_id)?.session_id ?? null)
    : null;
  return {
    id: row.id,
    task_id: row.task_id,
    revision: row.revision,
    actor: row.actor,
    spec: parsePlanSpec(row.spec) ?? normalizePlanSpec({ goal: "…" })!,
    tickets_snapshot: tickets,
    source_message_id: row.source_message_id,
    source_turn_id: row.source_turn_id,
    session_id: sessionId,
    created_at: row.created_at,
    cause: row.cause,
  };
}

/** Newest first. */
export function listSpecRevisions(ctx: StoreContext, taskId: string, limit = 100): TaskSpecRevision[] {
  getTask(ctx, taskId);
  return ctx.db
    .query<SpecRevisionRow, [string, number]>(
      `SELECT * FROM task_spec_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT ?`,
    )
    .all(taskId, limit)
    .map((row) => toRevision(ctx, row));
}

export function recordSpecRevision(
  ctx: StoreContext,
  input: {
    taskId: string;
    spec: PlanSpec;
    sourceMessageId?: string | null;
    sourceTurnId?: string | null;
    actor: "app" | "user";
    cause?: "hold" | null;
    now?: string;
  },
): SpecRevisionRow {
  const now = input.now ?? isoNow();
  const id = ulid();
  const revision = currentRevision(ctx, input.taskId) + 1;
  ctx.db.run(
    `INSERT INTO task_spec_revisions
       (id, task_id, revision, spec, tickets_snapshot, source_message_id, source_turn_id, actor, created_at, cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.taskId,
      revision,
      JSON.stringify(input.spec),
      JSON.stringify(listTickets(ctx, input.taskId)),
      input.sourceMessageId ?? null,
      input.sourceTurnId ?? null,
      input.actor,
      now,
      input.cause ?? null,
    ],
  );
  return ctx.db.query<SpecRevisionRow, [string]>(`SELECT * FROM task_spec_revisions WHERE id = ?`).get(id)!;
}

function assertRevision(ctx: StoreContext, taskId: string, ifRevision: unknown): void {
  if (ifRevision === undefined || ifRevision === null) return;
  if (typeof ifRevision !== "number" || !Number.isInteger(ifRevision) || ifRevision < 0) {
    throw new HttpError(422, "invalid_args", "if_revision must be a non-negative integer");
  }
  if (ifRevision !== currentRevision(ctx, taskId)) {
    throw new HttpError(409, "revision_conflict", "the plan changed; reload before saving");
  }
}

/**
 * Your edit of the spec: validated like the organizer's, recorded as yours. A status other than
 * the one the plan shows is you stopping, resuming or accepting it, which holds carry once they are
 * on (`setPlanStatusByUser`); an edit that only sends back the status it was shown is none of those.
 */
/**
 * Your new name for a job (2026-10-03). A job is named after the line that opened it, and that line
 * can be a question about something else entirely — 《一拳超人》 was made for two days under 「让审片员
 * 回复视频导演，说明未回复原因并给出审片意见。」. Only you rename one: not the organizer, not a Bot.
 * Its folder keeps its name (the app never moves your files), and like any edit of yours on the
 * board, it takes a job set aside up again.
 */
export function renamePlanByUser(ctx: StoreContext, taskId: string, raw: unknown): Task {
  const before = getTask(ctx, taskId);
  if (typeof raw !== "string") throw new HttpError(422, "invalid_args", "title is a string");
  const title = taskTitle(raw);
  if (!title) throw new HttpError(422, "invalid_args", "a job needs a name");
  return ctx.db.transaction(() => {
    if (title !== before.title) {
      ctx.db.run("UPDATE tasks SET title = ? WHERE id = ?", [title, taskId]);
      recordWorkEvent(ctx, { kind: "plan.renamed", actor: "user", taskId, sessionId: before.session_id, payload: { before: before.title, after: title } });
    }
    wakeDormantPlan(ctx, taskId);
    return getTask(ctx, taskId);
  })();
}

export function setPlanSpecByUser(
  ctx: StoreContext,
  taskId: string,
  raw: unknown,
  ifRevision?: unknown,
): { task: Task; revision: SpecRevisionRow } {
  const before = getTask(ctx, taskId);
  const spec = normalizePlanSpec(raw);
  if (!spec) throw new HttpError(422, "invalid_args", "spec needs a goal");
  const beforeSpec = parsePlanSpec(before.spec);
  const beforeAcceptance = beforeSpec?.acceptance ?? [];
  return ctx.db.transaction(() => {
    assertRevision(ctx, taskId, ifRevision);
    const now = isoNow();
    setPlanStatusByUser(ctx, before, spec.status, now);
    // Editing a plan set aside is taking it up again (ADR 0040), whatever the edit was.
    wakeDormantPlan(ctx, taskId);
    const task = setTaskSpec(ctx, taskId, spec, now);
    rebindCheckItems(ctx, taskId, beforeAcceptance, spec.acceptance, now);
    const revision = recordSpecRevision(ctx, { taskId, spec, actor: "user", now });
    // What you wrote on the board is your words too (ADR 0040): the clauses of the goal you changed
    // (not the rest of it, which may be the organizer's words you only kept), and each Done-when
    // line and rule you brought in. The rest was already there.
    if (spec.goal !== (beforeSpec?.goal ?? "")) recordQuote(ctx, { via: "board", body: changedWords(beforeSpec?.goal ?? "", spec.goal), taskId, now });
    const beforeLines = [...beforeAcceptance, ...(beforeSpec?.rules ?? [])];
    const afterLines = [...spec.acceptance, ...spec.rules];
    const added = [...new Set(afterLines.filter((line) => !beforeLines.includes(line)))];
    const quoted = new Map<string, string | null>();
    for (const line of added) quoted.set(line, recordQuote(ctx, { via: "board", body: line, taskId, now })?.id ?? null);
    // And each such line is an entry of the requirements ledger, and each line taken out lets go
    // of the entry it was, with this version named as your action (ADR 0040 P3).
    boardLedgerOps(ctx, {
      taskId,
      added,
      removed: [...new Set(beforeLines.filter((line) => !afterLines.includes(line)))],
      quoteOf: (line) => quoted.get(line) ?? null,
      action: revision.id,
    });
    return { task, revision };
  })();
}

/** Your edit of one ticket, recorded as a revision of its plan so the history shows it. */
export function patchTicketByUser(
  ctx: StoreContext,
  ticketId: string,
  patch: { title?: unknown; spec?: unknown; status?: unknown; worker?: string | null; dependsOn?: unknown; reviewerBotId?: unknown; modelOverride?: unknown },
  ifRevision?: unknown,
): { ticket: Ticket; revision: SpecRevisionRow | null } {
  return ctx.db.transaction(() => {
    const before = ctx.db.query<TicketRow, [string]>(`SELECT * FROM tickets WHERE id = ?`).get(ticketId);
    if (!before) throw new HttpError(404, "not_found", "ticket not found");
    assertRevision(ctx, before.task_id, ifRevision);
    const ticket = patchTicket(ctx, ticketId, patch, { stage: { source: "user" } });
    // From level 5 your status stands over hand-overs still waiting on it (ADR 0046).
    if (ticket.status !== before.status) noteBoardStatus(ctx, ticketId);
    const changed =
      ticket.title !== before.title || ticket.spec !== before.spec || ticket.status !== before.status || ticket.worker !== before.worker
      || JSON.stringify(ticket.depends_on ?? []) !== JSON.stringify(ticketDependencies(before.depends_on))
      || (ticket.reviewer_bot_id ?? null) !== ((before as { reviewer_bot_id?: string | null }).reviewer_bot_id ?? null)
      || JSON.stringify(ticket.model_override ?? null) !== JSON.stringify(ticketModel(before.model_override));
    if (!changed) return { ticket, revision: null };
    wakeDormantPlan(ctx, ticket.task_id);
    // The clauses of a description you changed on the board are your words about that ticket (ADR 0040).
    if (ticket.spec !== before.spec) recordQuote(ctx, { via: "board", body: changedWords(before.spec, ticket.spec), taskId: ticket.task_id, ticketId });
    const task = getTask(ctx, before.task_id);
    const spec = parsePlanSpec(task.spec);
    const revision = spec ? recordSpecRevision(ctx, { taskId: task.id, spec, actor: "user" }) : null;
    return { ticket, revision };
  })();
}

/**
 * What of a plan as it stands you typed on the board yourself: the goal if you set it last, the Done
 * when lines and rules your edits brought in, and the tickets whose description you wrote last. Read
 * from every revision, not the latest few, since every drag of a ticket on the board is a revision
 * of yours too. The organizer leaves the goal and descriptions you typed alone; the one-time import
 * into the requirements ledger takes the rules and Done when lines you typed as yours
 * (`importLegacyRules`).
 */
export function userWrittenSpec(
  ctx: StoreContext,
  taskId: string,
): { goal: boolean; acceptance: string[]; rules: string[]; ticketIds: string[] } {
  const none = { goal: false, acceptance: [], rules: [], ticketIds: [] };
  if (!ctx.db.query(`SELECT 1 FROM task_spec_revisions WHERE task_id = ? AND actor = 'user' LIMIT 1`).get(taskId)) return none;
  const rows = ctx.db
    .query<Pick<SpecRevisionRow, "spec" | "tickets_snapshot" | "actor">, [string]>(
      `SELECT spec, tickets_snapshot, actor FROM task_spec_revisions WHERE task_id = ? ORDER BY revision ASC`,
    )
    .all(taskId);
  const ruleBy = new Map<string, SpecRevisionRow["actor"]>();
  const acceptanceBy = new Map<string, SpecRevisionRow["actor"]>();
  const specBy = new Map<string, SpecRevisionRow["actor"]>();
  let goal = "";
  let goalBy: SpecRevisionRow["actor"] | null = null;
  let acceptance: string[] = [];
  let rules: string[] = [];
  let specs = new Map<string, string>();
  for (const row of rows) {
    const parsed = parsePlanSpec(row.spec);
    if ((parsed?.goal ?? "") !== goal) goalBy = row.actor;
    goal = parsed?.goal ?? "";
    const lines = parsed?.acceptance ?? [];
    for (const line of lines) if (!acceptance.includes(line)) acceptanceBy.set(line, row.actor);
    acceptance = lines;
    const next = parsed?.rules ?? [];
    for (const rule of next) if (!rules.includes(rule)) ruleBy.set(rule, row.actor);
    rules = next;
    const snapshot = new Map<string, string>();
    try {
      const parsed = JSON.parse(row.tickets_snapshot) as unknown;
      if (Array.isArray(parsed)) for (const ticket of parsed as Ticket[]) snapshot.set(ticket.id, ticket.spec ?? "");
    } catch {
      // a snapshot that does not parse says nothing about who wrote what
    }
    for (const [id, spec] of snapshot) if (spec.trim() && spec !== specs.get(id)) specBy.set(id, row.actor);
    specs = snapshot;
  }
  const now = parsePlanSpec(getTask(ctx, taskId).spec);
  return {
    goal: goalBy === "user" && !!now?.goal && now.goal === goal,
    acceptance: (now?.acceptance ?? []).filter((line) => acceptanceBy.get(line) === "user"),
    rules: (now?.rules ?? []).filter((rule) => ruleBy.get(rule) === "user"),
    // A description changed since the last revision is no longer the one you wrote.
    ticketIds: listTickets(ctx, taskId)
      .filter((ticket) => specBy.get(ticket.id) === "user" && ticket.spec === specs.get(ticket.id))
      .map((ticket) => ticket.id),
  };
}

export type OrganizerTicketInput = {
  /** An existing ticket's id, or `new-N` for one the organizer wants opened. */
  id: string;
  /** Always there on a `new-N`; absent on an existing ticket the organizer only moved. */
  title?: string;
  spec: string;
  /** Absent leaves an existing ticket's status as it was; a `new-N` without one is todo. */
  status?: TicketStatus;
  /**
   * A Bot id, resolved by the parser from the name the organizer wrote. Absent leaves an existing
   * ticket's worker as it was: the organizer never clears one, only you do.
   */
  worker?: string | null;
};

export type OrganizerResult = {
  decision: "continue" | "new" | "resume" | "join";
  resumePlanId: string | null;
  /** A plan the Bots here are on in another session, which the line is about (`elsewherePlans`). */
  joinPlanId?: string | null;
  spec: PlanSpec;
  tickets: OrganizerTicketInput[];
  /** Which ticket the message that prompted this run is about: an id, a `new-N`, or null. */
  messageTicket: string | null;
  /**
   * Acceptance checks this run proposes, edits or removes. Applied only when this run lands on the
   * current plan or opens a new one (a `resume` or `join` never touches another plan's checks).
   */
  checks?: OrganizerCheckInput[];
  /**
   * The answer's own picks, exactly as written, before candidate-set or format validation narrowed
   * them into `decision`/`resumePlanId`/`joinPlanId`/`messageTicket` above — kept only so
   * `organizer.ts` can put what the model actually asked for on the `organizer_runs` row. Never read
   * by `applyOrganizerResult`. A target is kept only beside the decision that uses it (a resume id
   * beside `resume`, a join id beside `join`, a message ticket on a message filing), so a stray id
   * beside some other decision never reads as a pick.
   */
  raw?: { decision: string; resumePlanId: string | null; joinPlanId: string | null; messageTicket: string | null };
  /**
   * Why `decision` is not the decision `raw` wrote: a resume/join with no target, or one that no
   * longer qualified once the candidate set was re-read after the call returned (the organizer then
   * files nothing, ADR 0040 P1), a decision word that is none of the four, or anything but continue
   * from a settle. Null when the written decision is the one that applies.
   */
  downgradeReason?: string | null;
};

/**
 * A plan the organizer reads as done while some of its tickets are still to do or in progress is
 * not done: the run's other changes land, the plan stays active, and whoever looks at the board
 * sees what is left instead of a finished plan over untouched tickets. Tickets awaiting review
 * count as handed over. You can still close such a plan yourself.
 */
export function ticketsHoldingPlanOpen(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === "todo" || ticket.status === "doing");
}

/** Tickets one organizer run may open. More than this is the organizer rewriting the plan, not filing it. */
export const ORGANIZER_NEW_TICKETS_MAX = 10;

const NEW_TICKET = /^new-\d+$/;

/** How a ticket's title is matched: a `new-N` whose title is an existing ticket's is that ticket. */
export function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A resume or join whose plan stopped being one this session can go to between the answer being
 * read and applied. The answer was written for that plan, so continuing the current one with it,
 * or opening a plan when there is none, would file a copy of the job (ADR 0040 P1): nothing lands.
 */
function targetGone(decision: "resume" | "join", planId: string): HttpError {
  return new HttpError(409, "conflict", `the plan this ${decision} names (${planId}) is no longer one this line can go to`);
}

/**
 * The organizer's spec as it lands on a plan that stood at `before` (null for one it opens): its
 * rules and Done when are not taken (ADR 0042). What you ask of the work is kept from your own
 * words — the requirements ledger, which the scribe writes a patch at a time (scribe.ts) — and no
 * model's answer may rewrite it as a whole any more; on the plan, those two lists stay as they are:
 * what you wrote on the board, and whatever a filing before this left. The prompt no longer asks
 * for them either; this is what holds whatever an answer says.
 *
 * A settle takes less still: it files the handover, what the Bots did since, and never what the job
 * is for. The goal and kind stay as they were (a plan with no spec yet takes the answer's, or it
 * would never get one) and the plan is not parked by it; the process, the progress and a plan called
 * done still land. From level 5 (ADR 0046) hand-overs and approvals decide when the job is done, so
 * a settle does not reopen a done job either (its "done" is held back in `applyOrganizerResult`): on
 * 2026-10-04's real-model run a settle read the job 19 s after your 放行 delivered it again and,
 * having just seen your change, called it in progress — the board said 进行中 over a delivered job.
 * `kept` says what the answer asked for and did not get, for the log.
 *
 * `standing` is the plan's status as it is now, the task's own: a plan with no spec yet has one too,
 * and a plan a newer one displaced was parked without its spec being written again.
 */
function filedSpec(
  spec: PlanSpec,
  before: PlanSpec | null,
  settle: boolean,
  kept: string[],
  standing: PlanSpec["status"] = before?.status ?? "active",
  delivery = false,
): PlanSpec {
  const filed = { ...spec, acceptance: before?.acceptance ?? [], rules: before?.rules ?? [] };
  if (!settle) return filed;
  const reopens = delivery && standing === "done" && spec.status === "active";
  const status = reopens ? standing : spec.status === "parked" && standing !== "parked" ? standing : spec.status;
  if (before && spec.goal !== before.goal) kept.push("kept the goal as it was");
  if (status !== spec.status) kept.push(reopens ? "kept the job done: hand-overs and approvals decide it" : "did not park the plan");
  if (!before) return { ...filed, status };
  return { ...filed, kind: before.kind ?? spec.kind, goal: before.goal, status };
}

/** Whether a ticket description in an answer only repeats the one it has, or the one-line preview of it the organizer was shown. */
function echoesSpec(answer: string, stored: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return flat(stored).startsWith(flat(answer));
}

/**
 * What one organizer run changes, in one transaction: the plan it lands on, the spec, the tickets
 * (existing ones by id, new ones opened, absent ones untouched), and the stamp on the message it
 * was about. Returns what the engine needs to open turns in the right place.
 */
export function applyOrganizerResult(
  ctx: StoreContext,
  input: {
    sessionId: string;
    /** The session's current plan when the run started; null when it had none. */
    current: Task | null;
    result: OrganizerResult;
    source: { messageId: string | null; turnId: string | null; messageBody: string };
    now?: Date;
    /**
     * The revision of `current` the run was built on. When the plan has moved since (a line or an
     * edit of yours landed while the call was out), nothing is applied: the answer would undo it.
     */
    ifRevision?: number;
    /** A settle: only the handover lands (see {@link filedSpec}); an existing ticket keeps its title and any description it has. */
    settle?: boolean;
  },
): {
  task: Task;
  tickets: Ticket[];
  messageTicketId: string | null;
  revision: SpecRevisionRow;
  created: number;
  /** Tickets that kept a plan the organizer called done open; empty when it was not called done or nothing was left. */
  heldOpenBy: Ticket[];
  /** Checks that kept a plan the organizer called done open: failed, or never run since their definition. */
  heldByChecks: AcceptanceCheck[];
  /** `heldByChecks` is not empty and every one of them is holding it open only for lack of a run yet — none has failed. */
  awaitingEvidence: boolean;
  /** What a settle's answer asked for and did not get (the goal, a park, a ticket's title or description), one line each. */
  kept: string[];
} {
  // On the store's clock, like the lines it files: that clock runs ahead of the wall clock when it
  // is busy, and a version stamped by the wall clock could read as older than the line that made it,
  // which a settle would then take for something you said since.
  const now = input.now ? input.now.toISOString() : isoNow();
  const at = new Date(now);
  return ctx.db.transaction(() => {
    if (input.current && input.ifRevision !== undefined) assertRevision(ctx, input.current.id, input.ifRevision);
    const result = input.result;
    let target: Task | null = null;
    if (result.decision === "resume" && result.resumePlanId) {
      const candidates = sessionRecentTasks(ctx, input.sessionId);
      if (!candidates.some((task) => task.id === result.resumePlanId)) throw targetGone("resume", result.resumePlanId);
      reopenTask(ctx, result.resumePlanId, input.sessionId);
      target = getTask(ctx, result.resumePlanId);
    }
    // A job going on elsewhere takes the line without becoming this session's plan: its own
    // session keeps it, and this session's current plan stays where it was.
    if (result.decision === "join" && result.joinPlanId) {
      const candidates = elsewherePlans(ctx, input.sessionId);
      if (!candidates.some((task) => task.id === result.joinPlanId)) throw targetGone("join", result.joinPlanId);
      reopenTask(ctx, result.joinPlanId, input.sessionId);
      target = getTask(ctx, result.joinPlanId);
    }
    if (!target && result.decision !== "new") target = input.current;
    if (!target) {
      const body = input.source.messageBody.trim();
      target = openTask(ctx, {
        sessionId: input.sessionId,
        title: result.spec.goal || body,
        brief: body || result.spec.goal,
        kind: result.spec.kind,
        spec: filedSpec(result.spec, null, false, []),
        now: at,
      });
    }
    const settle = input.settle === true;
    const kept: string[] = [];
    // Read here, before this run touches the plan, and not from `input.current`: that copy was taken
    // before the call went out, and a rule you typed on the board while it was out is in the plan,
    // not in the copy (a line's filing carries no `ifRevision` to refuse the answer over it).
    const standing = getTask(ctx, target.id);
    // From level 5 only submissions, reviews and you move a ticket, and a plan is delivered when its
    // tickets are approved (ADR 0046): the organizer's statuses for tickets it did not just open, and
    // its "done" for the plan, are not written.
    const stageless = readEngineLevel(ctx.db) < ENGINE_LEVELS.submissions;
    const answered = filedSpec(result.spec, parsePlanSpec(standing.spec), settle, kept, standing.status,
      readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions);
    // A plan with no ticket to approve (none, or all dropped) may still be read as done.
    const ticketless = !ctx.db.query(`SELECT 1 FROM tickets WHERE task_id = ? AND status <> 'parked'`).get(target.id);
    const filed = !stageless && !ticketless && answered.status === "done" && standing.status !== "done" ? { ...answered, status: standing.status } : answered;
    // Its "done" on a ticket nothing was handed over on goes the no-reviewer way (ADR 0046).
    const doneReadings: string[] = [];
    // A resumed or joined plan is someone else's spec history to revise, not this run's own checks
    // to write: the organizer only touches checks on the plan it is continuing or opening.
    const appliesChecks = result.decision === "continue" || result.decision === "new";

    const existing = listTickets(ctx, target.id);
    const byId = new Map(existing.map((ticket) => [ticket.id, ticket]));
    const byTitle = new Map(existing.map((ticket) => [titleKey(ticket.title), ticket]));
    const placeholders = new Map<string, string>();
    let created = 0;
    for (const entry of result.tickets) {
      const known =
        byId.get(entry.id) ?? (NEW_TICKET.test(entry.id) && entry.title ? byTitle.get(titleKey(entry.title)) : undefined);
      if (known) {
        // A settle files where the ticket stands and who is on it, never what it is for: a title
        // and a description it already has stay (an empty one may still be filled).
        const described = settle && Boolean(known.spec.trim());
        if (settle) {
          const number = String(known.seq).padStart(2, "0");
          if (entry.title && titleKey(entry.title) !== titleKey(known.title)) kept.push(`kept ticket ${number}'s title`);
          if (described && entry.spec && !echoesSpec(entry.spec, known.spec)) kept.push(`kept ticket ${number}'s spec`);
        }
        try {
          // What the organizer left out says nothing about the ticket: an empty spec does not
          // erase one, and a missing title, status or worker keeps what is there.
          const next = patchTicket(
            ctx,
            known.id,
            {
              title: settle ? undefined : entry.title,
              spec: described ? undefined : entry.spec || undefined,
              status: stageless ? entry.status : undefined,
              worker: entry.worker,
            },
            { now: at },
          );
          byTitle.set(titleKey(next.title), next);
          if (!stageless && entry.status === "done") doneReadings.push(next.id);
          // The settle kept the old title, but the answer goes on calling the ticket by the new one:
          // a new-N of that name later in it is still this ticket, not a second one.
          if (settle && entry.title) byTitle.set(titleKey(entry.title), next);
          if (NEW_TICKET.test(entry.id)) placeholders.set(entry.id, known.id);
        } catch {
          // an entry the store refuses is dropped; the rest of the run still applies
        }
        continue;
      }
      if (!NEW_TICKET.test(entry.id) || !entry.title) continue;
      if (created >= ORGANIZER_NEW_TICKETS_MAX || existing.length + created >= TICKETS_MAX) continue;
      try {
        const ticket = createTicket(ctx, {
          taskId: target.id,
          title: entry.title,
          spec: entry.spec,
          status: stageless ? entry.status ?? "todo" : "todo",
          worker: entry.worker ?? null,
          now: at,
        });
        created += 1;
        if (!stageless && entry.status === "done") doneReadings.push(ticket.id);
        placeholders.set(entry.id, ticket.id);
        byId.set(ticket.id, ticket);
        byTitle.set(titleKey(ticket.title), ticket);
      } catch {
        // same: a bad title or a full plan drops the entry
      }
    }

    if (appliesChecks && result.checks?.length) {
      applyOrganizerChecks(ctx, { task: target, entries: result.checks, placeholders, now: at });
    }
    for (const ticketId of doneReadings) organizerSaysDone(ctx, ticketId, now);

    const heldOpenBy = filed.status === "done" ? ticketsHoldingPlanOpen(listTickets(ctx, target.id)) : [];
    const heldByChecks = filed.status === "done" ? checksHoldingPlanOpen(ctx, target.id) : [];
    const spec: PlanSpec = heldOpenBy.length > 0 || heldByChecks.length > 0 ? { ...filed, status: "active" } : filed;
    const task = setTaskSpec(ctx, target.id, spec, now);
    const revision = recordSpecRevision(ctx, {
      taskId: task.id,
      spec,
      sourceMessageId: input.source.messageId,
      sourceTurnId: input.source.turnId,
      actor: "app",
      now,
    });

    let messageTicketId: string | null = null;
    if (result.messageTicket) {
      const resolved = placeholders.get(result.messageTicket) ?? result.messageTicket;
      if (ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM tickets WHERE id = ? AND task_id = ?`).get(resolved, task.id)) {
        messageTicketId = resolved;
      }
    }
    if (input.source.messageId) {
      ctx.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [task.id, messageTicketId, input.source.messageId]);
    }
    const awaitingEvidence = heldByChecks.length > 0 && heldByChecks.every((check) => checkNeverRanSinceDefinition(check));
    return { task, tickets: listTickets(ctx, task.id), messageTicketId, revision, created, heldOpenBy, heldByChecks, awaitingEvidence, kept };
  })();
}

/** One plan as the board and the plan event read it: the switcher row plus spec, revision and tickets. */
/** Who an open ticket waits on, in the board's words (ADR 0045); nothing for a closed one. */
function ballOn(ctx: StoreContext, ticketId: string): { ball?: TicketBall } {
  const holder = ballHolder(ctx, { ticketId });
  switch (holder.kind) {
    case "closed":
      return {};
    case "delegation":
      return { ball: { kind: "delegation", bot_id: holder.botId, since: holder.since } };
    case "owner":
    case "lead":
    case "reviewer":
      return { ball: { kind: holder.kind, bot_id: holder.botId } };
    case "app":
      return { ball: { kind: "app", reason: holder.reason, ...(holder.reason === "waits" ? { waits_for: holder.ref } : {}) } };
    case "user":
      return { ball: { kind: "user", reason: holder.reason } };
  }
}

export function taskDetail(ctx: StoreContext, taskId: string, present: (path: string) => boolean): TaskDetail {
  const task = getTask(ctx, taskId);
  const withStages = readEngineLevel(ctx.db) >= ENGINE_LEVELS.submissions;
  // The ball only moves in a plan the supervisor looks at: active and not set aside. In a parked, done
  // or dormant one nothing waits on anybody, so no ticket there says it does.
  const withBall = readEngineLevel(ctx.db) >= ENGINE_LEVELS.supervision;
  const ballMoves = withBall && task.status === "active" && !task.dormant_since;
  const summary = taskSummary(ctx, task, taskLastActivityAt(ctx, taskId));
  const latest = ctx.db
    .query<{ revision: number; actor: "app" | "user"; cause: "hold" | null }, [string]>(
      `SELECT revision, actor, cause FROM task_spec_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(taskId);
  return {
    ...summary,
    brief: task.brief,
    spec: parsePlanSpec(task.spec),
    spec_updated_at: task.spec_updated_at,
    revision: latest?.revision ?? 0,
    revision_actor: latest?.actor ?? null,
    revision_cause: latest?.cause ?? null,
    routine_id: task.routine_id,
    checks: listChecks(ctx, taskId),
    held_by: planHeldBy(ctx, taskId),
    requirements: planRequirements(ctx, taskId),
    last_change: planLastChange(ctx, taskId),
    // What its Bots made of it once it was delivered (ADR 0062): only where retrospectives run.
    ...(readEngineLevel(ctx.db) >= ENGINE_LEVELS.learning ? { retrospectives: listRetrospectives(ctx, taskId) } : {}),
    ...(withBall ? { supervision_on: true } : {}),
    ...(readEngineLevel(ctx.db) >= ENGINE_LEVELS.routing ? { routing_on: true } : {}),
    // The job's size (ADR 0060): only where large jobs are on, and only once something has read it.
    ...(withStages ? { scale: planScale(ctx, taskId) } : {}),
    ...(withStages ? { submissions_on: true, reviewer_ids: ctx.db.query<{ id: string }, [string]>(`SELECT b.id FROM bots b
      JOIN session_participants sp ON sp.member = b.id AND sp.left_at IS NULL AND sp.session_id = (SELECT session_id FROM tasks WHERE id = ?)
      WHERE b.archived_at IS NULL AND b.deleted_at IS NULL ORDER BY sp.joined_at, b.id`).all(taskId).map((row) => row.id) } : {}),
    tickets: listTickets(ctx, taskId).map((ticket) => ({
      ...ticket,
      ...(ballMoves ? ballOn(ctx, ticket.id) : {}),
      // Parts passed only mean something once submissions approve them (level 5, ADR 0046).
      ...(withStages ? { parts: ctx.db.query<{ total: number; approved: number }, [string]>(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN stage = 'approved' THEN 1 ELSE 0 END), 0) AS approved FROM ticket_parts WHERE ticket_id = ? AND stage <> 'waived'`).get(ticket.id)! } : {}),
      artifacts: ticketArtifacts(ctx, ticket.id, present).map((row) => ({
        path: row.path,
        message_id: row.message_id,
        attachment_id: row.attachment_id,
        exists: true,
      })),
    })),
  };
}

const TICKET_STATUS_WORD: Record<TicketStatus, { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  doing: { zh: "进行中", en: "doing" },
  review: { zh: "待验收", en: "review" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

const OUTCOME_WORD: Record<string, { zh: string; en: string }> = {
  pass: { zh: "通过", en: "passed" },
  fail: { zh: "没过", en: "failed" },
  blocked: { zh: "受阻", en: "blocked" },
  error: { zh: "出错", en: "errored" },
};

const REQUIREMENT_EVENT_WORD: Record<string, { zh: (n: string) => string; en: (n: string) => string }> = {
  "requirement.add": { zh: (n) => `记下要求 ${n}`, en: (n) => `${n} written down` },
  "requirement.raise": { zh: (n) => `要求 ${n} 又说了一次`, en: (n) => `${n} said again` },
  "requirement.confirm": { zh: (n) => `你确认了 ${n}`, en: (n) => `you confirmed ${n}` },
  "requirement.reject": { zh: (n) => `你说 ${n} 不是要求`, en: (n) => `you said ${n} is no requirement` },
  "requirement.waive": { zh: (n) => `${n} 不再适用`, en: (n) => `${n} no longer holds` },
  "requirement.not_here": { zh: (n) => `${n} 不适用这件事`, en: (n) => `${n} set not to hold here` },
  "requirement.here_again": { zh: (n) => `${n} 又适用这件事`, en: (n) => `${n} holds here again` },
  "requirement.rescope": { zh: (n) => `${n} 适用得更广了`, en: (n) => `${n} holds more widely` },
};

/**
 * When the plan last changed, and what the change was, for the board's head (「上次变化 30 秒前
 * （…）」): the newest of its latest version, a ticket moving, a check's run, a turn in it, and a
 * change to its requirements, in the app's language. Read from rows already kept; nothing is
 * written to say it.
 */
export function planLastChange(ctx: StoreContext, taskId: string): { at: string; what: string } | null {
  const en = settingsMap(ctx).get("locale") === "en";
  const word = (pair: { zh: string; en: string }): string => (en ? pair.en : pair.zh);
  const seen: Array<{ at: string; what: string }> = [];
  const version = ctx.db
    .query<{ created_at: string; actor: string; cause: string | null }, [string]>(
      `SELECT created_at, actor, cause FROM task_spec_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(taskId);
  if (version) {
    const what = version.cause === "hold"
      ? word({ zh: "叫停改了它的状态", en: "a stop changed its status" })
      : version.actor === "user"
        ? word({ zh: "你改了要点", en: "you edited the plan" })
        : word({ zh: "要点整理了一版", en: "the plan was filed again" });
    seen.push({ at: version.created_at, what });
  }
  const ticket = ctx.db
    .query<{ seq: number; title: string; status: TicketStatus; updated_at: string }, [string]>(
      `SELECT seq, title, status, updated_at FROM tickets WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(taskId);
  if (ticket) {
    const number = String(ticket.seq).padStart(2, "0");
    seen.push({
      at: ticket.updated_at,
      what: en ? `ticket ${number} "${ticket.title}": ${TICKET_STATUS_WORD[ticket.status].en}` : `任务 ${number}《${ticket.title}》：${TICKET_STATUS_WORD[ticket.status].zh}`,
    });
  }
  const run = ctx.db
    .query<{ item: string; outcome: string | null; finished_at: string }, [string]>(
      `SELECT c.item, r.outcome, r.finished_at FROM acceptance_check_runs r JOIN acceptance_checks c ON c.id = r.check_id
       WHERE r.task_id = ? AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1`,
    )
    .get(taskId);
  if (run?.outcome) {
    const outcome = word(OUTCOME_WORD[run.outcome] ?? { zh: run.outcome, en: run.outcome });
    seen.push({ at: run.finished_at, what: en ? `check "${run.item}" ${outcome}` : `检查「${run.item}」${outcome}` });
  }
  const turn = ctx.db
    .query<{ name: string | null; status: string; last_activity_at: string }, [string]>(
      `SELECT b.name, t.status, t.last_activity_at FROM turns t LEFT JOIN bots b ON b.id = t.bot_id
       WHERE t.task_id = ? ORDER BY t.last_activity_at DESC LIMIT 1`,
    )
    .get(taskId);
  if (turn) {
    const who = turn.name ?? "?";
    seen.push({
      at: turn.last_activity_at,
      what: turn.status === "running" ? (en ? `${who} at work` : `${who} 正在做`) : en ? `${who}'s turn ended` : `${who} 的一轮结束了`,
    });
  }
  // Your new name for it is a change you made, and the latest one you would look for.
  const renamed = ctx.db
    .query<{ at: string; payload: string }, [string]>(`SELECT at, payload FROM work_events WHERE task_id = ? AND kind = 'plan.renamed' ORDER BY seq DESC LIMIT 1`)
    .get(taskId);
  if (renamed) {
    const after = (JSON.parse(renamed.payload) as { after?: string }).after ?? "";
    seen.push({ at: renamed.at, what: en ? `you renamed it "${after}"` : `你改名为《${after}》` });
  }
  const ledger = ctx.db
    .query<{ at: string; kind: string; payload: string }, [string]>(
      `SELECT at, kind, payload FROM work_events WHERE task_id = ? AND kind LIKE 'requirement.%' ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId);
  const phrase = ledger ? REQUIREMENT_EVENT_WORD[ledger.kind] : undefined;
  if (ledger && phrase) {
    const payload = JSON.parse(ledger.payload) as { requirement?: string; requirements?: string[] };
    const id = payload.requirement ?? payload.requirements?.[0];
    const seq = id ? ctx.db.query<{ seq: number | null }, [string]>(`SELECT seq FROM requirements WHERE id = ?`).get(id)?.seq : null;
    const name = seq ? `R-${seq}` : en ? "a requirement" : "一条要求";
    seen.push({ at: ledger.at, what: en ? phrase.en(name) : phrase.zh(name) });
  }
  return seen.reduce<{ at: string; what: string } | null>((latest, change) => (!latest || change.at > latest.at ? change : latest), null);
}

export function isTicketStatusValue(value: unknown): value is TicketStatus {
  return isTicketStatus(value);
}

/**
 * Whether a ticket of the plan went to review or done after `since`: a version recorded after then
 * shows it there while the version before did not, or the board now does while the last version
 * did not (the app's own move to review leaves no version). Only a ticket changed after `since`
 * can have moved after it. The plan watch's sign that a call-back moved something: rewording a
 * ticket that sits in review is no move, and a ticket sent back and handed over again is. Reads
 * only each version's ticket ids, statuses and times, not the specs they carry.
 */
export function ticketHandedOverSince(ctx: StoreContext, taskId: string, since: string): boolean {
  const rows = ctx.db
    .query<
      { revision: number; created_at: string; id: string | null; status: string | null; updated_at: string | null },
      [string, string, string]
    >(
      `SELECT r.revision, r.created_at,
              json_extract(j.value, '$.id') AS id,
              json_extract(j.value, '$.status') AS status,
              json_extract(j.value, '$.updated_at') AS updated_at
       FROM task_spec_revisions r LEFT JOIN json_each(r.tickets_snapshot) AS j
       WHERE r.task_id = ? AND r.revision >= COALESCE(
         (SELECT MAX(revision) FROM task_spec_revisions WHERE task_id = ? AND created_at <= ?), 0)
       ORDER BY r.revision ASC, j.key ASC`,
    )
    .all(taskId, taskId, since);
  type Seen = { status: string; updated_at: string | null };
  const versions = new Map<number, { at: string; board: Map<string, Seen> }>();
  for (const row of rows) {
    const version = versions.get(row.revision) ?? { at: row.created_at, board: new Map<string, Seen>() };
    versions.set(row.revision, version);
    if (row.id !== null && row.status !== null) version.board.set(row.id, { status: row.status, updated_at: row.updated_at });
  }
  const movedFrom = (before: ReadonlyMap<string, Seen>, board: ReadonlyMap<string, Seen>): boolean =>
    [...board].some(
      ([id, ticket]) =>
        (ticket.status === "review" || ticket.status === "done") &&
        (ticket.updated_at === null || ticket.updated_at > since) &&
        before.get(id)?.status !== ticket.status,
    );
  let before = new Map<string, Seen>();
  for (const { at, board } of versions.values()) {
    if (at > since && movedFrom(before, board)) return true;
    before = board;
  }
  const now = new Map(listTickets(ctx, taskId).map((ticket) => [ticket.id, { status: ticket.status, updated_at: ticket.updated_at }]));
  return movedFrom(before, now);
}
