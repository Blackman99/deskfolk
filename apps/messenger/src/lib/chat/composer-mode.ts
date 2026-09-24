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
}): ComposerAction {
  const group = state.sessionKind === "group";
  if (state.sessionKind === "file-drop") {
    return {
      kind: "send",
      disabled: !state.connected || !state.hasSession || state.busy || !state.hasContent,
    };
  }
  if (state.hasSession && state.hasLiveTurn && !group) {
    return { kind: "stop", disabled: !state.connected };
  }
  return {
    kind: "send",
    disabled: !state.connected || !state.hasSession || state.locked ||
      (!group && state.pendingJudgement) || state.busy || !state.hasContent,
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
