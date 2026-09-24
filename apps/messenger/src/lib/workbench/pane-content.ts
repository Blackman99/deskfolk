/**
 * What a tab means.
 *
 * The layout engine treats a tab as an opaque `kind` plus string parameters so it can be split,
 * moved and persisted without knowing anything about conversations. This module is where those
 * strings turn back into something the app understands, and it is the only place that knows both
 * sides.
 */
import type { Attachment } from "@real-bot/protocol";
import type { TraceFocus } from "../overlays/task-trace.ts";
import type { WorkbenchTab } from "./layout-types.ts";
import type { UrlOverlay } from "../session-url.ts";

/**
 * What a conversation pane has sliding over its transcript: the conversation's settings, or a
 * Bot's when `botId` names one. It belongs to the conversation's tab, so it moves, splits and
 * comes back after a restart along with it. (Model choices are read on the flow board's cards.)
 */
export type ChatSide = { kind: "settings"; botId: string | null };

export type PaneContent =
  /** `side` left out means "whatever it has open"; `null` means nothing beside the transcript. */
  | { kind: "chat"; sessionId: string; side?: ChatSide | null }
  | { kind: "preview"; sessionId: string | null; relpath: string | null; attachmentId: string | null; messageId?: string | null; taskId?: string | null; forceTree?: boolean; siblings?: Attachment[] | null }
  | {
      kind: "trace";
      sessionId: string;
      taskId: string | null;
      /** The message a "show this job" asked to land on, and which request it was. */
      focus?: TraceFocus | null;
      focusNonce?: number | null;
    }
  /**
   * One shell. `cwd` is where it was opened, which is where a restart starts it again when the
   * process did not survive — the split it sits in is the layout's, and this is what fills it.
   */
  | { kind: "terminal"; terminalId: string | null; cwd?: string | null }
  | { kind: "workspace"; selected: string | null }
  | { kind: "routines" }
  /** One ledger. Like the calendar, asking for it again focuses the pane that already has it. */
  | { kind: "spend" };

export type PaneKind = PaneContent["kind"];
export type ChatContent = Extract<PaneContent, { kind: "chat" }>;

/** Every kind this build can draw. A layout naming anything else is healed away rather than shown. */
export const PANE_KINDS: readonly PaneKind[] = [
  "chat",
  "preview",
  "trace",
  "terminal",
  "workspace",
  "routines",
  "spend",
];

export const PANE_KIND_SET: ReadonlySet<string> = new Set(PANE_KINDS);

/** The parameters a tab carries. Only strings, because a layout has to survive `JSON.stringify`. */
export function contentToParams(content: PaneContent): Record<string, string> {
  switch (content.kind) {
    case "chat": {
      const params: Record<string, string> = { sessionId: content.sessionId };
      if (content.side) params.side = content.side.kind;
      if (content.side?.botId) params.botId = content.side.botId;
      return params;
    }
    case "preview": {
      const params: Record<string, string> = {};
      if (content.sessionId) params.sessionId = content.sessionId;
      if (content.relpath) params.relpath = content.relpath;
      if (content.attachmentId) params.attachmentId = content.attachmentId;
      if (content.messageId) params.messageId = content.messageId;
      if (content.taskId) params.taskId = content.taskId;
      if (content.forceTree) params.forceTree = "true";
      if (content.siblings?.length) params.siblings = JSON.stringify(content.siblings);
      return params;
    }
    case "trace": {
      const params: Record<string, string> = { sessionId: content.sessionId };
      if (content.taskId) params.taskId = content.taskId;
      if (content.focus) {
        params.focusMessageId = content.focus.messageId;
        if (content.focus.turnId) params.focusTurnId = content.focus.turnId;
      }
      if (content.focusNonce) params.focusNonce = String(content.focusNonce);
      return params;
    }
    case "terminal": {
      const params: Record<string, string> = {};
      if (content.terminalId) params.terminalId = content.terminalId;
      if (content.cwd) params.cwd = content.cwd;
      return params;
    }
    case "workspace":
      return content.selected ? { selected: content.selected } : {};
    case "routines":
    case "spend":
      return {};
  }
}

