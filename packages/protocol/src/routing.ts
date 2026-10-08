import type { ThinkingLevel } from "./models.ts";

/**
 * One organizer call (`apps/daemon/src/organizer.ts`): the message-filing pass or the settle pass
 * that keeps a session's plan and tickets in order. Written for every call that reached the model,
 * whether or not it ended up changing anything, so a filing that never lands is as visible as one
 * that did (ADR 0040 P0's observability: before this, the raw answer was never kept and a filing
 * that came to nothing left only a stderr line). Local-only: `GET /v1/debug/organizer-runs?task_id=`.
 */
export type OrganizerRun = {
  id: string;
  session_id: string;
  /** The session's current plan when the call was made; null when it had none yet. */
  task_id: string | null;
  mode: "message" | "settle";
  /** The message this filed, for a `message` run; null for a `settle`. */
  message_id: string | null;
  /** The ledger row this call was billed as; null when nothing was billable (it threw before answering). */
  spend_id: string | null;
  /** The model's answer, unparsed. Null when the call threw before one arrived. */
  raw_answer: string | null;
  /** Why the call itself did not produce an answer to parse; null once one did. */
  fail_kind: string | null;
  /** The parsed answer's decision — what actually applies, after candidate-set validation; null when nothing parsed. */
  decision: "continue" | "new" | "resume" | "join" | null;
  /** What the call could pick from: plan ids `resume`/`join` could name, and check ids it could edit — read before the call went out. */
  candidates_payload: { recent_plan_ids: string[]; elsewhere_plan_ids: string[]; existing_check_ids: string[] };
  /**
   * The answer's own picks, exactly as it named them, before candidate-set or format validation
   * narrowed them; null when nothing parsed. `decision` here is the string as written (which can
   * differ from the top-level `decision` once validation downgrades it, e.g. an unqualified
   * resume/join target falls back to "continue"; `downgrade_reason` says why). `resume_plan_id` is
   * set only beside a written `resume` and `join_plan_id` only beside a written `join`, so a stray
   * id beside another decision never puts a run on that plan's trail; `message_ticket` only on a
   * message run. `ticket_ids`/`check_ids` are the validated ones (format/roster checks only, not
   * subject to the race `downgrade_reason` describes).
   */
  candidates_apply: {
    decision: string;
    resume_plan_id: string | null;
    join_plan_id: string | null;
    ticket_ids: string[];
    message_ticket: string | null;
    check_ids: string[];
  } | null;
  /**
   * The candidate sets re-read once the call returned, right before validating the answer against
   * them — compare against `candidates_payload` to see whether they shifted while the call was out.
   * Null when nothing was parsed (no re-read happened).
   */
  candidates_at_parse: { recent_plan_ids: string[]; elsewhere_plan_ids: string[]; existing_check_ids: string[] } | null;
  /**
   * Why `decision` is not the `candidates_apply.decision` the answer wrote: a resume/join that named
   * no target, or one that no longer qualified once `candidates_at_parse` was read (the target
   * stopped qualifying while the call was out — the race ADR 0040 P1 fixes), a decision word that is
   * none of the four, or anything but continue from a settle. Null when the written decision is the
   * one that applies.
   */
  downgrade_reason: string | null;
  /** Whether this run's filing landed on the store. */
  applied: boolean;
  /** Why it did not, when `applied` is false; null when it did. */
  reject_reason: string | null;
  /**
   * Notes on a clean apply (`applied` true) that nonetheless held part of the answer back: a settle
   * that called the plan active while it stays parked, a settle field kept as it was because you
   * had said nothing new, tickets that kept a plan called done still active. Null when nothing was
   * held back.
   */
  held: string[] | null;
  /** The plan it actually landed on, once applied — can differ from `task_id` (`resume`, `join`, a new plan). */
  applied_task_id: string | null;
  applied_ticket_id: string | null;
  created_at: string;
};

export type Judgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  decision: "join" | "pass";
  reason: string | null;
  error: "timeout" | "invalid_output" | "endpoint_error" | null;
  created_at: string;
};

/** How the turn a model choice ran on ended; `null` while it is still live. */
export type RouteOutcome = "completed" | "failed" | "stopped" | "redirected" | "interrupted";

/** A user follow-up about the model itself, attributed to one decision. */
export type RouteFeedback = {
  message_id: string;
  body: string;
  created_at: string;
};

/**
 * The model and thinking level a turn ran on, who it was for, and how it went. One per turn; a
 * Bot's own records are the only ones that shape its later choices.
 */
export type RouteRecord = {
  turn_id: string;
  session_id: string;
  bot_id: string;
  trigger_message_id: string;
  provider_id: string | null;
  model: string;
  thinking_level: ThinkingLevel;
  /** The message kind the choice was made for (coding / writing / reasoning / simple / general). */
  signature: string;
  outcome: RouteOutcome | null;
  /** Completion failure kind when `outcome` is `failed`. */
  fail_kind: string | null;
  /** One line from the agent that picked this model, when an agent picked it. */
  reason: string | null;
  /** Turns the user kept pushing back on share one; the chain is reviewed as a whole. */
  chain_id: string | null;
  created_at: string;
  finished_at: string | null;
  /**
   * What the turn actually did, counted when it closed. Null means the process stopped before it
   * could count — unknown, not a clean zero.
   */
  hops: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  /** Failed calls whose name and arguments were identical to an earlier failure in the same turn. */
  repeated_failures: number | null;
  files_written: number | null;
  feedback: RouteFeedback[];
  /**
   * Why it ran on this model, from engine level 7 (ADR 0048/0049): `pin`, `default`,
   * `endpoint_default`, `pin_unlisted`, `ticket_override`, `capability_filter`, `escalation` or
   * `escalation_model`. Null when a per-turn pick chose.
   */
  reason_code?: string | null;
  /** Why the model was chosen before a step up or the picture filter moved it (ADR 0054); null when nothing moved it. */
  base_reason_code?: string | null;
};

/**
 * What later choices made of one review, counted locally from the rows that followed it.
 * `unknown` is a follow whose price or level could not be compared, and it never retires a review.
 */
export type RouteReviewEffect = "followed" | "not_followed" | "unknown";

/** What the learning hop wrote for one closed chain. `none` means it ran and kept nothing. */
export type RouteLearning = {
  chain_id: string;
  bot_id: string;
  session_id: string;
  kind: "memory" | "skill" | "none";
  /** The memory's subject or the skill's name. Empty when nothing was kept. */
  label: string;
  created_at: string;
  /** Same-kind chains after this one, and how many of them took fewer hops with no more errors. */
  outcome: { later: number; shorter: number } | null;
};

/** What the review made of one closed correction chain. */
export type RouteReview = {
  chain_id: string;
  turn_id: string;
  session_id: string;
  bot_id: string;
  signature: string;
  model: string;
  thinking_level: ThinkingLevel;
  /** `model` when the pick was the problem; `task` / `prompt` / `none` when it was not. */
  fault: "model" | "task" | "prompt" | "none";
  direction: "stronger" | "lighter" | "faster" | "cheaper" | "same";
  /** How many rounds the user spent correcting before moving on. */
  rounds: number;
  confidence: number;
  reason: string;
  created_at: string;
  /**
   * Set once the conclusion was followed twice without the later work getting cleaner. The row
   * stays for the record; the picker stops reading it.
   */
  retired_at: string | null;
  /** The next same-kind choice after this review, and whether that work was cleaner. */
  effect: { followed: RouteReviewEffect; cleaner: boolean } | null;
};
