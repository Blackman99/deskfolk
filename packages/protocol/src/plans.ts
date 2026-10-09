import type { AcceptanceCheck } from "./checks.ts";
import { USER_MEMBER } from "./constants.ts";
import type { Hold } from "./holds.ts";
import type { Retrospective } from "./quality.ts";
import type { RouteLearning, RouteRecord, RouteReview } from "./routing.ts";
import type { TurnStatus } from "./sessions.ts";

/** What a plan's entry lists: every path its messages cited that is still there, newest citation first. */
export type TaskArtifacts = {
  id: string;
  dir: string;
  title: string;
  closed_at: string | null;
  items: Array<{ path: string; last_cited_at: string; turn_id: string | null; ticket_id: string | null }>;
};

/** A plan (规划) is active until the organizer or you say it is done or parked. */
export type PlanStatus = "active" | "done" | "parked";

/** A ticket (任务) moves through these as the work does; done and parked close it. */
export type TicketStatus = "todo" | "doing" | "review" | "done" | "parked";

/**
 * A ticket's stage (ADR 0046, engine level 5): handed over (`submitted`), with its reviewer
 * (`in_review`), sent back (`rework`), passed (`approved`). Only a submission's checks, a review or
 * the app's no-reviewer approval moves it; `status` is written beside it (submitted and in_review
 * read review, rework reads doing, approved reads done, dropped reads parked).
 */
export type TicketStage = "todo" | "doing" | "submitted" | "in_review" | "rework" | "approved" | "dropped";

/** One hand-over of a ticket's work (ADR 0046): its files by content hash, the checks the app ran, the reviews it got. */
export type Submission = {
  id: string;
  work_item_id: string | null;
  task_id: string;
  ticket_id: string;
  part_keys: string[];
  bot_id: string;
  model: string | null;
  turn_id: string | null;
  /** `submit` when the Bot handed it over; `implicit` when the app did, for new files a segment cited in its ticket's folder. */
  origin: "submit" | "implicit";
  artifacts: Array<{ path: string; sha256: string }>;
  claims: Array<{ requirement_id: string; claim: string; evidence: string }>;
  note: string | null;
  state: "checking" | "checks_failed" | "submitted" | "in_review" | "approved" | "rejected" | "superseded";
  /** Each check the app ran on it: `gate` ones decide; the rest (your words not confirmed yet) are shown, never a block. */
  checks: Array<{ check_id: string; item: string; gate: boolean; outcome: string; detail: string }>;
  reviews: Array<{
    reviewer_bot_id: string;
    reviewer_model: string | null;
    /** The reviewer ran on the producer's own model. */
    same_model: boolean;
    turn_id: string;
    verdicts: Array<{ requirement_id: string; verdict: "pass" | "fail" | "unknown" | "n/a"; evidence: string[] }>;
    outcome: "approve" | "reject";
    note: string | null;
    at: string;
  }>;
  /** Its approval waiting on you: the required items nothing backs, the card that asks you, the review it would complete. */
  awaiting: {
    requirement_ids: string[];
    check_ids: string[];
    message_id: string | null;
    review: Submission["reviews"][number] | null;
    at: string;
  } | null;
  created_at: string;
  updated_at: string;
};

/** A part of a ticket (分件, ADR 0046): one shot or piece, from the plan's items, a delivered file's name, or you. */
export type TicketPart = {
  id: string;
  ticket_id: string;
  key: string;
  title: string;
  declared_by: "plan_items" | "filename" | "user";
  stage: "todo" | "in_progress" | "submitted" | "approved" | "rework" | "blocked" | "waived";
  owner_bot_id: string | null;
  current_artifact: string | null;
  attempts: number;
};

/**
 * A plan's spec (要点): what the organizer last understood the plan to be. Every field is the
 * app's reading of the conversation, revised as it goes; you can edit it, and each version is kept.
 */
