/**
 * The session context menu: which row it is open on, and what each of its items does.
 *
 * Lives beside `Shell.svelte` rather than inside it, the way `workbench/shell-workbench.svelte.ts`
 * and `overlays/danger-confirm.svelte.ts` do: the constructor takes getters for whatever it needs
 * to read from that Shell instance, and never snapshots them. The handlers are arrow fields
 * because the shell hands them to components as callbacks.
 */
import type { Bot, SessionSummary } from "@real-bot/protocol";
import type { ShellDangerConfirm } from "../overlays/danger-confirm.svelte.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { deriveSessionContextMenu } from "./session-context-menu.ts";
import { classifySession, isFileDropSession, youBotPeer } from "./session-groups.ts";

export type ShellSessionMenuDeps = {
  runtime: () => MessengerRuntime;
  botsById: () => ReadonlyMap<string, Bot>;
  danger: () => ShellDangerConfirm;
  togglePin: (sessionId: string) => void;
  openProfile: (botId: string, sessionId?: string) => void;
};

export class ShellSessionMenu {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getBotsById: () => ReadonlyMap<string, Bot>;
  private readonly getDanger: () => ShellDangerConfirm;
  private readonly togglePin: (sessionId: string) => void;
  private readonly openProfile: (botId: string, sessionId?: string) => void;

  contextMenu = $state<{
    session: SessionSummary;
    x: number;
    y: number;
  } | null>(null);
  private contextMenuEpoch = 0;

  constructor(deps: ShellSessionMenuDeps) {
    this.getRuntime = deps.runtime;
    this.getBotsById = deps.botsById;
    this.getDanger = deps.danger;
    this.togglePin = deps.togglePin;
    this.openProfile = deps.openProfile;
  }

  openContextMenu = (e: MouseEvent, session: SessionSummary): void => {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenuEpoch += 1;
    this.contextMenu = {
      session,
      x: e.clientX,
      y: e.clientY,
    };
  };

  /**
   * Deferred so the click that picked a menu item does not fall through onto the session row
   * underneath once the menu unmounts. The epoch ignores a stale close after a new menu opens.
   */
  closeContextMenu = (): void => {
    const epoch = this.contextMenuEpoch;
    setTimeout(() => {
      if (this.contextMenuEpoch === epoch) this.contextMenu = null;
    }, 0);
  };

  closeContextMenuNow = (): void => {
    this.contextMenuEpoch += 1;
    this.contextMenu = null;
  };

  handleMenuTogglePin = (sessionId: string): void => {
    this.togglePin(sessionId);
  };

  handleMenuViewInfo = async (session: SessionSummary): Promise<void> => {
    const runtime = this.getRuntime();
    if (isFileDropSession(session)) return;
    if (runtime.selectedId !== session.id) {
      await runtime.selectSession(session.id);
    }
    const kind = classifySession(session);
    if (kind === "you-bot") {
      const peer = youBotPeer(session);
      if (peer) {
        this.openProfile(peer);
        return;
      }
    }
    runtime.openSessionSettings();
  };

  handleMenuClearHistory = (session: SessionSummary): void => {
    this.closeContextMenuNow();
    this.getDanger().openClearHistoryConfirm(session.id, "menu");
  };

  handleMenuToggleArchive = async (session: SessionSummary): Promise<void> => {
    const runtime = this.getRuntime();
    if (session.kind === "group") {
      if (session.archived_at) {
        await runtime.restoreSession(session.id);
      } else {
        await runtime.archiveSession(session.id);
      }
      return;
    }
    const peerId = youBotPeer(session);
    if (!peerId) return;
    const bot = this.getBotsById().get(peerId);
    if (!bot) return;
    if (bot.archived_at) {
      await runtime.restoreBot(bot.id);
    } else {
      await runtime.archiveBot(bot.id);
    }
  };

  handleMenuDelete = (session: SessionSummary): void => {
    this.closeContextMenuNow();
    const data = deriveSessionContextMenu(session, false, this.getBotsById());
    if (data.delete.kind === "group" && data.delete.targetId) {
      this.getDanger().openDeleteGroupConfirm(data.delete.targetId, "menu");
      return;
    }
    if (data.delete.kind === "bot" && data.delete.targetId) {
      this.getDanger().openDeleteBotConfirm(data.delete.targetId, "menu");
    }
  };
}
