import { INTERRUPT_NOTE_BODY, type Approval, type Message, type PendingJudgement, type SessionSummary, type Turn } from "@real-bot/protocol";
import { isLiveStatus } from "../chat/transcript.ts";

export type SessionStateKind =
  | "running"
  | "replying"
  | "waiting_approval"
  | "waiting_ask"
  | "failed"
  | "interrupted"
  /** Nothing running, and a stop of yours holds it: the list marks this one itself (`holds-list.ts`). */
  | "held"
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

/**
 * Whether a Bot is at work in it: thinking or replying, and also stopped mid-turn on an approval
 * or a question to you, since that turn is still open. A finished failure or interruption is not.
 */
export function isWorkingStatus(kind: SessionStateKind): boolean {
  return kind === "running" || kind === "replying" || kind === "waiting_approval" || kind === "waiting_ask";
}

const NO_LABELS: StatusLabels = {
  running: "",
  replying: "",
  waitingApproval: "",
  waitingAsk: "",
  failed: "",
  interrupted: "",
  idle: "",
};

/** The sessions a Bot is at work in right now, by the same reading as each row's status. */
export function workingSessionIds(
  sessions: readonly Pick<SessionSummary, "id">[],
  turns: readonly Turn[],
  approvals: readonly Approval[],
  pendingJudgements: readonly PendingJudgement[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (isWorkingStatus(sessionStatus(session.id, turns, approvals, NO_LABELS, pendingJudgements).kind)) {
      ids.add(session.id);
    }
  }
  return ids;
}

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
  return waitingCard(session, labels) ?? settledNotice(session, messages, labels) ?? live;
}

/**
 * A card that waits on your press with no turn open on it — a sample to approve, a question the
 * work stopped on — counts toward the Dock badge read or not, so the row says where it is. Not a
 * Bot at work (`isWorkingStatus` reads live turns only), and it outranks how the last turn ended.
 */
function waitingCard(session: SessionSummary, labels: StatusLabels): SessionStatusResult | null {
  if (session.waiting_on_you === "approval") return { kind: "waiting_approval", label: labels.waitingApproval, isBusy: false };
  if (session.waiting_on_you === "ask") return { kind: "waiting_ask", label: labels.waitingAsk, isBusy: false };
  return null;
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
