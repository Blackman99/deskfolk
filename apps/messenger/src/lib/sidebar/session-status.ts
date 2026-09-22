import { INTERRUPT_NOTE_BODY, type Approval, type Message, type PendingJudgement, type SessionSummary, type Turn } from "@real-bot/protocol";
import { isLiveStatus } from "../chat/transcript.ts";

export type SessionStateKind =
  | "running"
  | "replying"
  | "waiting_approval"
  | "waiting_ask"
  | "failed"
  | "interrupted"
  | "idle";

export type SessionStatusResult = {
  kind: SessionStateKind;
  label: string;
  isBusy: boolean;
  count?: number;
};

export type StatusLabels = {
  running: string;
  replying: string;
  waitingApproval: string;
  waitingAsk: string;
  failed: string;
  interrupted: string;
  idle: string;
};

/** The transcript line a failed turn leaves behind, in either locale. */
const FAIL_NOTE = /^(这一轮没写完：|This turn did not finish:)/;

export function sessionStatus(
  sessionId: string,
  turns: readonly Turn[],
  approvals: readonly Approval[],
  labels: StatusLabels,
  pendingJudgements: readonly PendingJudgement[] = [],
): SessionStatusResult {
  return workStatus(
    turns.filter((turn) => turn.session_id === sessionId),
    approvals,
    pendingJudgements.filter((j) => j.session_id === sessionId),
    labels,
  );
}

export function botWorkStatus(
  botId: string,
  turns: readonly Turn[],
  approvals: readonly Approval[],
  labels: StatusLabels,
  pendingJudgements: readonly PendingJudgement[] = [],
): SessionStatusResult {
  return workStatus(
    turns.filter((turn) => turn.bot_id === botId),
    approvals,
    pendingJudgements.filter((j) => j.bot_id === botId),
    labels,
  );
}

export function sidebarStatus(
  session: SessionSummary,
  turns: readonly Turn[],
  approvals: readonly Approval[],
  labels: StatusLabels,
  pendingJudgements: readonly PendingJudgement[] = [],
  messages: readonly Message[] = [],
): SessionStatusResult {
  const live = sessionStatus(session.id, turns, approvals, labels, pendingJudgements);
  if (live.kind !== "idle") return live;
  return settledNotice(session, messages, labels) ?? live;
}

/**
 * A finished failure or interruption has no live turn, so the list would otherwise fall back to
 * the last line of body text. The row is where that state belongs once there is no inbox page.
 */
function settledNotice(
  session: SessionSummary,
  messages: readonly Message[],
  labels: StatusLabels,
): SessionStatusResult | null {
  const last = latestVisibleMessage(session, messages);
  if (!last || last.kind !== "system") return null;
  if (last.body === INTERRUPT_NOTE_BODY) {
    return { kind: "interrupted", label: labels.interrupted, isBusy: false };
  }
  if (FAIL_NOTE.test(last.body)) {
    return { kind: "failed", label: labels.failed, isBusy: false };
  }
  return null;
}

function latestVisibleMessage(
  session: SessionSummary,
  messages: readonly Message[],
): Message | null {
  let latest: Message | null = null;
  for (const message of messages) {
    if (message.session_id !== session.id || message.kind === "profile_change") continue;
    if (!latest || message.created_at > latest.created_at || (message.created_at === latest.created_at && message.id > latest.id)) {
      latest = message;
    }
  }
  if (latest) return latest;
  const summary = session.last_message;
  if (!summary || summary.kind === "profile_change") return null;
  return summary;
}

function workStatus(
  scopedTurns: readonly Turn[],
  approvals: readonly Approval[],
  pendingJudgements: readonly PendingJudgement[],
  labels: StatusLabels,
): SessionStatusResult {
  const liveTurns = scopedTurns.filter((turn) => isLiveStatus(turn.status));
  const turnIds = new Set(scopedTurns.map((t) => t.id));
  const pendingApprovalsCount = approvals.filter(
    (a) => a.status === "pending" && turnIds.has(a.turn_id),
  ).length;

  const hasWaitingApproval = liveTurns.some((t) => t.status === "waiting_approval");
  if (hasWaitingApproval || pendingApprovalsCount > 0) {
    return {
      kind: "waiting_approval",
      label: labels.waitingApproval,
      isBusy: false,
      count: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
    };
  }

  const hasWaitingAsk = liveTurns.some((t) => t.status === "waiting_ask");
  if (hasWaitingAsk) {
    return {
      kind: "waiting_ask",
      label: labels.waitingAsk,
      isBusy: false,
    };
  }

  const hasReplying = liveTurns.some(
    (t) => t.status === "running" && Boolean(t.partial_text?.trim()),
  );
  if (hasReplying) {
    return {
      kind: "replying",
      label: labels.replying,
      isBusy: true,
    };
  }

  const hasRunning = liveTurns.some((t) => t.status === "running");
  if (hasRunning || pendingJudgements.length > 0) {
    return {
      kind: "running",
      label: labels.running,
      isBusy: true,
    };
  }

  return {
    kind: "idle",
    label: labels.idle,
    isBusy: false,
  };
}
