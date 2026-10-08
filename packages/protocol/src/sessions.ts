import type { USER_MEMBER } from "./constants.ts";
import type { Message } from "./messages.ts";
import type { ListPage } from "./runtime.ts";

export type SessionKind = "direct" | "group";

/** Evidence proposes a group lead; only a user's explicit confirmation assigns one. */
export type GroupLeadState = {
  session_id: string;
  confirmed_bot_id: string | null;
  suggestion: { bot_id: string; handoffs: number; since: string } | null;
};

export type ConfirmGroupLeadRequest = { bot_id: string | null; confirmed: true };

/** The durable handoff projected for the plan and its existing Bot↔Bot direct, not guessed from prose. */
export type DelegationView = {
  id: string;
  task_id: string;
  ticket_id: string | null;
  thread_session_id: string;
  from_bot_id: string;
  to_bot_id: string;
  ask: string;
  expects: "deliverable" | "review" | "answer";
  status: "open" | "replied" | "cancelled";
  part_keys: string[];
  requirement_ids: string[];
  created_at: string;
  request_message_id: string | null;
  result_message_id: string | null;
  reply: { body: string; created_at: string; ref: string | null } | null;
  wait: { state: "waiting" | "held"; since: string; due_at: string | null } | null;
};

export type SessionParticipant = {
  member: typeof USER_MEMBER | string;
  joined_at: string;
  left_at: string | null;
};

export type Session = {
  id: string;
  kind: SessionKind;
  name: string | null;
  last_read_at?: string | null;
  read_through_seq?: number;
  archived_at?: string | null;
  /** The session whose message opened this one. Only a Bot↔Bot direct has one. */
  origin_session_id: string | null;
  /** The message that opened this session; the entry point to it hangs under that message. */
  origin_message_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A Bot a message has woken that has no turn yet; it shows as thinking under that message.
 * `judging`: an unnamed group member deciding whether to join. `organizing`: your message is
 * still being filed, and no turn or judgement opens until it has. A row without it is `judging`.
 */
export type PendingJudgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  stage?: "organizing" | "judging";
  created_at: string;
};

export type SessionSummary = Session & {
  participants: SessionParticipant[];
  last_message?: Message | null;
  live_turns?: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
  /**
   * A card here still waits on your press, read or not: a hand-over to approve or send back, or a
   * tool approval (`approval`); a question or a default-model pick (`ask`). The Dock badge counts
   * these besides unread lines, and with no turn live, the row is the only place to see where they
   * are. Null when nothing waits; absent from an older daemon.
   */
  waiting_on_you?: SessionWaitingOnYou | null;
  notification_preference?: import("./notifications.ts").SessionNotificationPreference;
};

export type SessionWaitingOnYou = "approval" | "ask";

export type TurnStatus =
  | "running"
  | "waiting_approval"
  | "waiting_ask"
  | "completed"
  | "redirected"
  | "interrupted"
  | "stopped";

export type Turn = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  /** The plan this turn's intermediate files belong to. Null on turns from before work dirs. */
  task_id?: string | null;
  /** The ticket this turn works in, whose folder is its default cwd. */
  ticket_id?: string | null;
  /** The durable unit this segment executes; absent on older daemons' turns. */
  work_item_id?: string | null;
  end_reason?: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  partial_text?: string | null;
  pending_ask_id?: string | null;
  routine_id?: string | null;
  routine_due_at?: string | null;
  /** What the turn may do (ADR 0040); null on turns an older build opened. */
  mode?: TurnMode | null;
  /**
   * The tool call it is running right now, on a live turn read through the API: what a window that
   * missed its `turn.tool` start (opened later, a phone reconnecting) shows instead of 「思考中」 —
   * on 2026-10-04 a `qlmanage` that hung for ten minutes read 「思考中」 the whole time.
   */
  running_tool?: TurnRunningTool | null;
};

/** A tool call a live turn is running: `turn.tool`'s start frame, with when it started. */
export type TurnRunningTool = { id: string; name: string; target?: string; mcp_server?: string; mcp_tool?: string; started_at: string };

/**
 * `work`: an ordinary turn. `readonly`: the one kind a hold lets open, the turn a line of yours
 * opens to answer you, with nothing that has an effect. `desk`: a later phase's.
 */
export type TurnMode = "work" | "desk" | "readonly";

export type SessionDetail = Session & {
  participants: SessionParticipant[];
  messages: ListPage<Message>;
  turns: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
  notification_preference?: import("./notifications.ts").SessionNotificationPreference;
};

export type CreateGroupRequest = {
  name: string;
  members: string[];
};

/**
 * `POST /v1/sessions/:id/clear` (and `DELETE /v1/sessions/:id/messages`) and `DELETE /v1/sessions/:id`.
 * The transcript goes either way; what you said there is kept apart from it unless `erase_quotes`
 * erases it too (ADR 0040). A daemon older than kept words deletes it with the transcript, and its
 * remote whitelist refuses the field: the clients send it only when you ticked the box, so an
 * unticked clear reads the same to every daemon.
 */
export type ClearSessionRequest = {
  erase_quotes?: boolean;
};

export type PostMessageRequest = {
  body: string;
  parent_id?: string | null;
  fork?: boolean;
  ask_id?: string | null;
  /**
   * Files already in the workspace, attached as they are (no copy into `inbox/`). Multipart
   * carries the list as one JSON-encoded field.
   */
  paths?: string[];
};

export type MemberRequest = {
  bot_id: string;
};

export type ReactionRequest = {
  emoji: string;
};

export type StopRequest = {
  turn_id?: string;
};

export type ContinueRequest = {
  message_id: string;
};

/**
 * One command a turn ran, for the card under its reply once the turn has ended
 * (`GET /v1/turns/:id/commands`, oldest first, `shell` only, the turn's first 80 calls).
 */
export type TurnCommand = {
  /** The tool call's id; the record's own on rows from before it was kept. */
  id: string;
  /** The command line, its whitespace folded and clipped to 300 code points. */
  command: string;
  exit_code: number | null;
  ok: boolean;
  duration_ms: number | null;
  /** The last 4000 code points of what it printed, stdout then stderr; null when it printed nothing. */
  output: string | null;
  created_at: string;
};

export type TurnCommandsResponse = { items: TurnCommand[] };
