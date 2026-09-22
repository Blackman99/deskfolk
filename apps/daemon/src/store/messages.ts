import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  USER_MEMBER,
  isHiddenTranscriptKind,
  type Attachment,
  type Message,
  type Reaction,
} from "@real-bot/protocol";
import { attachmentMime } from "../artifact-mime";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { ensureReplyMention } from "../mentions";
import { classifyPath } from "../workspace-paths";
import { prepareFile, commitPreparedFile, discardFile, type FileCommit } from "./files";
import { getBot, listBots } from "./bots";
import {
  clampLimit,
  cursorId,
  cursorTime,
  isPresent,
  messageRow,
  requireString,
  sessionRow,
  statOrMissing,
  touchSession,
  workspacePath,
  type AttachmentRow,
  type MessageRow,
  type StoreContext,
} from "./shared";
import { taskOfTurn } from "./tasks";

export type AttachmentInput = {
  originalFilename: string;
  buffer: Uint8Array | Buffer;
  staged?: FileCommit;
};

/** Body bytes per page, well inside the remote link's one-megabyte logical message. */
export const MESSAGE_PAGE_BYTES = 256 * 1024;

export function listMessages(
  ctx: StoreContext,
  sessionId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): { items: Message[]; next: string | null } {
  sessionRow(ctx, sessionId);
  const limit = clampLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const rows = cursor
    ? ctx.db
        .query<MessageRow, [string, string, string, string, number]>(
          `SELECT * FROM messages
           WHERE session_id = ? AND kind != 'profile_change'
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(sessionId, cursorTime(cursor), cursorTime(cursor), cursorId(cursor), limit + 1)
    : ctx.db
        .query<MessageRow, [string, number]>(
          `SELECT * FROM messages
           WHERE session_id = ? AND kind != 'profile_change'
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(sessionId, limit + 1);
  const page = rows.slice(0, limit);
  // A page also has to fit the remote link, which carries one response as a single logical
  // message of at most a megabyte. Bodies are the only part that grows without bound, so the
  // page stops once they pass the budget and the cursor picks up from there — a conversation of
  // very long messages arrives in more, smaller pages instead of failing to arrive at all.
  let bytes = 0;
  let kept = page.length;
  for (let i = 0; i < page.length; i++) {
    bytes += page[i]!.body.length;
    if (bytes >= MESSAGE_PAGE_BYTES && i + 1 < page.length) {
      kept = i + 1;
      break;
    }
  }
  const window = page.slice(0, kept);
  const last = window[window.length - 1];
  const more = rows.length > limit || kept < page.length;
  const next = more && last ? `${last.created_at}|${last.id}` : null;
  const items = window.map((row) => hydrateMessage(ctx, row));
  return { items, next };
}

export function postMessage(
  ctx: StoreContext,
  sessionId: string,
  input: { body: string; parent_id?: string | null; attachments?: AttachmentInput[] },
): Message {
  const nested = ctx.db.inTransaction;
  if (!nested) prepareAttachments(ctx, input.attachments ?? []);
  try { return ctx.tx.run(() => postMessageRows(ctx, sessionId, input)); }
  finally { if (!nested) for (const att of input.attachments ?? []) if (att.staged) discardFile(ctx, att.staged); }
}

function postMessageRows(ctx: StoreContext, sessionId: string, input: { body: string; parent_id?: string | null; attachments?: AttachmentInput[] }): Message {
  sessionRow(ctx, sessionId);
  // This is the user's own write — every route that posts as the user lands here. A Bot↔Bot
  // direct is theirs to read, not to join.
  if (!isPresent(ctx, sessionId, USER_MEMBER)) {
    throw new HttpError(403, "not_a_member", "you are not in this session");
  }
  const parentId = input.parent_id ?? null;
  const parent = parentId ? requireMainParent(ctx, sessionId, parentId) : null;
  const body = withReplyMention(ctx, requireString("body", input.body), parent, USER_MEMBER);
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, created_at)
     VALUES (?, ?, NULL, ?, 'user', ?, ?, NULL, ?)`,
    [id, sessionId, parentId, USER_MEMBER, body, now],
  );

  if (input.attachments && input.attachments.length > 0) {
    for (const att of input.attachments) {
      if (!att.staged) throw new Error("attachment must be staged before transaction");
      if (realpathSync(workspacePath(ctx) || ctx.inboxRoot) !== att.staged.root) throw new HttpError(409, "conflict", "workspace changed during upload");
      commitPreparedFile(ctx, att.staged);
      const targetName = basename(att.staged.final_rel);
      const workspaceRelpath = att.staged.final_rel;
      const attId = ulid();
      const attNow = isoNow();
      ctx.db.run(
        `INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [attId, id, workspaceRelpath, att.originalFilename || targetName, attNow],
      );
    }
  }

  touchSession(ctx, sessionId, now);
  return hydrateMessage(ctx, ctx.db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(id)!);
}