export type PlanSpec = {
  /** A short label for what kind of job this is, which the organizer reuses across plans. */
  kind: string | null;
  goal: string;
  /** What counts as done: lines you write on the board (the organizer no longer writes them, ADR 0042). */
  acceptance: string[];
  /** Standing constraints and the preferences you stated, written the same way. */
  rules: string[];
  /** How the team goes about it, and who does which part. */
  process: string[];
  progress: { done: string[]; open: string[]; blocked: string[] };
  status: PlanStatus;
};

/** The smallest unit of a plan that hands something over, with its own folder inside the plan's. */
export type Ticket = {
  id: string;
  task_id: string;
  /** The ticket's number in its plan; the folder is `NN-slug/`. */
  seq: number;
  title: string;
  slug: string;
  dir: string;
  spec: string;
  status: TicketStatus;
  /** The Bot observed working on it, as a record, not an assignment. */
  worker: string | null;
  /**
   * Who the supervisor calls back to it (ADR 0045): the worker, written alongside it; for a ticket
   * older than the supervisor with no worker, the Bot with the most turns on it. Absent from a
   * daemon before that level.
   */
  owner_bot_id?: string | null;
  /** Tickets of the same plan this one waits for (ADR 0045); absent from a daemon before that level. */
  depends_on?: string[];
  /** Its stage (ADR 0046); null until engine level 5 moves it, and then read it before `status`. Absent from older daemons. */
  stage?: TicketStage | null;
  /** The Bot that reviews its submissions (ADR 0046), set on the board; never its owner; null for none. Absent from older daemons. */
  reviewer_bot_id?: string | null;
  /** The model its turns run on, set on the board from level 7 (ADR 0049): over the Bot's pin and default. Null for none. */
  model_override?: TicketModel | null;
  /**
   * The job's sample (样片, ADR 0060): the one unit made first to the full standard, which the job's
   * other tickets wait for and are compared with; you approve it yourself. Absent from older daemons.
   */
  sample?: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TicketArtifactRef = { path: string; message_id: string; attachment_id: string; exists?: boolean };

/**
 * Who has the ball on a ticket (ADR 0045), as the board shows it from engine level 4: a Bot (its
 * owner, the plan's lead, the Bot a delegation went to, its reviewer), the app (an approval due at
 * the next tick, a render it polls), or you (a question, something blocked, a stop, an approval, the
 * capability ceiling, or nobody on it). `since`: when a delegation went out.
 */
export type TicketBall = {
  kind: "owner" | "lead" | "delegation" | "reviewer" | "app" | "user";
  bot_id?: string | null;
  reason?: "approval" | "job" | "ask" | "blocked" | "held" | "held_dependency" | "waits" | "review" | "ceiling" | "unclaimed";
  since?: string;
  /** `waits`: the ticket it waits for, not through yet (ADR 0060) — nobody starts it meanwhile. */
  waits_for?: string;
};

export type TicketWithArtifacts = Ticket & {
  artifacts: TicketArtifactRef[];
  /** Its parts (ADR 0046): how many there are and how many passed (「11/12 已通过」); absent from older daemons. */
  parts?: { total: number; approved: number };
  /** From level 4, an open ticket's: who it waits on now. Absent on a closed ticket and below the level. */
  ball?: TicketBall;
};

/** One version of a plan's spec, with the tickets as they stood after it. */
export type TaskSpecRevision = {
  id: string;
  task_id: string;
  revision: number;
  actor: "app" | "user";
  spec: PlanSpec;
  tickets_snapshot: Ticket[];
  /** The message that prompted the organizer, when one did. */
  source_message_id: string | null;
  source_turn_id: string | null;
  /** The session that message is in, so the board can jump to it. */
  session_id: string | null;
  created_at: string;
  /**
   * `hold`: a hold of yours parked the plan, or lifting it put the plan back (ADR 0040); not a
   * filing by the organizer or you, though `actor` says app. Null for every other version; absent
   * from a daemon older than holds.
   */
  cause?: "hold" | null;
};

export type TicketCounts = Record<TicketStatus, number>;

/**
 * One card on a plan's trace: a turn that happened, with the files that turn handed over.
 * Computed when the trace is opened. The ticket it worked in is a record, not an assignment.
 */
export type TaskTraceNode = {
  turn_id: string;
  session_id: string;
  /** `user` for the card that stands for your own message; otherwise the Bot who took the turn. */
  actor: typeof USER_MEMBER | string;
  status: TurnStatus;
  /** The turn whose message woke this one. Null when you started it, or when that turn is elsewhere. */
  woken_by_turn_id: string | null;
  /**
   * Set when what woke this turn is not on this board: a Bot's handoff that belongs to another
   * job. Without it such a turn reads as though you sent the message yourself.
   */
  woken_elsewhere: { actor: string; message_id: string } | null;
  trigger_message_id: string;
  /**
   * The message to scroll to: the 中断 note on a cut turn, else the question or approval waiting on
   * you, else this turn's last part with words in it, else its last part (files only), else the trigger.
   */
  focus_message_id: string;
  /** One line, already clipped: the turn's last words; empty when it only handed over files. */
  summary: string;
  created_at: string;
  /** `exists` is set by the trace endpoint; absent from a daemon that predates it. */
  artifacts: Array<{ path: string; message_id: string; attachment_id: string; exists?: boolean }>;
  /** Set only while the turn is still waiting on you. */
  ask: { message_id: string; question: string } | null;
  approval: { message_id: string | null; summary: string } | null;
  /** Bots who watched the trigger instead of joining. Only the card that opened them carries it. */
  passed: number;
  /** The ticket this turn worked in; null on your own card and on turns filed under no ticket. */
  ticket_id: string | null;
  /**
   * The model choice this turn ran on and what came of it. Null on your own card and on a turn
   * older than model choices; absent altogether from a daemon that predates it.
   */
  route?: TaskTraceRoute | null;
};

/**
 * A Bot's turn that left no part of its own — moved on to a newer message, or finished without
 * speaking. Its summary is then the line that woke it, which on a card (or in the organizer's read of
 * the trace) reads as the Bot saying what the card above it said.
 */
export function traceNodeSaidNothing(node: Pick<TaskTraceNode, "actor" | "status" | "ask" | "approval" | "focus_message_id" | "trigger_message_id">): boolean {
  return (
    node.actor !== USER_MEMBER &&
    node.status !== "running" &&
    !node.ask &&
    !node.approval &&
    node.focus_message_id === node.trigger_message_id
  );
}

/** One card's model choice: the record, and the review and learning of the chain it started. */
export type TaskTraceRoute = {
  record: RouteRecord;
  /** Set on the turn that started a correction chain, once that chain has been reviewed. */
  review: RouteReview | null;
  /** What the learning hop kept for that chain, on the same turn. */
  learning: RouteLearning | null;
  /**
   * From engine level 8 (ADR 0050): whether you marked this turn's trouble as the model's, which
   * files a quality event in the model category. Absent below level 8.
   */
  marked_model?: boolean;
};

/** A job as one picture: the turns that share its work dir, across sessions. */
export type TaskTrace = {
  id: string;
  dir: string;
  title: string;
  /** The session the work dir was opened in. Null once that session is gone. */
  session_id: string | null;
  closed_at: string | null;
  nodes: TaskTraceNode[];
};

/** One row of the switcher: a plan this session took part in. */
export type SessionTaskSummary = {
  id: string;
  dir: string;
  title: string;
  session_id: string | null;
  closed_at: string | null;
  last_activity_at: string;
  /** The spec's goal, null until the organizer has run. */
  goal: string | null;
  kind: string | null;
  status: PlanStatus;
  ticket_counts: TicketCounts;
  /**
   * Set while the plan is set aside because its conversation was cleared or deleted (ADR 0040):
   * nothing files or calls back in it until it wakes. Absent from a daemon older than dormancy.
   */
  dormant_since?: string | null;
};

/**
 * Where an entry of the requirements ledger (需求台账, ADR 0040 P3) holds: one ticket, the plan, the
 * conversation the plan lives in and every plan in it (`project`), or every plan of a kind of work
 * (`standing`, `domain` saying which).
 */
export type RequirementScope = "part" | "ticket" | "plan" | "project" | "standing";

/**
 * What the board may do to an entry (`POST /v1/requirements/:id/action`), each only where it applies:
 * - `confirm`: a proposed entry or an old rule nobody found your words for is yours — in force from
 *   now; a proposed replacement takes the place of the entry it replaces.
 * - `reject`: it is not a requirement of yours.
 * - `waive`: an entry in force no longer holds.
 * - `not_here` / `here_again`: an entry this plan inherits does not hold for it, or holds again.
 * - `whole_project`: an entry of this plan holds for every plan of its conversation from now on.
 */
export type RequirementAction = "confirm" | "reject" | "waive" | "not_here" | "here_again" | "whole_project";

/** `POST /v1/requirements/:id/action`: the plan the board shows it on. Returns that plan's `TaskDetail`. */
export type RequirementActionRequest = { action: RequirementAction; task_id: string };

/**
 * One entry of the ledger as a plan's board shows it: your words, a Bot's restatement beside them,
 * how many times and in how many plans you said it, where it holds, where the words were said.
 */
export type PlanRequirement = {
  id: string;
  /** The ledger's own number, R-N, the same wherever the entry shows. */
  seq: number;
  quote: string;
  restated: string | null;
  category: string | null;
  polarity: "must" | "must_not";
  /** A number you gave (`duration`, `resolution`, `aspect` or `fps`), as the app read it from the words; null otherwise. */
  dimension: string | null;
  /** That number and its bound, as the app keeps it; null with `dimension`. */
  value: unknown;
  /** `unverified`: an old rule the app found none of your words for, shown for reference only. */
  status: "open" | "proposed" | "unverified";
  scope: RequirementScope;
  /** The ticket a ticket entry holds for; null otherwise. */
  ticket_id: string | null;
  domain: string | null;
  times_raised: number;
  /** In how many plans the words raising it were said. */
  plans_raised: number;
  last_raised_at: string;
  source_kind: "message" | "ask_answer" | "annotation" | "board" | "accepted_suggestion" | "legacy";
  /** The words it stands on and where they were said; `message_id` is null once the transcript is cleared. */
  source: { via: "message" | "ask_answer" | "annotation" | "board"; session_id: string | null; message_id: string | null; at: string } | null;
  /** Who wrote it down: `user`, `scribe`, `capture` (a complaint kept whole), `import` (an old rule). */
  added_by: string;
  /** The plan it was first said in, when that is another one: this plan inherits it. */
  inherited_from: { task_id: string; title: string } | null;
  /** You said it does not hold for this plan. */
  excluded: boolean;
  /** A proposed replacement: the entry it would replace, which stays in force until you choose. */
  supersedes: { id: string; seq: number; quote: string } | null;
};

/**
 * A plan's size as the app goes by it (ADR 0060): `large`, made as several units with a sample first;
 * `single`, one piece — only ever yours to say, and then nothing reads it as large again. `by`: the
 * reader (a model reading your words), the signal (work going round on it with nothing through), or
 * you. `why`: the words or facts it stands on; `unit`: what one unit of it is (「一场」「一章」).
 */
export type PlanScale = { value: "large" | "single"; by: "reader" | "signal" | "user"; at: string; why: string | null; unit: string | null };

/** One plan as the board reads it: the switcher row plus its spec, revision and tickets. */
export type TaskDetail = SessionTaskSummary & {
  /** Engine level 5 is on (ADR 0046): tickets have stages, parts passed and a reviewer to set. Absent below it. */
  submissions_on?: boolean;
  /** Engine level 4 is on (ADR 0045): tickets show who has the ball, and their dependencies can be set. Absent below it. */
  supervision_on?: boolean;
  /** Engine level 7 is on (ADR 0048): a ticket can be given the model its turns run on. Absent below it. */
  routing_on?: boolean;
  /**
   * Whether this is a large job (大活, ADR 0060): one laid out before anything is made, with a sample
   * you approve first. Null when nothing has read it as either. Absent from older daemons.
   */
  scale?: PlanScale | null;
  /** From level 5: the Bots that can review this plan's tickets (in its conversation, not archived); a ticket's owner is left out on its row. */
  reviewer_ids?: string[];
  brief: string | null;
  spec: PlanSpec | null;
  spec_updated_at: string | null;
  /** How many versions the spec has had; zero before the organizer first ran. */
  revision: number;
  revision_actor: "app" | "user" | null;
  /** The latest version's `cause`: `hold` when a hold of yours wrote it. Absent from a daemon older than holds. */
  revision_cause?: "hold" | null;
  routine_id: string | null;
  tickets: TicketWithArtifacts[];
  /** Active acceptance checks; absent from a daemon that predates them. */
  checks?: AcceptanceCheck[];
  /**
   * The holds in force over the plan as a whole — every Bot, as opposed to one Bot's work in it —
   * oldest first: yours on the plan, on the conversation it belongs to, or on everything. A global
   * one leaves `status` as it was, so this is how a client tells a plan nothing runs in. It is as of
   * when the plan was read: a hold that changes nothing on the plan's row — one on everything, say —
   * sends only `hold.upsert` when it is made and when it is lifted, so a client that shows this
   * reads the plan again on that event. Absent from a daemon that predates holds.
   */
  held_by?: Hold[];
  /**
   * The requirements ledger as it bears on this plan (ADR 0040 P3): its own entries, its tickets',
   * the ones it inherits from its conversation and the standing ones, in force, proposed or old
   * and unverified. Absent from a daemon older than the ledger.
   */
  requirements?: PlanRequirement[];
  /** When the plan last changed and what changed, in the app's language. Absent from an older daemon. */
  last_change?: { at: string; what: string } | null;
  /**
   * From level 8: the retrospectives its Bots made of it once it was delivered (ADR 0062), oldest
   * first; ones that ran or are running, not ones set aside. Absent below level 8 and from an older daemon.
   */
  retrospectives?: Retrospective[];
};

export type PatchTaskSpecRequest = {
  /** The whole spec as it should read after your edit. */
  spec: PlanSpec;
  /** The revision you edited from; a mismatch is refused so a concurrent change is not lost. */
  if_revision?: number;
};

/** A model on an endpoint, as a ticket's override names it. */
export type TicketModel = { provider_id: string; model: string };

/** At most this many rungs on the model ladder: a short climb, not a catalog. */
export const MODEL_LADDER_MAX = 8;

/** One rung of the model ladder (ADR 0054, level 7): a listed model, in the order you put them, weaker to stronger. */
export type ModelLadderRung = { provider_id: string; model: string };

/** `GET /v1/model-ladder` and `PUT /v1/model-ladder {items}`: the ladder, and whether this engine level has one. */
export type ModelLadderResponse = { items: ModelLadderRung[]; available: boolean };

export type PatchTicketRequest = {
  title?: string;
  spec?: string;
  status?: TicketStatus;
  worker?: string | null;
  /**
   * The tickets of the same plan this one waits for, replacing the list (ADR 0045): the supervisor
   * calls nobody back to it until they are done, and a stop over one of them stops it too.
   */
  depends_on?: string[];
  /** The Bot that reviews this ticket's submissions (ADR 0046), or null for none: not its owner. */
  reviewer_bot_id?: string | null;
  /** The model this ticket's turns run on (level 7), or null to go back to the Bot's own. */
  model_override?: TicketModel | null;
  if_revision?: number;
};
