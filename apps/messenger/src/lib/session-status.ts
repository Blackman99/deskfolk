import type { Approval, PendingJudgement, SessionSummary, Turn } from "@real-bot/protocol";
import { isLiveStatus } from "./transcript.ts";

export type SessionStateKind = "running" | "replying" | "waiting_approval" | "waiting_ask" | "idle";

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
  idle: string;
};

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
): SessionStatusResult {
  return sessionStatus(session.id, turns, approvals, labels, pendingJudgements);
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
