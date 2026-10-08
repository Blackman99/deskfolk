/**
 * What a hold (叫停) covers. `bot_plan`'s `scope_id` is `<bot id>:<plan id>`; `global`'s is null.
 * A hold on a plan or a conversation also reads as that plan being parked (ADR 0040).
 */
export type HoldScope = "global" | "bot" | "session" | "plan" | "ticket" | "bot_plan" | "turn";

/** Something a hold covers besides its own scope, fixed when it was made (a Bot's handoffs, say). */
export type HoldTarget = { scope: Exclude<HoldScope, "global">; id: string };

/**
 * What a hold changed, for the confirmation you get and for putting things back when it is lifted.
 * Only ever added to.
 */
export type HoldEffect = {
  /**
   * Plans the hold set to parked, with what lifting it puts back: in progress, done, or `aside` —
   * a plan a newer one had moved out of its conversation's current slot (parked in its status, in
   * progress in its spec), which goes back to just that.
   */
  parked_plans?: Array<{ task_id: string; prior: "active" | "done" | "aside" }>;
  /** Check-backs set aside while it holds; they come back when it is lifted. */
  suspended_check_backs?: string[];
  /** On lifting: the plans put back, and the check-backs pending again. */
  restored_plans?: string[];
  resumed_check_backs?: string[];
  /** Turns the hold ended, with what each was doing when it did: what the receipt lists, and what goes on once it is lifted. */
  stopped_turns?: HeldTurn[];
  /** Turns another hold ended that this one still covered when that one was lifted: they go on when this one is. */
  held_over?: HeldTurn[];
  /** On lifting: the stopped turns that went on, each in a new turn opened with a note. */
  resumed_turns?: string[];
  /** Turns of other Bots working in the same plans when the hold was made, which it does not cover. */
  working_beside?: Array<{ turn_id: string; bot_id: string; task_id: string | null; ticket_id: string | null }>;
  /** Turns it covers still running once it had ended what it covers; empty unless something went wrong. */
  still_running?: string[];
  /** Turns found running under it later, when you said the work had not stopped, and ended then. */
  violations?: string[];
  /**
   * Your lines it turned into read-only answers: the Bot could only answer them. The go on that
   * lifts it hands them back, the last one per Bot, conversation and job opening that Bot's turn.
   */
  answered_lines?: AnsweredLine[];
  /** On lifting: the turns opened on lines of yours it had turned into read-only answers. */
  taken_up_turns?: string[];
};

/** A line of yours a Bot could only answer read-only while a hold covered it, and the turn that answered it. */
export type AnsweredLine = { message_id: string; bot_id: string; turn_id: string };

/** A turn a hold ended: where it ran, on what, and what it had done so far. */
export type HeldTurn = {
  turn_id: string;
  bot_id: string;
  session_id: string;
  task_id: string | null;
  ticket_id: string | null;
  /** Files it wrote, newest last. */
  written: string[];
  /** Its last few tool calls, oldest first, the last one what it was doing when it was stopped. */
  recent: string[];
};

/** Your stop, written down as state: nothing it covers starts or wakes until you lift it. */
export type Hold = {
  id: string;
  scope: HoldScope;
  scope_id: string | null;
  /** `cancel` is a stop that also asks whether to drop the job. */
  action: "pause" | "cancel";
  /** Whether it reaches the work a Bot handed on, as well as the Bot's own. */
  cascade: boolean;
  /** `legacy`: a plan parked before holds existed, taken over as one. */
  source: "user_text" | "user_button" | "legacy" | "migration";
  source_message_id: string | null;
  /**
   * Set on the hold a Stop makes, and on one a group's stop menu makes: your next line about it (in
   * that job; in that group, to that Bot) lifts it. Never on a stop on everything.
   */
  lift_on_next_user_message: boolean;
  targets: HoldTarget[];
  effect: HoldEffect;
  created_at: string;
  lifted_at: string | null;
  lifted_by: "user_text" | "user_button" | null;
  lifted_message_id: string | null;
  /**
   * The title of the plan a hold on a plan, on one Bot's work in a plan, or on a ticket names, as it
   * reads now; null for any other scope. Absent from a daemon that predates it.
   */
  plan_title?: string | null;
};

/** `POST /v1/holds`: a stop you make from a button or a menu. */
export type CreateHoldRequest = {
  scope: HoldScope;
  /** Omitted or null only for `global`. */
  scope_id?: string | null;
  action?: "pause" | "cancel";
  cascade?: boolean;
  lift_on_next_user_message?: boolean;
  /** The conversation you made it from (a stop menu there): the app's receipt goes there when you are in it. */
  session_id?: string | null;
};
