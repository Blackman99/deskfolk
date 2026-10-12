import type { Bot, SessionKind, SessionSummary } from "@real-bot/protocol";
import { classifySession, isFileDropSession, youBotPeer } from "../sidebar/session-groups.ts";

export type ComposerMode = "idle" | "redirect" | "fork";

export function composerMode(hasLiveTurn: boolean, fork: boolean): ComposerMode {
  if (!hasLiveTurn) return "idle";
  return fork ? "fork" : "redirect";
}

export type ComposerAction = { kind: "send" | "stop"; disabled: boolean };

export function composerAction(state: {
  connected: boolean;
  hasSession: boolean;
  locked: boolean;
  hasLiveTurn: boolean;
  pendingJudgement: boolean;
  busy: boolean;
  hasContent: boolean;
  sessionKind?: SessionKind | "file-drop" | null;
  /**
   * The daemon hears a line of yours in a direct at the working Bot's next step (ADR 0040 P4a), so
   * the box stays open and Stop is its own control. Absent, a direct with a live turn offers only Stop.
   */
  turnInbox?: boolean;
  /**
   * The daemon takes your lines in a conversation in the order they came (ADR 0063), so a direct's
   * next line need not wait for the last to be read. Absent, Send waits for that reading there.
   */
  linesInOrder?: boolean;
}): ComposerAction {
  const group = state.sessionKind === "group";
  if (state.sessionKind === "file-drop") {
    return {
      kind: "send",
      disabled: !state.connected || !state.hasSession || state.busy || !state.hasContent,
    };
  }
  if (state.hasSession && state.hasLiveTurn && !group && !state.turnInbox) {
    return { kind: "stop", disabled: !state.connected };
  }
  return {
    kind: "send",
    disabled: !state.connected || !state.hasSession || state.locked ||
      (!group && !state.linesInOrder && state.pendingJudgement) || state.busy || !state.hasContent,
  };
}

/** Why the composer is shut, so the notice and the lock cannot drift apart. */
export type LockedReason = "archived" | "bot-bot" | "peer-gone";

export function lockedReason(
  session: SessionSummary | null,
  bots: ReadonlyMap<string, Bot>,
): LockedReason | null {
  if (!session) return null;
  if (isFileDropSession(session)) return null;
  if (Boolean(session.archived_at)) return "archived";
  // A Bot↔Bot direct is yours to read. You are not a participant, so there is nowhere to type.
  if (classifySession(session) === "bot-bot") return "bot-bot";
  const peer = youBotPeer(session);
  if (peer && !bots.has(peer)) return "peer-gone";
  return null;
}

export function composerLocked(
  session: SessionSummary | null,
  bots: ReadonlyMap<string, Bot>,
): boolean {
  return lockedReason(session, bots) !== null;
}

/**
 * Where the composer is as narrow as a phone, Send with nothing to send steps aside, so once a line
 * goes out whatever takes its place — Stop, ✨ — lands under the thumb that just sent it. A tap this
 * soon after a send is that same press again, not a stop or a request for drafts.
 */
export const SEND_SETTLE_MS = 600;

export function justSent(sentAt: number | null, now: number): boolean {
  return sentAt !== null && now - sentAt < SEND_SETTLE_MS;
}