/** What a tab stands for, or null when this build does not know the kind. */
export function contentOfTab(tab: WorkbenchTab): PaneContent | null {
  const p = tab.params;
  switch (tab.kind) {
    case "chat":
      return p.sessionId ? { kind: "chat", sessionId: p.sessionId, side: chatSideOf(p) } : null;
    case "preview":
      return {
        kind: "preview",
        sessionId: p.sessionId ?? null,
        relpath: p.relpath ?? null,
        attachmentId: p.attachmentId ?? null,
        messageId: p.messageId ?? null,
        taskId: p.taskId ?? null,
        forceTree: p.forceTree === "true",
        siblings: parsePreviewSiblings(p.siblings),
      };
    case "trace":
      return p.sessionId ? traceContent(p.sessionId, p) : null;
    case "terminal":
      return { kind: "terminal", terminalId: p.terminalId ?? null, cwd: p.cwd ?? null };
    case "workspace":
      return { kind: "workspace", selected: p.selected ?? null };
    case "routines":
      return { kind: "routines" };
    case "spend":
      return { kind: "spend" };
    default:
      return null;
  }
}

export function tabFor(content: PaneContent, id: string): WorkbenchTab {
  return { id, kind: content.kind, params: contentToParams(content) };
}

/** The conversation this pane belongs to, so closing one can release its history. */
export function contentSessionId(content: PaneContent): string | null {
  switch (content.kind) {
    case "chat":
    case "trace":
      return content.sessionId;
    case "preview":
      return content.sessionId;
    default:
      return null;
  }
}

export function contentsEqual(a: PaneContent, b: PaneContent): boolean {
  if (a.kind !== b.kind) return false;
  const pa = contentToParams(a);
  const pb = contentToParams(b);
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  for (const key of keys) if (pa[key] !== pb[key]) return false;
  return true;
}

/**
 * What the URL should say for the pane the keyboard is in.
 *
 * On the workbench the URL is a deep-link inlet and a mirror of the active pane, not the state of
 * record — that is the layout, in this machine's storage. So only the things that were already
 * URL-addressable come back out here, and the rest of the arrangement stays out of it.
 */
export function overlayFromContent(content: PaneContent | null): UrlOverlay {
  if (!content) return { kind: "none" };
  switch (content.kind) {
    case "chat":
      // The settings over a conversation are what the drawer is on a narrow window.
      if (!content.side) return { kind: "none" };
      return content.side.botId ? { kind: "bot", botId: content.side.botId } : { kind: "session" };
    case "trace":
      return { kind: "trace", taskId: content.taskId };
    case "workspace":
      return { kind: "workspace", selected: content.selected };
    case "routines":
      return { kind: "routines" };
    case "spend":
      return { kind: "spend" };
    default:
      // A desktop terminal tab is one shell and stays in the layout. The phone's page is the
      // only terminal the URL carries, and a tab is not that page. A preview is the
      // conversation's own, and was never an overlay of its own.
      return { kind: "none" };
  }
}

/** The pane a deep link asks for, or null when the link names nothing a pane can show. */
export function contentFromOverlay(overlay: UrlOverlay, sessionId: string | null): PaneContent | null {
  switch (overlay.kind) {
    case "session":
      return sessionId ? { kind: "chat", sessionId, side: { kind: "settings", botId: null } } : null;
    case "bot":
      return sessionId ? { kind: "chat", sessionId, side: { kind: "settings", botId: overlay.botId } } : null;
    case "trace":
      return sessionId
        ? { kind: "trace", sessionId, taskId: overlay.taskId, focus: null, focusNonce: null }
        : null;
    case "workspace":
      return { kind: "workspace", selected: overlay.selected };
    case "routines":
      return { kind: "routines" };
    case "spend":
      return { kind: "spend" };
    default:
      // The phone's terminal page is not a desktop tab. A link to it opens that page.
      return null;
  }
}

/** A board tab, including the message it was asked to land on. */
function traceContent(sessionId: string, p: Record<string, string>): PaneContent {
  const nonce = Number(p.focusNonce);
  return {
    kind: "trace",
    sessionId,
    taskId: p.taskId ?? null,
    focus: p.focusMessageId ? { messageId: p.focusMessageId, turnId: p.focusTurnId ?? null } : null,
    focusNonce: Number.isInteger(nonce) && nonce > 0 ? nonce : null,
  };
}

/** Only settings slide over a conversation; any other value a layout carries is nothing open. */
function chatSideOf(p: Record<string, string>): ChatSide | null {
  return p.side === "settings" ? { kind: "settings", botId: p.botId ?? null } : null;
}

function parsePreviewSiblings(value: string | undefined): Attachment[] | null {
  if (!value) return null;
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows)) return null;
    return rows.filter((row): row is Attachment => row &&
      typeof row.id === "string" && typeof row.message_id === "string" &&
      typeof row.workspace_relpath === "string" && typeof row.original_filename === "string" &&
      typeof row.created_at === "string");
  } catch {
    return null;
  }
}
