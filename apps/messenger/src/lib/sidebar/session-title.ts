import { USER_MEMBER, type Bot, type SessionSummary } from "@real-bot/protocol";
import { activeMembers, classifySession, isFileDropSession } from "./session-groups.ts";

export type RosterLabels = {
  deleted: string;
  archived: string;
  /** The remote file drop has no Bot to name it. */
  fileDrop?: string;
  /** A project session has no name until your first line gives it one. */
  projectUntitled?: string;
};

export function sessionTitle(
  session: SessionSummary,
  bots: ReadonlyMap<string, Bot>,
  labels?: RosterLabels,
): string {
  if (isFileDropSession(session)) return labels?.fileDrop ?? "";
  if (session.kind === "group") return session.name ?? "";
  if (session.kind === "project") return session.name ?? labels?.projectUntitled ?? "";
  const names = activeMembers(session.participants)
    .filter((member) => member !== USER_MEMBER)
    .map((id) => botName(id, bots, labels, false));
  if (classifySession(session) === "you-bot") return names[0] ?? "";
  return names.join(" ↔ ");
}

export function sessionPresence(
  session: SessionSummary,
  bots: ReadonlyMap<string, Bot>,
  youLabel: string,
  openHint = "",
  labels?: RosterLabels,
): string {
  const kind = classifySession(session);
  if (kind === "file-drop") return labels?.fileDrop ?? "";
  // The only one in it is you; the directory is what a project session is about.
  if (kind === "project") return session.project_dir ?? "";
  const botNames = activeMembers(session.participants)
    .filter((member) => member !== USER_MEMBER)
    .map((id) => botName(id, bots, labels, true));
  if (kind === "group") {
    const names = [youLabel, ...botNames].join(", ");
    return openHint ? `${openHint}: ${names}` : names;
  }
  if (kind === "bot-bot") {
    const base = `${botNames.join(", ")} · ${youLabel}`;
    return openHint ? `${base} ${openHint}` : base;
  }
  return `${youLabel} ↔ ${botNames[0] ?? ""}`;
}

function botName(
  id: string,
  bots: ReadonlyMap<string, Bot>,
  labels: RosterLabels | undefined,
  markArchived: boolean,
): string {
  const bot = bots.get(id);
  if (!bot) return labels?.deleted ?? id;
  if (markArchived && bot.archived_at && labels?.archived) {
    return `${bot.name} · ${labels.archived}`;
  }
  return bot.name;
}
