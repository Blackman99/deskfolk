import type { BuiltinModelRole } from "./models.ts";

/**
 * How one use of a built-in call came out (ADR 0083): `ok`, an answer read; `failed`, no answer to
 * read (no model, the call failed or ran out of time); `unreadable`, an answer that was not one.
 */
export type CallRunOutcome = "ok" | "failed" | "unreadable";

/**
 * What one use of a built-in call concluded, in the shape the flow board says it in. A reading by
 * the word lists, when no model read the line, says so (`by_words`).
 */
export type CallRunVerdict =
  | {
      kind: "user_line";
      control: "stop" | "go_on" | "both" | "none" | null;
      control_only: boolean;
      status_only: boolean;
      objections: string[];
      /** The hand-overs it let through (ADR 0084); absent in records from before. */
      passes?: string[];
      by_words: boolean;
    }
  | {
      kind: "bot_line";
      later: string | null;
      claims_verified: boolean;
      no_work: boolean;
      bare_status: boolean;
      go_ahead: boolean;
      by_words: boolean;
    }
  | {
      kind: "filing";
      about: "jobs" | "new" | "in_place" | "unclear";
      task_ids: string[];
      ticket_ids: string[];
      /**
       * On a board, the jobs and tickets it named, by id, as they are called now: the flow is where
       * a line's filing is seen (2026-10-14). Absent from the call's own record.
       */
      titles?: Record<string, string>;
    }
  | { kind: "scale"; large: boolean; quote: string | null; unit: string | null }
  | { kind: "scribe"; added: number; changed: number }
  | {
      kind: "organizer";
      mode: "message" | "settle";
      decision: "continue" | "new" | "resume" | "join" | null;
      applied: boolean;
      reject_reason: string | null;
      organizer_run_id: string | null;
    }
  | { kind: "judgement"; decision: "join" | "pass"; reason: string | null }
  | { kind: "composer"; suggestions: number }
  | { kind: "compaction"; hops: number; kept_hops: number }
  | { kind: "judge"; mode: string; passed: boolean | null; note: string | null }
  | { kind: "reflection"; proposed: boolean; note: string | null }
  | { kind: "retrospective"; findings: number; changes: number; summary: string | null };

/**
 * One use of one of the app's own model calls (ADR 0083): which call, what it was about, which
 * prompt and model it ran with, and what it concluded. A reading served again from the reader's
 * cache is a use of its own (`cached`), so every place a reading was applied shows on the flow.
 * Local and phone: on a job's trace as `steps` (without `raw`), whole at `GET /v1/call-runs/:id`.
 */
export type CallRun = {
  id: string;
  role: BuiltinModelRole;
  /** The built-in prompt it was asked with (`call.read_user_line`…); null when no call went out. */
  prompt_id: string | null;
  prompt_revision: string | null;
  prompt_locale: string | null;
  session_id: string | null;
  /** The line it was about: yours for a reading, filing, scribe or judgement. */
  message_id: string | null;
  /** The turn it ran in or for: a compaction, a Bot line's reading, a settle after it. */
  turn_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  /** The Bot it ran as or for: a judgement, a reflection, a retrospective. */
  bot_id: string | null;
  check_run_id: string | null;
  provider_id: string | null;
  model: string | null;
  thinking_level: string | null;
  outcome: CallRunOutcome;
  /** Why no answer was read, as the call's own log says it (`timeout`, `no_model`…). */
  fail_kind: string | null;
  verdict: CallRunVerdict | null;
  /** The model's answer as it came back, clipped. Null on the trace and when nothing came back. */
  raw: string | null;
  cached: boolean;
  spend_id: string | null;
  /** How long it took, the wait for a slot included; null when no call went out. */
  ms: number | null;
  /** The engine it ran under and how many times that engine had been changed (ADR 0085); absent before it. */
  playbook_id?: string | null;
  playbook_revision?: number | null;
  created_at: string;
};

/** A step of the flow board: a call's use without the model's answer, which is fetched when opened. */
export type TraceStep = Omit<CallRun, "raw">;
