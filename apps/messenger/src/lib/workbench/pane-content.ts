/**
 * What a tab means.
 *
 * The layout engine treats a tab as an opaque `kind` plus string parameters so it can be split,
 * moved and persisted without knowing anything about conversations. This module is where those
 * strings turn back into something the app understands, and it is the only place that knows both
 * sides.
 */
import type { Attachment } from "@real-bot/protocol";
import type { WorkbenchTab } from "./layout-types.ts";
import type { UrlOverlay } from "../session-url.ts";

export type PaneContent =
  | { kind: "chat"; sessionId: string }
  | { kind: "preview"; sessionId: string | null; relpath: string | null; attachmentId: string | null; messageId?: string | null; taskId?: string | null; forceTree?: boolean; siblings?: Attachment[] | null }
  | { kind: "session-settings"; sessionId: string; botId: string | null }
  | { kind: "trace"; sessionId: string; taskId: string | null }
  | { kind: "route-log"; sessionId: string }
  | { kind: "terminal"; terminalId: string | null }
  | { kind: "workspace"; selected: string | null }
  | { kind: "routines" };

export type PaneKind = PaneContent["kind"];

/** Every kind this build can draw. A layout naming anything else is healed away rather than shown. */
export const PANE_KINDS: readonly PaneKind[] = [
  "chat",
  "preview",
  "session-settings",
  "trace",
  "route-log",
  "terminal",
  "workspace",
  "routines",
];

export const PANE_KIND_SET: ReadonlySet<string> = new Set(PANE_KINDS);

/** The parameters a tab carries. Only strings, because a layout has to survive `JSON.stringify`. */
export function contentToParams(content: PaneContent): Record<string, string> {
  switch (content.kind) {
    case "chat":
      return { sessionId: content.sessionId };
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
    case "session-settings": {
      const params: Record<string, string> = { sessionId: content.sessionId };
      if (content.botId) params.botId = content.botId;
      return params;
    }
    case "trace": {
      const params: Record<string, string> = { sessionId: content.sessionId };
      if (content.taskId) params.taskId = content.taskId;
      return params;
    }
    case "route-log":
      return { sessionId: content.sessionId };
    case "terminal":
      return content.terminalId ? { terminalId: content.terminalId } : {};
    case "workspace":
      return content.selected ? { selected: content.selected } : {};
    case "routines":
      return {};
  }
}

/** What a tab stands for, or null when this build does not know the kind. */
export function contentOfTab(tab: WorkbenchTab): PaneContent | null {
  const p = tab.params;
  switch (tab.kind) {
    case "chat":
      return p.sessionId ? { kind: "chat", sessionId: p.sessionId } : null;
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
    case "session-settings":
      return p.sessionId
        ? { kind: "session-settings", sessionId: p.sessionId, botId: p.botId ?? null }
        : null;
    case "trace":
      return p.sessionId ? { kind: "trace", sessionId: p.sessionId, taskId: p.taskId ?? null } : null;
    case "route-log":
      return p.sessionId ? { kind: "route-log", sessionId: p.sessionId } : null;
    case "terminal":
      return { kind: "terminal", terminalId: p.terminalId ?? null };
    case "workspace":
      return { kind: "workspace", selected: p.selected ?? null };
    case "routines":
      return { kind: "routines" };
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
    case "session-settings":
    case "trace":
    case "route-log":
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
    case "session-settings":
      return content.botId ? { kind: "bot", botId: content.botId } : { kind: "session" };
    case "trace":
      return { kind: "trace", taskId: content.taskId };
    case "workspace":
      return { kind: "workspace", selected: content.selected };
    case "routines":
      return { kind: "routines" };
    default:
      // A chat, a preview, a terminal or the model-choice log is not an overlay: the first two
      // are the conversation itself and the last two were never in the URL to begin with.
      return { kind: "none" };
  }
}

/** The pane a deep link asks for, or null when the link names nothing a pane can show. */
export function contentFromOverlay(overlay: UrlOverlay, sessionId: string | null): PaneContent | null {
  switch (overlay.kind) {
    case "session":
      return sessionId ? { kind: "session-settings", sessionId, botId: null } : null;
    case "bot":
      return sessionId ? { kind: "session-settings", sessionId, botId: overlay.botId } : null;
    case "trace":
      return sessionId ? { kind: "trace", sessionId, taskId: overlay.taskId } : null;
    case "workspace":
      return { kind: "workspace", selected: overlay.selected };
    case "routines":
      return { kind: "routines" };
    default:
      return null;
  }
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
