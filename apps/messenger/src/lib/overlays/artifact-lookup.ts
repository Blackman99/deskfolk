/**
 * Finding an attachment, and what belongs beside it in the tree, from the messages on screen.
 *
 * Pure: the caller hands over the messages (and, for `siblingsForPath`, whatever the runtime
 * already had queued as siblings) rather than this module reaching into `snapshot` or `runtime`
 * itself.
 */
import type { Attachment, Message, SessionSummary } from "@real-bot/protocol";
import { baseName } from "../paths.ts";
import { handedOverPaths } from "./artifacts.ts";

export function findAttachmentByPath(messages: readonly Message[], relpath: string): Attachment | null {
  for (const message of messages) {
    const att = message.attachments.find((row) => row.workspace_relpath === relpath);
    if (att) return att;
  }
  return null;
}

export function findAttachmentById(messages: readonly Message[], id: string): Attachment | null {
  for (const message of messages) {
    const att = message.attachments.find((row) => row.id === id);
    if (att) return att;
  }
  return null;
}

export function siblingsForPath(
  messages: readonly Message[],
  relpath: string,
  att?: Attachment | null,
  messageId?: string | null,
  previewSiblings?: Attachment[] | null,
): Attachment[] {
  if (messageId) {
    const owner = messages.find((message) => message.id === messageId);
    if (owner) {
      // The same list the bubble's entry counts, so the file tree and the entry cannot
      // disagree about what this message handed over. The context menu's looser reading
      // belongs to a menu, where a stray `1/3` out of prose costs nothing; in a file tree
      // it is a file that does not exist.
      const associated = handedOverPaths(
        owner.body ?? "",
        owner.attachments.map((row) => row.workspace_relpath),
      );
      if (associated.length > 0) {
        return associated.map((path) => {
          const existing = owner.attachments.find((a) => a.workspace_relpath === path);
          if (existing) return existing;
          return {
            id: `virtual-${owner.id}-${path}`,
            message_id: owner.id,
            workspace_relpath: path,
            original_filename: path.split("/").pop() ?? path,
            created_at: owner.created_at,
          };
        });
      }
    }
  }
  if (previewSiblings && previewSiblings.length > 0) {
    return previewSiblings;
  }
  if (att) {
    const owner = messages.find((message) => message.id === att.message_id);
    if (owner && owner.attachments.length > 0) return owner.attachments;
  }
  for (const message of messages) {
    if (message.attachments.some((row) => row.workspace_relpath === relpath)) {
      return message.attachments;
    }
  }
  return att ? [att] : [];
}

/**
 * The rows a preview opened on `path` keeps: what its source handed over, and the path itself
 * when it is not among them — a link in the text, a search hit. Walking the tree from there
 * leaves the tree as it was. Only the stand-in for the file on screen moves with each click, and
 * a path elsewhere on the Mac has no folder above it in the tree, so a link to `~/x/curio` read
 * as the tree turning into the subfolder you opened, then vanishing at the first file.
 */
export function withOpenedPath(
  rows: readonly Attachment[],
  path: string | null,
  messageId: string | null,
  createdAt = "",
): Attachment[] {
  const key = (p: string) => p.trim().replace(/(?<=[^\\/:])[\\/]+$/, "");
  if (!path || rows.some((row) => key(row.workspace_relpath) === key(path))) return [...rows];
  return [...rows, {
    id: `virtual-${messageId ?? "opened"}-${path}`, message_id: messageId ?? "",
    workspace_relpath: path, original_filename: baseName(path) || path, created_at: createdAt,
  }];
}

/** The directory of the conversation a preview belongs to, when it is a project session (ADR 0095). */
export function projectDirOf(sessions: readonly SessionSummary[], sessionId: string | null | undefined): string | null {
  const session = sessionId ? sessions.find((row) => row.id === sessionId) : undefined;
  return session?.kind === "project" ? (session.project_dir ?? null) : null;
}