export function insertMessage(
  ctx: StoreContext,
  input: {
    sessionId: string;
    turnId?: string | null;
    parentId?: string | null;
    kind: Message["kind"];
    author: string;
    body: string;
    sourceTurnId?: string | null;
    paths?: string[];
  },
): Message {
  sessionRow(ctx, input.sessionId);
  const parentId = input.parentId ?? null;
  const parent = parentId ? requireMainParent(ctx, input.sessionId, parentId) : null;
  const body =
    input.kind === "bot" || input.kind === "user"
      ? withReplyMention(ctx, input.body, parent, input.author)
      : input.body;
  const now = isoNow();
  const id = ulid();
  // A message a turn produced belongs to that turn's job, which is what carries the work dir
  // across a handoff: the woken turn reads it off this row's turn.
  const taskId = input.turnId ? taskOfTurn(ctx, input.turnId) : null;
  ctx.db.run(
    `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.turnId ?? null,
      parentId,
      input.kind,
      input.author,
      body,
      input.sourceTurnId ?? null,
      taskId,
      now,
    ],
  );
  if (input.paths && input.paths.length > 0) {
    insertPathAttachments(ctx, id, input.paths, now);
  }
  touchSession(ctx, input.sessionId, now);
  return getMessage(ctx, id);
}

export function getMessage(ctx: StoreContext, id: string): Message {
  return hydrateMessage(ctx, messageRow(ctx, id));
}

export function listMainMessages(ctx: StoreContext, sessionId: string, limit: number): Message[] {
  sessionRow(ctx, sessionId);
  const rows = ctx.db
    .query<MessageRow, [string, number]>(
      `SELECT * FROM messages
       WHERE session_id = ? AND kind != 'profile_change'
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(sessionId, limit);
  return rows.map((row) => hydrateMessage(ctx, row));
}

export function requireMainParent(ctx: StoreContext, sessionId: string, parentId: string): MessageRow {
  const parent = ctx.db
    .query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`)
    .get(parentId);
  if (!parent || parent.session_id !== sessionId) {
    throw new HttpError(422, "invalid_args", "parent_id must be a message in this session");
  }
  if (parent.parent_id) {
    throw new HttpError(422, "invalid_args", "threads are one level deep");
  }
  return parent;
}

export function withReplyMention(
  ctx: StoreContext,
  body: string,
  parent: MessageRow | null,
  selfAuthor: string,
): string {
  if (!parent || parent.author === USER_MEMBER) return body;
  let parentName: string | null = null;
  try {
    parentName = getBot(ctx, parent.author).name;
  } catch {
    parentName = null;
  }
  return ensureReplyMention(body, {
    parentAuthor: parent.author,
    parentName,
    selfAuthor,
    rosterNames: listBots(ctx).map((b) => b.name),
  });
}

export function listThreadMessages(ctx: StoreContext, parentId: string): Message[] {
  const parent = getMessage(ctx, parentId);
  const replies = ctx.db
    .query<MessageRow, [string]>(
      `SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(parentId)
    .map((row) => hydrateMessage(ctx, row))
    .filter((m) => !isHiddenTranscriptKind(m.kind));
  return isHiddenTranscriptKind(parent.kind) ? replies : [parent, ...replies];
}

export function putReaction(ctx: StoreContext, messageId: string, emoji: string): void {
  messageRow(ctx, messageId);
  const now = isoNow();
  ctx.db.run(
    `INSERT OR IGNORE INTO reactions (message_id, actor, emoji, created_at) VALUES (?, ?, ?, ?)`,
    [messageId, USER_MEMBER, emoji, now],
  );
}

export function deleteReaction(ctx: StoreContext, messageId: string, emoji: string): void {
  messageRow(ctx, messageId);
  ctx.db.run(`DELETE FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?`, [
    messageId,
    USER_MEMBER,
    emoji,
  ]);
}

export function getAttachment(ctx: StoreContext, id: string): Attachment {
  const row = ctx.db.query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "attachment not found");
  return hydrateAttachment(ctx, row);
}

/**
 * On-disk location for an attachment that is still allowed to be read.
 * Workspace-relative paths must stay inside the workspace. Inbox copies
 * without a workspace still live under Application Support.
 */
