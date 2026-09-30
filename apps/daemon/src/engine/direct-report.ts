/**
 * A Bot↔Bot direct that a report-back opened has nobody left where the work came from once its
 * opener hands off with the opening message. When the direct goes quiet, its opener is woken back
 * where it started with what the direct came to — once per stretch of new lines, and never against
 * a direct that a report-back itself opened and the other Bot never answered, since two Bots must
 * not bounce on silence. The quiet clock lives in this process: a restart inside the window drops
 * that one report.
 */
import type { Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import { reportBackNote } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import type { CheckBack, Store } from "../store";
import { mayWake } from "./control";

export type DirectReportDeps = {
  store: Store;
  admission: TurnAdmission | undefined;
  /** How long a Bot↔Bot direct stays quiet after its last turn before its opener is called back. */
  directQuietMs?: number;
  /** Late-bound: fire.ts is built after this module. */
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /** Benchmark switches (see `ablation.ts`): `direct-report` never calls an opener back. */
  ablation?: Ablation;
};

export type DirectReport = {
  noteDirectTurnEnded: (turn: Turn) => void;
  reportBackIfQuiet: (directId: string, lastTurnId: string) => void;
  clearTimers: () => void;
};

export function createDirectReport(deps: DirectReportDeps): DirectReport {
  const { store, admission, fireCheckBack } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  /** Long enough for the other side's turn to open, short enough that the report still reads as news. */
  const DIRECT_QUIET_MS = deps.directQuietMs ?? 10_000;
  const directTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * A turn ending in a Bot↔Bot direct restarts that direct's quiet clock. Only a completed turn
   * starts it again: after Stop or a restart the direct is the user's to pick up, not something to
   * report on. The clock lives in this process, so a restart inside the window drops that report.
   */
  function noteDirectTurnEnded(turn: Turn): void {
    if (ablation.has("direct-report")) return;
    let session;
    try {
      session = store.getSession(turn.session_id);
    } catch {
      return;
    }
    if (session.kind !== "direct" || !session.origin_session_id) return;
    clearTimeout(directTimers.get(session.id));
    directTimers.delete(session.id);
    if (turn.status !== "completed" || admission?.draining) return;
    const directId = session.id;
    const timer = setTimeout(() => {
      directTimers.delete(directId);
      reportBackIfQuiet(directId, turn.id);
    }, DIRECT_QUIET_MS);
    timer.unref?.();
    directTimers.set(directId, timer);
  }

  /**
   * The Bot that opened a direct handed its turn off with the opening message, so nobody is left
   * where the work came from. When the direct has gone quiet — no live turn, no check-back pending
   * in it — its opener is woken back there with what the direct came to, once per stretch of new
   * lines. A direct that a report-back itself opened, and that the other Bot never answered, stays
   * put: that opener has been back once already, and two Bots must not bounce on silence. A hold
   * over the opener books the report-back set aside, so the opener hears it once the hold is
   * lifted. One over the other Bot's work there books nothing: that work is what the opener would
   * hear about, and once it goes on after the lift, its next turn there leaves the direct quiet
   * again, which calls the opener back then.
   */
  function reportBackIfQuiet(directId: string, lastTurnId: string): void {
    if (admission?.draining) return;
    let booked: CheckBack;
    let held: boolean;
    try {
      if (store.listLiveTurns({ sessionId: directId }).length > 0) return;
      if (store.listPendingCheckBacks(directId).length > 0) return;
      const quiet = store.quietDirect(directId);
      if (!quiet?.latest) return;
      if (quiet.openedFromReportBack && !quiet.peerSpoke) return;
      // Asked of the opener and of the peer's work in the direct, which is what it would be told about.
      const job = store.getTurn(lastTurnId);
      const on = { taskId: job.task_id ?? null, ticketId: job.ticket_id ?? null };
      const peerWork = { botId: quiet.peerId, sessionId: directId, ...on, turnId: lastTurnId };
      const wake = {
        cause: "report_back" as const,
        botId: quiet.openerId,
        sessionId: quiet.originSessionId,
        ...on,
        turnId: lastTurnId,
        by: peerWork,
      };
      held = !mayWake(store, wake);
      if (held && store.holdsCovering(peerWork).length > 0) return;
      const note = reportBackNote(store.settingsCached().locale, {
        peer: store.getBot(quiet.peerId).name,
        last: { mine: quiet.latest.author === quiet.openerId, body: quiet.latest.body },
        peerSpoke: quiet.peerSpoke,
      });
      // Held over the opener only: booked where the hold covers it, it is set aside for the lift.
      booked = store.bookReportBack({
        botId: quiet.openerId,
        sessionId: quiet.originSessionId,
        turnId: lastTurnId,
        note,
      });
    } catch {
      // the direct, its origin or a Bot went away meanwhile; there is nobody to report to
      return;
    }
    if (held) return;
    try {
      fireCheckBack(booked.id);
    } catch {
      // left pending: the scheduler's next tick fires it
    }
  }

  function clearTimers(): void {
    for (const timer of directTimers.values()) clearTimeout(timer);
    directTimers.clear();
  }

  return { noteDirectTurnEnded, reportBackIfQuiet, clearTimers };
}
