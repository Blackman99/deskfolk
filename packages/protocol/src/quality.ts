import type { AcceptanceCheckInput } from "./checks.ts";

/** What went wrong with the work, filed by the event's own type (ADR 0050, engine level 8). */
export type QualityCategory = "model" | "pipeline" | "execution" | "review_miss" | "unclear" | "orchestration";

export type QualityEvent = {
  id: string;
  /** `checks_failed`, `review_rejected`, `user_rejected`, `complaint`, `review_miss`, `ceiling`, `failure_shape:<kind>`, `tool_timeout`, … */
  kind: string;
  category: QualityCategory;
  task_id: string | null;
  ticket_id: string | null;
  part_key: string | null;
  submission_id: string | null;
  requirement_id: string | null;
  bot_id: string | null;
  model: string | null;
  turn_id: string | null;
  message_id: string | null;
  work_event_seq: number | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/** One row of the offline report: a Bot on a model, on one kind of plan, over the window asked for. */
export type QualityReportRow = {
  bot_id: string;
  /** Null once the Bot is deleted. */
  bot_name: string | null;
  model: string | null;
  plan_kind: string | null;
  hand_overs: number;
  approved: number;
  review_rejected: number;
  user_rejected: number;
  checks_failed: number;
  complaints: number;
  failure_shapes: number;
  review_misses: number;
  cost_usd: number | null;
  cost_per_approved: number | null;
};

/** A rule the app learned from a failure and checks itself (ADR 0050). */
export type Lesson = {
  id: string;
  scope: "bot" | "role" | "project" | "tool" | "global";
  scope_id: string | null;
  hook: "before_tool" | "before_generate" | "before_submit" | "before_review";
  /** A shell lesson's kind of call (`tool` shell); a reflection's (`tool` reflection, ADR 0051) carries the check it proposes and, adopted, its id. */
  detector: { tool: string; signature: string; head: string; place: string; error: string; check?: AcceptanceCheckInput; check_id?: string };
  /** `warn` holds a call back once per turn; `block` refuses it; `checklist` is read in the Bot's situation; `propose_check` became a check. */
  action: "warn" | "block" | "checklist" | "propose_check";
  text: string;
  evidence: Array<{ turn_id: string | null; at: string; seconds?: number; recurrence?: boolean; quality_event_id?: string; ticket_id?: string }>;
  status: "candidate" | "active" | "retired";
  hits: number;
  prevented: number;
  recurrences: number;
  created_by: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LessonPatch = { status?: "active" | "retired"; action?: "warn" | "block"; text?: string };

/**
 * A project skill (ADR 0052, engine level 8): a copy of one Bot's skill you shared, read by every Bot
 * of the workspace. `source_changed`: the owner's skill was edited since you shared it.
 */
export type SharedSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  uses: string[];
  source_skill_id: string | null;
  source_bot_id: string | null;
  source_bot_name: string | null;
  enabled: boolean;
  source_changed: boolean;
  confirmed_at: string;
  created_at: string;
  updated_at: string;
};

/** `GET /v1/shared-skills`: the project skills, and whether sharing is on (engine level 8). */
export type SharedSkillsResponse = { items: SharedSkill[]; available: boolean };

/** Which retrospective last wrote a memory or a skill, on which plan: what its card says beside it. */
export type RetrospectiveOrigin = { id: string; task_id: string; plan_title: string | null };

/** A memory or a skill as one retrospective change found it or left it: a memory's subject, a skill's name and description, and the body. */
export type RetrospectiveSide = { subject?: string; name?: string; description?: string; body: string };

/**
 * One change a retrospective made to its own Bot's memories or skills (ADR 0062), with what it
 * replaced. `not_applied` says why in `reason`; `undone` is one you took back on the board.
 */
export type RetrospectiveChange = {
  kind: "memory" | "skill";
  op: "remember" | "forget" | "edit" | "create";
  /** The memory's subject or the skill's name. */
  label: string;
  /** The memory or skill it wrote; for a forget, the one it deleted. Null when nothing was written. */
  target_id: string | null;
  before: RetrospectiveSide | null;
  after: RetrospectiveSide | null;
  /** The Bot's own reason, in a sentence. */
  why: string;
  status: "applied" | "not_applied" | "undone";
  /**
   * Why it was not made, as a code the window words in your language: `off` (you turned it off),
   * `full`, `over_cap` (past what one retrospective may change), `unchanged`, `missing`,
   * `project_skill` (shared by you, not the Bot's to change), `name_taken`, `project_name`,
   * `too_long:<field>`, `required:<field>`, `edit_missing:<n>`, `edit_repeated:<n>:<times>`,
   * `edit_not_one_sentence:<n>`, `edit_unread:<n>` (too long to read: only added to at its end),
   * `drops:<names>` (it would lose these from the skill), `refused`.
   */
  reason?: string;
  undone_at?: string;
};

/** What a retrospective made of an earlier conclusion of its Bot's: still holding, broken again here, or no longer true. */
export type RetrospectiveVerdict = { conclusion: string; verdict: "held" | "recurred" | "obsolete" };

/**
 * A retrospective (完工复盘, ADR 0062, engine level 8): once a plan was delivered and stayed so for
 * half an hour, a Bot that made something in it looked back once, on its own model, over the job's
 * record — what tripped it up, what made you send work back, what to keep — and wrote what it
 * concluded into its own memories and skills. Nothing waits on you: each change can be taken back.
 */
export type Retrospective = {
  id: string;
  task_id: string;
  bot_id: string;
  /** The delivery it looked back on; a plan reopened and delivered again gets another. */
  delivered_at: string;
  state: "pending" | "done" | "failed";
  model: string | null;
  summary: string | null;
  pitfalls: string[];
  rework_causes: string[];
  keep: string[];
  earlier: RetrospectiveVerdict[];
  changes: RetrospectiveChange[];
  /** Why it failed (`call_failed`, `unreadable`, `interrupted`), or why it changed nothing. */
  note: string | null;
  created_at: string;
  finished_at: string | null;
};