export function resolveAttachmentLocation(
  ctx: StoreContext,
  relpath: string,
): { abs: string; isDir: boolean } | null {
  const root = workspacePath(ctx);
  if (root) {
    try {
      const classified = classifyPath(root, relpath);
      if (classified.zone !== "inside") return null;
      return statOrMissing(classified.abs);
    } catch { return null; }
  }
  try {
    const inbox = classifyPath(ctx.inboxRoot, "inbox");
    const classified = classifyPath(ctx.inboxRoot, relpath);
    if (inbox.zone !== "inside" || classified.zone !== "inside") return null;
    if (inbox.abs === realpathSync(ctx.inboxRoot)) return null;
    if (classified.abs !== inbox.abs && !classified.abs.startsWith(`${inbox.abs}/`)) return null;
    return statOrMissing(classified.abs);
  } catch { return null; }
}

export function getAttachmentFilePath(ctx: StoreContext, attachment: Attachment): string {
  const located = resolveAttachmentLocation(ctx, attachment.workspace_relpath);
  if (located) return located.abs;
  throw new HttpError(404, "not_found", "attachment is outside its permitted root");
}

export function insertPathAttachments(
  ctx: StoreContext,
  messageId: string,
  paths: string[],
  now: string,
): void {
  for (const rel of paths) {
    const filename = rel === "." ? "." : basename(rel) || rel;
    ctx.db.run(
      `INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [ulid(), messageId, rel, filename, now],
    );
  }
}

export function hydrateAttachment(ctx: StoreContext, row: AttachmentRow): Attachment {
  const located = resolveAttachmentLocation(ctx, row.workspace_relpath);
  let exists = false;
  let is_dir = false;
  let size: number | null = null;
  if (located) {
    try {
      const st = statSync(located.abs);
      exists = true;
      is_dir = st.isDirectory();
      size = st.size;
    } catch {
      exists = false;
    }
  }
  const root = workspacePath(ctx) || ctx.inboxRoot;
  const staged = ctx.db.query<{ temp_rel: string; root: string }, [string, string]>("SELECT temp_rel, root FROM file_commits WHERE root = ? AND final_rel = ?").get(root, row.workspace_relpath);
  if (staged && !exists) {
    size = statSync(join(staged.root, staged.temp_rel)).size;
    exists = true;
  }
  return {
    ...row,
    exists,
    is_dir,
    size,
    mime: attachmentMime(row.original_filename, row.workspace_relpath),
  };
}

export function hydrateMessage(ctx: StoreContext, row: MessageRow): Message {
  const attachments = ctx.db
    .query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE message_id = ?`)
    .all(row.id)
    .map((att) => hydrateAttachment(ctx, att));
  const reactions = ctx.db
    .query<Reaction, [string]>(`SELECT * FROM reactions WHERE message_id = ?`)
    .all(row.id);
  return { ...row, attachments, reactions };
}

export function reserveAttachmentName(ctx: StoreContext, originalFilename: string): { root: string; abs: string; rel: string } {
  const root = realpathSync(workspacePath(ctx) || ctx.inboxRoot);
  const inboxDir = join(root, "inbox");
  const inbox = classifyPath(root, "inbox");
  if (inbox.zone !== "inside" || (!workspacePath(ctx) && inbox.abs === root)) throw new HttpError(422, "invalid_args", "inbox is outside its permitted root");
  mkdirSync(inboxDir, { recursive: true });
  const raw = basename(originalFilename).replace(/[^\w.\- 一-龥]/g, "_").trim() || "attachment";
  const ext = extname(raw);
  const base = basename(raw, ext);
  let name = raw;
  let counter = 1;
  for (;;) {
    const candidate = classifyPath(root, join(inboxDir, name));
    if (candidate.zone !== "inside" || (!workspacePath(ctx) && !candidate.abs.startsWith(`${inbox.abs}/`))) throw new HttpError(422, "invalid_args", "attachment is outside its permitted root");
    if (!existsSync(candidate.abs) && !ctx.db.query("SELECT 1 FROM file_stages WHERE root = ? AND final_rel = ? UNION ALL SELECT 1 FROM file_commits WHERE root = ? AND final_rel = ?").get(root, candidate.rel, root, candidate.rel)) {
      return { root, abs: candidate.abs, rel: candidate.rel };
    }
    name = `${base}-${counter++}${ext}`;
  }
}

export function prepareAttachments(ctx: StoreContext, attachments: AttachmentInput[]): void {
  if (!attachments.length) return;
  try {
    for (const att of attachments) {
      if (att.staged) continue;
      const reserved = reserveAttachmentName(ctx, att.originalFilename);
      att.staged = prepareFile(ctx, reserved.root, reserved.abs, att.buffer);
    }
  } catch (error) {
    for (const att of attachments) if (att.staged) discardFile(ctx, att.staged);
    throw error;
  }
}
