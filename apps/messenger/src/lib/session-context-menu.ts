import type { Bot, SessionSummary } from "@real-bot/protocol";
import { classifySession, youBotPeer } from "./session-groups.ts";

export type SessionContextMenuData = {
  sessionId: string;
  isPinned: boolean;
  canViewInfo: boolean;
  canClearHistory: boolean;
  archive: {
    enabled: boolean;
    isArchived: boolean;
    botId: string | null;
  };
  delete: {
    enabled: boolean;
    kind: "group" | "bot" | null;
    targetId: string | null;
  };
};

export function deriveSessionContextMenu(
  session: SessionSummary,
  isPinned: boolean,
  botsById: ReadonlyMap<string, Bot>,
): SessionContextMenuData {
  const kind = classifySession(session);
  if (kind === "group") {
    const isArchived = Boolean(session.archived_at);
    return {
      sessionId: session.id,
      isPinned,
      canViewInfo: true,
      canClearHistory: true,
      archive: {
        enabled: true,
        isArchived,
        botId: null,
      },
      delete: {
        enabled: true,
        kind: "group",
        targetId: session.id,
      },
    };
  }

  if (kind === "you-bot") {
    const peerId = youBotPeer(session);
    const peerBot = peerId ? (botsById.get(peerId) ?? null) : null;
    const isArchived = Boolean(session.archived_at) || Boolean(peerBot?.archived_at);

    return {
      sessionId: session.id,
      isPinned,
      canViewInfo: true,
      canClearHistory: true,
      archive: {
        enabled: Boolean(peerBot),
        isArchived,
        botId: peerBot?.id ?? null,
      },
      delete: {
        enabled: Boolean(peerBot),
        kind: peerBot ? "bot" : null,
        targetId: peerBot?.id ?? null,
      },
    };
  }

  return {
    sessionId: session.id,
    isPinned,
    canViewInfo: true,
    canClearHistory: true,
    archive: {
      enabled: false,
      isArchived: false,
      botId: null,
    },
    delete: {
      enabled: false,
      kind: null,
      targetId: null,
    },
  };
}

export function computeContextMenuPosition(
  clickX: number,
  clickY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 8,
): { x: number; y: number } {
  let x = clickX;
  let y = clickY;
  if (x + menuWidth > viewportWidth - padding) {
    x = Math.max(padding, viewportWidth - menuWidth - padding);
  }
  if (y + menuHeight > viewportHeight - padding) {
    y = Math.max(padding, viewportHeight - menuHeight - padding);
  }
  return { x, y };
}
