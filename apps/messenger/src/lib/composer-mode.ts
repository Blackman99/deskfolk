import type { Bot, SessionKind, SessionSummary } from "@real-bot/protocol";
import { youBotPeer } from "./session-groups.ts";

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
  sessionKind?: SessionKind | null;
}): ComposerAction {
  const group = state.sessionKind === "group";
  if (state.hasSession && state.hasLiveTurn && !group) {
    return { kind: "stop", disabled: !state.connected };
  }
  return {
    kind: "send",
    disabled: !state.connected || !state.hasSession || state.locked ||
      (!group && state.pendingJudgement) || state.busy || !state.hasContent,
  };
}

export function composerLocked(
  session: SessionSummary | null,
  bots: ReadonlyMap<string, Bot>,
): boolean {
  if (!session) return false;
  if (Boolean(session.archived_at)) return true;
  const peer = youBotPeer(session);
  if (!peer) return false;
  return !bots.has(peer);
}
