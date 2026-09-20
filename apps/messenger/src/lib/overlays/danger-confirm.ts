import type { Copy } from "../copy.ts";

/** Async dialog work may update its caller only while this exact confirmation is current. */
export type DangerAction = (isCurrent: () => boolean) => Promise<void>;

export type DangerKind = "bot" | "group" | "history" | "skill" | "memory" | "provider";

/** Drawer/settings confirms go when that surface closes. A sidebar menu confirm does not. */
export type DangerSource = "drawer" | "menu" | "settings";

export type DangerConfirmState = {
  kind: DangerKind;
  /** Group / history confirms name the session they act on, so they survive a selection change. */
  sessionId?: string;
  botId?: string;
  providerId?: string;
  source?: DangerSource;
};

export type DangerCopy = {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
};

/**
 * A group or history confirm used to key off the open session, so a right-click on another row
 * either hid the dialog or showed it for the wrong chat. Bind those kinds to the named session.
 */
export function visibleDangerKind(
  confirm: DangerConfirmState | null,
  ctx: {
    selectedId: string | null;
    sessions: ReadonlyMap<string, { kind: string }>;
    botIds: ReadonlySet<string>;
    providerIds?: ReadonlySet<string>;
  },
): DangerKind | null {
  if (!confirm) return null;
  if (confirm.kind === "group") {
    const id = confirm.sessionId ?? ctx.selectedId;
    if (!id) return null;
    const session = ctx.sessions.get(id);
    if (!session || session.kind !== "group") return null;
    return "group";
  }
  if (confirm.kind === "history") {
    const id = confirm.sessionId ?? ctx.selectedId;
    if (!id || !ctx.sessions.has(id)) return null;
    return "history";
  }
  if (confirm.kind === "bot") {
    if (confirm.botId && !ctx.botIds.has(confirm.botId)) return null;
    return "bot";
  }
  if (confirm.kind === "provider") {
    if (confirm.providerId && ctx.providerIds && !ctx.providerIds.has(confirm.providerId)) {
      return null;
    }
    return "provider";
  }
  return confirm.kind;
}

export function dangerCopy(kind: DangerKind, t: Copy): DangerCopy {
  switch (kind) {
    case "bot":
      return {
        title: t.sidebar.delete,
        body: t.sidebar.deleteBody,
        confirm: t.sidebar.confirmDelete,
        cancel: t.sidebar.cancel,
      };
    case "group":
      return {
        title: t.detail.deleteGroup,
        body: t.detail.deleteGroupBody,
        confirm: t.detail.confirmDeleteGroup,
        cancel: t.detail.cancel,
      };
    case "history":
      return {
        title: t.detail.clearHistory,
        body: t.detail.clearHistoryBody,
        confirm: t.detail.confirmClearHistory,
        cancel: t.detail.cancel,
      };
    case "skill":
      return {
        title: t.sidebar.skillDelete,
        body: t.sidebar.skillDeleteBody,
        confirm: t.sidebar.skillConfirmDelete,
        cancel: t.sidebar.skillCancel,
      };
    case "memory":
      return {
        title: t.sidebar.memoryDelete,
        body: t.sidebar.memoryDeleteBody,
        confirm: t.sidebar.memoryConfirmDelete,
        cancel: t.sidebar.memoryCancel,
      };
    case "provider":
      return {
        title: t.settings.providerDelete,
        body: t.settings.providerDeleteBody,
        confirm: t.settings.providerConfirmDelete,
        cancel: t.settings.providerCancel,
      };
  }
}

/** Closing the session drawer used to wipe a confirm that the sidebar menu had just opened. */
export function shouldDropConfirm(
  event: "session-settings-closed" | "session-changed" | "no-session" | "settings-closed",
  confirm: Pick<DangerConfirmState, "kind" | "source"> | null,
): boolean {
  if (!confirm) return false;
  if (confirm.source === "menu") return false;
  if (event === "settings-closed") return confirm.kind === "provider";
  if (event === "session-settings-closed") {
    return confirm.kind === "bot" || confirm.kind === "group" || confirm.kind === "history";
  }
  return confirm.kind === "group" || confirm.kind === "history";
}
