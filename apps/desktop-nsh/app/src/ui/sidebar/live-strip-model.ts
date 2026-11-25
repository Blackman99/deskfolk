/**
 * Pure selector for the top "进行中" live mirror strip in the sidebar.
 *
 * Collects sessions that currently need attention or are actively running:
 * 1. Waiting on you (`waiting_approval`, `waiting_ask`) — highest priority
 * 2. Actively working (`running`, `replying`, or project live run)
 * 3. Direct Bot session currently active elsewhere (`elsewhere`)
 * 4. Remote file drop with unread incoming files
 *
 * Sessions stay in their home sections so the main list never jumps when a turn finishes.
 */
import type { SessionSummary } from "@real-bot/protocol";
import { projectDirLabel } from "../../m/sidebar/project-groups";
import { classifySession } from "../../m/sidebar/session-groups";
import { isWorkingStatus, type SessionStatusResult } from "../../m/sidebar/session-status";

export type LiveStripItem = {
  session: SessionSummary;
  kind: "bot" | "project" | "file-drop";
  priority: number;
  status: SessionStatusResult;
  elsewhere: string | null;
  unread: number;
  dirLabel: string | null;
};

export function collectLiveItems(input: {
  bots: readonly SessionSummary[];
  projects: readonly SessionSummary[];
  fileDrop: SessionSummary | null;
  statusOf: (session: SessionSummary) => SessionStatusResult;
  projectStatusOf: (session: SessionSummary) => SessionStatusResult;
  elsewhereOf: (session: SessionSummary, status: SessionStatusResult) => string | null;
  unreadOf: (session: SessionSummary) => number;
}): LiveStripItem[] {
  const out: LiveStripItem[] = [];
  const seen = new Set<string>();

  const push = (item: LiveStripItem) => {
    if (seen.has(item.session.id)) return;
    seen.add(item.session.id);
    out.push(item);
  };

  for (const session of input.bots) {
    const kind = classifySession(session);
    if (kind === "bot-bot" || kind === "consultant") continue;
    const status = input.statusOf(session);
    const elsewhere = input.elsewhereOf(session, status);
    if (status.kind === "waiting_approval" || status.kind === "waiting_ask") {
      push({ session, kind: "bot", priority: 0, status, elsewhere: null, unread: input.unreadOf(session), dirLabel: null });
    } else if (isWorkingStatus(status.kind)) {
      push({ session, kind: "bot", priority: 1, status, elsewhere: null, unread: input.unreadOf(session), dirLabel: null });
    } else if (elsewhere) {
      push({ session, kind: "bot", priority: 2, status, elsewhere, unread: input.unreadOf(session), dirLabel: null });
    }
  }

  for (const session of input.projects) {
    const status = input.projectStatusOf(session);
    if (!isWorkingStatus(status.kind)) continue;
    const priority = status.kind === "waiting_approval" || status.kind === "waiting_ask" ? 0 : 1;
    push({
      session,
      kind: "project",
      priority,
      status,
      elsewhere: null,
      unread: input.unreadOf(session),
      dirLabel: session.project_dir ? projectDirLabel(session.project_dir) : null,
    });
  }

  if (input.fileDrop) {
    const unread = input.unreadOf(input.fileDrop);
    if (unread > 0) {
      push({
        session: input.fileDrop,
        kind: "file-drop",
        priority: 3,
        status: input.statusOf(input.fileDrop),
        elsewhere: null,
        unread,
        dirLabel: null,
      });
    }
  }

  out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.session.updated_at !== b.session.updated_at) return a.session.updated_at < b.session.updated_at ? 1 : -1;
    return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
  });

  return out;
}
