import type { USER_MEMBER } from "./constants.ts";
import type { AskAnswer, AskSpec, MessageControl } from "./control.ts";

export type MessageKind ="user" | "bot" | "ask" | "approval" | "profile_change" | "system";

export type Attachment = {
  id: string;
  message_id: string;
  workspace_relpath: string;
  original_filename: string;
  created_at: string;
  exists?: boolean;
  is_dir?: boolean;
  size?: number | null;
  mime?: string | null;
};

export type Reaction = {
  message_id: string;
  actor: typeof USER_MEMBER | string;
  emoji: string;
  created_at: string;
};

export type FilingState = "filed" | "undetermined" | "none";

/** A message can belong to more than one plan; task_id remains the primary legacy projection. */
export type MessageFiling = {
  task_id: string;
  ticket_id: string | null;
  part_key: string | null;
  filed_by?: string;
  strength?: "locked" | "default" | "bot" | "user";
  is_primary?: boolean;
};

/** Your new name for a job; its folder keeps its name. */
export type RenamePlanRequest = { title: string };
/** `PATCH /v1/tasks/:id` with your word on the job's size (ADR 0060): `single` and nothing reads it as large again. */
export type SetPlanScaleRequest = { scale: "large" | "single" };

export type PatchMessageAttributionRequest = {
  filings: Array<{ plan_id: string; ticket_id?: string | null; part_key?: string | null }>;
};

/** 「新开一件事」: a line of yours opens a job of its own (named after it, or `title`) and is filed there. */
export type NewJobFromLineRequest = {
  new_plan: { title?: string | null };
};

export type Message = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_id: string | null;
  kind: MessageKind;
  author: typeof USER_MEMBER | string;
  body: string;
  source_turn_id: string | null;
  /** The plan this message belongs to; the anchor its artifact entry opens. */
  task_id?: string | null;
  /** The ticket it was filed under, when the organizer or its turn said so. */
  ticket_id?: string | null;
  /** Explicitly unfiled (none), awaiting a choice, or filed to the targets below. */
  filing_state?: FilingState;
  filings?: MessageFiling[];
  /**
   * A batch of annotations on an artifact from a Bot↔Bot direct lands in your direct with that
   * Bot, with no parent to quote; this points back at the message the artifact came from.
   */
  annotation_source_message_id?: string | null;
  /** On an `ask`: the choices the Bot offered, or null for a plain question. */
  ask?: AskSpec | null;
  /** On an `ask`: your answer, recorded on the question itself instead of as a message of yours. */
  ask_answer?: AskAnswer | null;
  created_at: string;
  message_seq?: number;
  attachments: Attachment[];
  reactions: Reaction[];
  /**
   * What the app read or did about your stops on this line (ADR 0040 P2), the restart it tells of
   * (ADR 0041), or that the line is its answer to a status question; absent on every other line.
   */
  control?: MessageControl;
  /**
   * On a line of yours that reached a Bot while it worked (ADR 0040 P4a): where it stands in that
   * turn's inbox. Absent on every other line, and from a daemon that predates the inbox.
   */
  delivery?: MessageDelivery;
  /**
   * On a line of yours you changed after sending it (ADR 0063): when you last did. Null or absent
   * on a line never changed, and from a daemon that cannot edit.
   */
  edited_at?: string | null;
  /**
   * On a line of yours the app carried out itself rather than handing it to a Bot (`app`: a stop,
   * a go on or a status question it answered), or took as your answer to a Bot's question
   * (`answer`). Neither can be edited: the stop was made, the question was answered once.
   */
  taken_as?: MessageTakenAs | null;
};

/** What became of a line of yours that never reached a Bot as a line (`Message.taken_as`). */
export type MessageTakenAs = "app" | "answer";

/** `PATCH /v1/messages/:id`: the new words of a line of yours (ADR 0063). */
export type EditMessageRequest = { body: string };

/** One earlier wording of a line you changed, and when it was written. */
export type MessageVersion = { body: string; created_at: string };

/** `GET /v1/messages/:id/versions`: what the line said before, oldest first, not counting what it says now. */
export type MessageVersionsResponse = { versions: MessageVersion[] };

/**
 * Where an inbox item stands (ADR 0040 P4a). `queued`: waiting for the turn's next step. `held`: a
 * stop of yours covers it; it waits for the lift. `delivered`: the turn read it, at `hop`. Then what
 * the Bot said it did with it — `adopted`, `answered`, `declined`, `deferred` — or `unacked` when
 * the turn ended without saying. `merged` and `superseded` are the app's: taken up some other way.
 */
export type InboxState =
  | "queued"
  | "held"
  | "delivered"
  | "adopted"
  | "answered"
  | "declined"
  | "deferred"
  | "unacked"
  | "merged"
  | "superseded";

/** What a Bot says it did with a line of yours, in `end_turn`'s `inbox`. */
export type InboxDisposition = "adopted" | "answered" | "declined" | "deferred";

export const INBOX_DISPOSITIONS: readonly InboxDisposition[] = ["adopted", "answered", "declined", "deferred"];

/** A line of yours in a working Bot's inbox, as the line shows it: 已送达 → 第 N 跳读到 → 采纳 / 不采纳. */
export type MessageDelivery = {
  bot_id: string;
  state: InboxState;
  /** The step of the turn that read it; null until one did. */
  hop: number | null;
  /** The Bot's word with what it did: why it declined, say. */
  note: string | null;
};
