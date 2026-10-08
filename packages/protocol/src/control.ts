import type { Hold } from "./holds.ts";
import type { Message } from "./messages.ts";
import type { ThinkingLevel } from "./models.ts";

/**
 * A button a line about your stops, or a restart notice, offers:
 * - `stop` / `continue`: make the stop, or lift what covers, `scopes`.
 * - `cancel`: stop, recorded as a stop you mean to drop the job with (`Hold.action` cancel); lifting it reopens the job.
 * - `undo`: lift the holds a receipt is about; a line of yours read as a stop then reaches the Bots as any line.
 * - `stop_all`: stop every Bot.
 * - `stop_plan`: stop the plan a receipt names too, the other Bots' work in it included (`MessageControl.plans`).
 * - `only_plan`: narrow a stop on a Bot to its work in the plan the receipt names; the rest of its work goes on.
 * - `continue_only`: let the Bots in `scopes` go on while a wider hold (on the group, on everything) stays for the rest.
 * - `continue_all`: lift that wider hold too.
 * - `resume` / `leave`: on a restart notice, go on with the work the restart cut off, or leave it as it is.
 * - `confirm_check`: on the app's line offering a check from your words, put it in force (for a
 *   replacement, in place of the check it would replace).
 * - `edit_check`: on the same line, start a line of your own giving the number instead; the
 *   messenger handles it (`MessageControl.edit_draft`), it is never sent.
 * - `remove_check`: on the app's line about checks from your words, remove those checks (for a
 *   replacement, turn it down and keep the check in force).
 * - `confirm_requirements`: on the app's line about old rules it found none of your words for,
 *   they are all yours: in force from now.
 * - `review_requirements`: on the same line, go through them one by one on the plan's board; the
 *   messenger handles it (opens the board), it is never sent.
 * - `make_standing` / `keep_project`: on the app's line suggesting that requirements you raised in
 *   two or more plans hold for every plan of that kind of work, do so, or leave them where they are.
 * - `undo_plan` / `merge_plan`: after user confirmation, stop and abandon a newly opened job;
 *   merge refiles only the card's quoted message into the selected existing job, never its turns or files.
 *   Neither action lifts holds or reverses effects already started.
 */
export const CONTROL_OFFERS = [
  "stop",
  "continue",
  "cancel",
  "undo",
  "stop_all",
  "stop_plan",
  "only_plan",
  "continue_only",
  "continue_all",
  "resume",
  "leave",
  "confirm_check",
  "edit_check",
  "remove_check",
  "confirm_requirements",
  "review_requirements",
  "make_standing",
  "keep_project",
  "undo_plan",
  "merge_plan",
  "confirm_item",
  "remove_item",
  "approve",
  "reject",
  "another_way",
  "another_plan",
  "relax",
  "accept",
  "rework",
  "dismiss",
  "confirm",
  "decline",
] as const;

export type ControlOffer = (typeof CONTROL_OFFERS)[number];

/**
 * The buttons the messenger handles itself and never sends (`edit_check` fills your composer,
 * `review_requirements` opens the board): every other one a line offers goes to
 * `POST /v1/messages/:id/control`, from the phone as from the window.
 */
export const CLIENT_ONLY_CONTROL_OFFERS: readonly ControlOffer[] = ["edit_check", "review_requirements"];

/**
 * Why the daemon started again (ADR 0041): `dev` for a development run (`bun --watch` restarts it
 * on every save), whatever ended the last one; otherwise `clean` after a deliberate stop (quit,
 * update, a restart you asked for), `crash` after any other end.
 */
export type RestartCause = "clean" | "crash" | "dev";

/** What a stop or a go on is about, in the terms a hold is made in. */
export type ControlScope = { scope: "global"; id: null } | { scope: "bot" | "session" | "plan"; id: string };

/** A button that names a plan: 「一起停下《…》」 (`stop_plan`) or 「只停《…》」 (`only_plan`). */
export type ControlPlanOffer = { offer: "stop_plan" | "only_plan"; task_id: string; title: string };

/**
 * A Bot's question from a job it ended as blocked (`end_turn({reason:"blocked", needs_from_user})`,
 * ADR 0045): a card that outlives the segment, answered with `POST /v1/messages/:id/work-answer`
 * rather than a button. `answer` is written once, with the request id that wrote it; answering
 * queues the job's work again and lifts none of your stops.
 */
export type WorkQuestionControl = {
  kind: "work_question";
  work_item_id: string;
  task_id: string;
  ticket_id: string | null;
  question: string;
  offer: [];
  /** This card has its own answer endpoint; this shared optional field is never written here. */
  acted?: ControlOffer[];
  answer?: { body: string; at: string; user_action_id: string; inbox_seq: number };
  /** When the job went on without an answer (a later question, a segment that ended, a close): from then on the card takes none. Never on an answered card. */
  superseded_at?: string;
};

export type WorkAnswerRequest = { body: string };
export type WorkAnswerResult = { message: Message; work_item_id: string; inbox_state: "queued" | "held"; answered: boolean };

