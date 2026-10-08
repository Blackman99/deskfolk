import type { AllowRule, Approval, McpServer, Memory, Routine, Skill } from "./admin.ts";
import type { Bot } from "./bots.ts";
import type { Locale, USER_MEMBER } from "./constants.ts";
import type { Hold } from "./holds.ts";
import type { FilingState, Message, MessageFiling } from "./messages.ts";
import type { TaskDetail, Ticket } from "./plans.ts";
import type { Provider } from "./providers.ts";
import type { Judgement } from "./routing.ts";
import type { DelegationView, GroupLeadState, PendingJudgement, SessionSummary, Turn } from "./sessions.ts";
import type { Settings } from "./settings.ts";
import type { Spend } from "./spend.ts";
import type { CredentialOperation } from "./sync.ts";
import type { Terminal } from "./terminals.ts";

export type ClientEvent =
  | { event: "credential_operations.changed"; occurred_at: string; items: CredentialOperation[] }
  /** A built-in prompt changed (ADR 0064): reload it where it is shown. */
  | { event: "prompt.changed"; occurred_at: string; id: string; locale: Locale }
  | ({ event: "settings.changed"; occurred_at: string } & Settings)
  | ({ event: "bot.upsert"; occurred_at: string } & Bot & { deleted_at: string | null })
  | ({ event: "session.upsert"; occurred_at: string } & SessionSummary)
  | ({ event: "group_lead.changed"; occurred_at: string } & GroupLeadState)
  | ({ event: "delegation.changed"; occurred_at: string } & DelegationView)
  | { event: "session.removed"; occurred_at: string; id: string }
  | { event: "session.cleared"; occurred_at: string; id: string }
  | ({ event: "message.created" | "message.upsert"; occurred_at: string } & Message)
  | { event: "attribution.changed"; occurred_at: string; message_id: string; session_id: string; filing_state: FilingState; filings: MessageFiling[] }
  | ({ event: "turn.upsert"; occurred_at: string } & Turn)
  | { event: "turn.token"; occurred_at: string; turn_id: string; session_id: string; text: string }
  | {
      event: "turn.tool";
      occurred_at: string;
      turn_id: string;
      id: string;
      name?: string;
      arguments?: string;
      /**
       * `announced` is the model still writing the call out; `started` and `exited` bracket the
       * execution. Ephemeral like the rest of this event: the record that survives a reload is
       * the turn's, not this.
       */
      phase?: "announced" | "started" | "exited";
      /** On `started`: see {@link ToolFrame}'s fields of the same names. */
      target?: string;
      mcp_server?: string;
      mcp_tool?: string;
      exit_code?: number | null;
      duration_ms?: number;
      /**
       * On `exited`: whether the call succeeded, and its error's code when it did not
       * (`invalid_args`, `draining`, …). Both absent while it waits on an approval or an answer,
       * whose outcome only comes later.
       */
      ok?: boolean;
      error_code?: string;
    }
  | ({ event: "approval.upsert"; occurred_at: string } & Approval)
  | { event: "approval.removed"; occurred_at: string; id: string }
  | {
      event: "reaction.changed";
      occurred_at: string;
      message_id: string;
      actor: typeof USER_MEMBER | string;
      emoji: string;
      op: "add" | "remove";
    }
  | ({ event: "judgement.started"; occurred_at: string } & PendingJudgement)
  | ({ event: "judgement.created"; occurred_at: string } & Judgement)
  | {
      event: "judgement.ended";
      occurred_at: string;
      id: string;
      session_id: string;
      message_id: string;
      bot_id: string;
    }
  | ({ event: "spend.created"; occurred_at: string } & Spend)
  | { event: "spend.removed"; occurred_at: string; id: string }
  /** Billing rates changed and older rows were re-estimated. One per commit, not one per row. */
  | { event: "spend.repriced"; occurred_at: string }
  | ({ event: "routine.upsert"; occurred_at: string } & Routine)
  | { event: "routine.removed"; occurred_at: string; id: string }
  | ({ event: "skill.upsert"; occurred_at: string } & Skill)
  | { event: "skill.removed"; occurred_at: string; id: string }
  | ({ event: "memory.upsert"; occurred_at: string } & Memory)
  | { event: "memory.removed"; occurred_at: string; id: string }
  | ({ event: "mcp.upsert"; occurred_at: string } & McpServer)
  | { event: "mcp.removed"; occurred_at: string; id: string }
  | ({ event: "provider.upsert"; occurred_at: string } & Provider)
  | { event: "provider.removed"; occurred_at: string; id: string }
  | ({ event: "allow_rule.upsert"; occurred_at: string } & AllowRule)
  | { event: "allow_rule.removed"; occurred_at: string; id: string }
  | ({ event: "annotation.upsert"; occurred_at: string } & import("./annotations.ts").Annotation)
  | { event: "annotation.removed"; occurred_at: string; id: string }
  | ({ event: "notification.upsert"; occurred_at: string } & import("./notifications.ts").NotificationItem)
  | { event: "notification.removed"; occurred_at: string; id: string }
  | { event: "notification.summary"; occurred_at: string; summary: import("./notifications.ts").NotificationSummary }
  | ({ event: "notification_policy.changed"; occurred_at: string } & import("./notifications.ts").NotificationPolicy)
  // Lifecycle only — open, exit, gone. The bytes are a stream, not an event.
  | ({ event: "terminal.upsert"; occurred_at: string } & Terminal)
  | { event: "terminal.removed"; occurred_at: string; id: string }
  // A plan's spec or tickets moved; the board it is on refetches.
  | ({ event: "task.upsert"; occurred_at: string } & TaskDetail)
  | { event: "task.removed"; occurred_at: string; id: string }
  | ({ event: "ticket.upsert"; occurred_at: string } & Ticket)
  | { event: "ticket.removed"; occurred_at: string; id: string; task_id: string }
  // A hold was made, lifted, or recorded more of what it did. Holds are never deleted.
  | ({ event: "hold.upsert"; occurred_at: string } & Hold);