/** What the supervisor's line says (ADR 0045): a ticket it stopped calling back, a job past its automatic retries, or one whose last external call has no known outcome. */
export type SupervisorNoticeCode = "stalled" | "retry_budget" | "unknown_effect";

/**
 * The supervisor's line in a conversation you are in (ADR 0045): facts about a job it will not move
 * on its own any more. It offers no buttons; @ the Bot, its 「继续」 or the board are how it goes on.
 */
export type SupervisorControl = {
  kind: "supervisor";
  code: SupervisorNoticeCode;
  task_id: string | null;
  ticket_id: string | null;
  work_item_id: string | null;
  offer: [];
  acted?: ControlOffer[];
};

/**
 * On one of your lines or the app's, what the app made of your stops or of a restart (ADR 0040 P2, ADR 0041):
 * - `possible_control`, on your line: it reads like a stop or a go on but has more in it, so nothing
 *   was done about it; the Bots got it as any line, and the buttons do what it may have meant.
 * - `receipt`, on the app's line: what a stop or a go on of yours did, from the holds' own record.
 * - `status`, on the app's line: where your stops stand when you asked (「停了吗」「你没停」) or
 *   said go on while a wider hold still covers the Bot; also its answer to a status question
 *   (「怎么样了」), which offers nothing and names no hold. With `unanswered`, said in place of a
 *   reply: your line that a stop let the Bot only answer read-only, and that answer said nothing;
 *   its go on buttons then also open the Bot's work on that line.
 * - `restart`, on the app's line after a restart (ADR 0041): a job the restart cut off. `notes` are
 *   the 「中断」 lines of its turns; 继续 (`resume`) continues each the way its own Continue would.
 * - `check`, on the app's line (ADR 0040 P3): a check from your words offered to you (`proposed`;
 *   `replacing` names the check in force it would replace, `times` how many separate lines of
 *   yours have said it when that is two or more), or checks you confirmed that found the job's
 *   final deliverable (`bound`). `edit_draft` is what its 改 puts in your composer. Since ADR 0058
 *   only a `proposed` card with `replacing` is put up; the others are older lines.
 * - `requirement`, on the app's line (ADR 0040 P3): old rules of the plan `task_id` with none of your
 *   words found for them (`legacy`), or craft requirements of one `category` you raised in two or
 *   more `domain` plans of the conversation, suggested to hold for every plan of `domain` (`standing`;
 *   the body quotes their words, and when the category's entries are in different words it names
 *   one entry alone). None is put up since ADR 0058; older lines keep their buttons.
 * - `work_question` ({@link WorkQuestionControl}) and `supervisor` ({@link SupervisorControl}), on
 *   lines the supervisor level writes (ADR 0045).
 * `acted` lists the buttons you pressed on it, in order; absent until you press one.
 */
export type MessageControl =
  | WorkQuestionControl
  | SupervisorControl
  | { kind: "possible_control"; offer: ControlOffer[]; scopes: ControlScope[]; acted?: ControlOffer[] }
  | {
      kind: "receipt";
      verb: "stop" | "continue";
      hold_ids: string[];
      offer: ControlOffer[];
      scopes: ControlScope[];
      /** The buttons that name a plan; absent when there are none. */
      plans?: ControlPlanOffer[];
      /** On a go on's receipt: the holds still over what it named, which `continue_only` / `continue_all` are about. */
      held_ids?: string[];
      acted?: ControlOffer[];
    }
  | { kind: "status"; hold_ids: string[]; offer: ControlOffer[]; scopes: ControlScope[]; unanswered?: string; acted?: ControlOffer[] }
  | { kind: "restart"; cause: RestartCause; notes: string[]; offer: ControlOffer[]; acted?: ControlOffer[] }
  | {
      kind: "check";
      event: "proposed" | "bound";
      check_ids: string[];
      offer: ControlOffer[];
      replacing?: string | null;
      times?: number;
      edit_draft?: string;
      acted?: ControlOffer[];
    }
  | {
      /**
       * A hand-over waiting on you (ADR 0046; one card per hand-over, ADR 0058 §13): `approve` or
       * `reject` decide the submission itself. `requirement_ids` are the required items nothing backs
       * that the card lists — said twice or more, or about the picture, with no passing check or
       * reviewer standing on them; empty when there are none — and `approve` takes them as met. A
       * card written before 2026-10-07 may ask about those items alone: `confirm_check` makes the
       * checks from your words in `check_ids` gates, `confirm_item` says the items are met for this
       * hand-over, `remove_item` stops requiring them in this plan.
       */
      kind: "review_item";
      submission_id: string;
      task_id: string;
      ticket_id: string;
      requirement_ids: string[];
      check_ids: string[];
      /** Whether an unconfirmed check named in `check_ids` is passing right now — a possible misread (ADR 0042): 「确认这条检查」 is then never the primary or first button. */
      checks_passing?: boolean;
      /**
       * The app's own line on the card, shown in place of the button's label or beside what is left
       * to press: what `approve` actually did (a gate failing sends it back, with its detail, rather
       * than a bare 已放行), that it waits on a check before approving, or why the card no longer
       * asks (a newer hand-over, your board edit).
       */
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A line of yours that reads as a complaint about work already handed over or approved (ADR
       * 0046, §6.6): which ticket, and which of its parts (empty: the whole ticket), and the line.
       * `rework` sends it back (then the card offers `undo`, with `result` saying so); `dismiss` leaves it.
       */
      kind: "rework";
      task_id: string;
      ticket_id: string;
      part_keys: string[];
      message_id: string;
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * The capability ceiling (ADR 0046, §6.6): a part (null: the whole ticket) failed the same
       * requirement three hand-overs in a row, or was handed over more than six times. `another_way`
       * and `another_plan` send it back with that direction, `relax` waives `requirement_id` for the
       * plan (offered only when there is one), `accept` takes it as it is.
       */
      kind: "ceiling";
      task_id: string;
      ticket_id: string;
      part_key: string | null;
      requirement_id: string | null;
      /** Why it no longer asks, when the ticket closed another way (approved, your board edit). */
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A reflection's proposal (ADR 0051, engine level 8): a checklist item for the Bot or a check for
       * the ticket. `confirm` adopts it, `decline` retires it; `result` says why an adopted check was not added.
       */
      kind: "lesson";
      lesson_id: string;
      task_id: string;
      ticket_id: string;
      result?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      /**
       * A Bot's default model, inferred from what it ran on most lately (ADR 0048, engine level 7):
       * `confirm` keeps it, `decline` drops it so the Bot runs on the endpoint's default. None is put
       * up since ADR 0058; older lines keep their buttons.
       */
      kind: "model_default";
      bot_id: string;
      provider_id: string;
      model: string;
      thinking_level: ThinkingLevel;
      offer: ControlOffer[];
      acted?: ControlOffer[];
    }
  | {
      kind: "requirement";
      event: "legacy" | "standing";
      requirement_ids: string[];
      task_id: string;
      category?: string;
      domain?: string;
      offer: ControlOffer[];
      acted?: ControlOffer[];
      /** A `legacy` card's old rules were all taken up or turned down elsewhere (the board) before any press: from then on it offers nothing. Never on a pressed card. */
      settled_at?: string;
    }
  | {
      /** Visible receipt for a newly opened job; actions stop it, never undo past external effects. */
      kind: "plan_opened";
      task_id: string;
      turn_id: string;
      quote_message_id: string;
      /** Existing jobs in the same project when the card was made; revalidated on a press. */
      merge_targets: Array<{ task_id: string; title: string }>;
      offer: ControlOffer[];
      acted?: ControlOffer[];
      /** What was retained when stopped. An attempted effect may have failed or still be settling. */
      retained_effects?: string[];
      merged_into?: string;
      user_action_id?: string;
    };

/**
 * `POST /v1/messages/:id/control`: a button on a line `control` marks. `action` is one the line
 * offers; `task_id` names the plan for `stop_plan` / `only_plan` / `merge_plan`. The line's `acted` records it, so
 * pressing one again does nothing more.
 */
/**
 * A press on one of the app's lines. `note`: with 退回 (`reject`) on a hand-over's card only, what you
 * want changed, passed on word for word to the Bot that made it (at most `CONTROL_NOTE_MAX` code
 * points); every other press refuses one.
 */
export type ControlActionRequest = { action: ControlOffer; task_id?: string; note?: string };

export const CONTROL_NOTE_MAX = 2000;

/**
 * What a control button did: the holds it made, and those it lifted. `partial` only on a restart
 * notice's 继续 that a stop of yours kept from some of its turns: how many went on and how many
 * that stop still holds. The notice is then left unanswered, so 继续 takes the rest after the lift.
 */
export type ControlActionResult = { made: Hold[]; lifted: Hold[]; partial?: { continued: number; held: number } };

/** One choice a Bot offers on a question. Labels are unique within the question. */
export type AskOption = {
  label: string;
  description?: string | null;
};

/**
 * The choices on a question. Single-select takes at most one; multi-select any number. Writing
 * your own answer is always open, beside or instead of the choices.
 */
export type AskSpec = {
  options: AskOption[];
  multi_select: boolean;
};

export type AskAnswer = {
  /** The chosen labels, in the order the question lists them. */
  selected: string[];
  /** What you wrote yourself; null when you only picked. */
  custom: string | null;
  answered_at: string;
};

/** `POST /v1/messages/:id/answer`: at least one choice or some text of your own. */
export type AnswerAskRequest = {
  selected?: string[];
  custom?: string | null;
};

export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 8;
/** Code points. */
export const ASK_LABEL_MAX = 80;
export const ASK_DESCRIPTION_MAX = 200;
export const ASK_CUSTOM_MAX = 4000;
