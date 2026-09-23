/**
 * 批注：你对某个产物某一处写的一句意见，挂在一个工作区相对路径、一个锚点和交出这个产物的那条消息上。
 * 先是草稿，Bot 看不见；攒够一批一起发出，合成一条引用交付消息的回复并 @ 交出它的 Bot。发出后是
 * 「待处理」，Bot 或你把它标成「已处理」。批注不是产物的快照：只记下当时的引文、位置和哈希，
 * 陈旧与否每次现算（`packages/protocol` 的 `annotationStale`）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  ANNOTATION_BATCH_MAX,
  ANNOTATION_BODY_MAX,
  ANNOTATION_CROP_MAX_BYTES,
  ANNOTATION_CROP_MIMES,
  USER_MEMBER,
  annotationStale,
  isAnnotationAnchorKind,
  normalizeCitedPath,
  parseMentions,
  validateAnchor,
  type Annotation,
  type AnnotationAnchor,
  type AnnotationAnchorKind,
  type AnnotationCrop,
  type AnnotationFilter,
  type AnnotationStatus,
  type CreateAnnotationRequest,
  type CurrentContent,
  type Message,
  type PatchAnnotationRequest,
  type SendAnnotationsRequest,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { sha256 } from "../request-digest";
import { getBot, listBots } from "./bots";
import { hydrateMessage, resolveAttachmentLocation } from "./messages";
import { createDirect } from "./sessions";
import { isPresent, messageRow, requireString, sessionRow, touchSession, type MessageRow, type StoreContext } from "./shared";
import { taskOfTurn } from "./tasks";

type AnnotationRow = {
  id: string;
  status: AnnotationStatus;
  relpath: string;
  anchor_kind: AnnotationAnchorKind;
  anchor: string;
  content_sha256: string;
  target_message_id: string;
  target_session_id: string;
  target_turn_id: string | null;
  bot_id: string;
  session_id: string;
  message_id: string | null;
  body: string;
  crop_mime: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Everything but the crop bytes, which a list never needs and a card fetches on its own. */
const COLUMNS =
  "id, status, relpath, anchor_kind, anchor, content_sha256, target_message_id, target_session_id, target_turn_id, bot_id, session_id, message_id, body, crop_mime, resolved_by, resolved_note, resolved_at, created_at, updated_at";

/** Text bigger than this is not read back for relocation; the hash alone decides. */
const RELOCATE_TEXT_MAX = 4 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * What a file looks like now, read at most once per path while one call runs: a list over the
 * same file asks for the hash once, not once per annotation.
 */
export class FileProbe {
  private readonly seen = new Map<string, CurrentContent>();

  constructor(private readonly ctx: StoreContext) {}

  probe(relpath: string, wantText: boolean): CurrentContent {
    const key = `${wantText ? "t" : "b"}:${relpath}`;
    const cached = this.seen.get(key);
    if (cached) return cached;
    const located = resolveAttachmentLocation(this.ctx, relpath);
    let current: CurrentContent = { exists: false };
    if (located && !located.isDir && existsSync(located.abs)) {
      try {
        const bytes = readFileSync(located.abs);
        const text = wantText && bytes.byteLength <= RELOCATE_TEXT_MAX ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
        current = { exists: true, sha256: sha256(bytes), text };
      } catch {
        current = { exists: false };
      }
    }
    this.seen.set(key, current);
    return current;
  }
}

function toAnnotation(row: AnnotationRow, probe: FileProbe | null): Annotation {
  const anchor = JSON.parse(row.anchor) as AnnotationAnchor;
  const annotation: Annotation = {
    id: row.id,
    status: row.status,
    relpath: row.relpath,
    anchor_kind: row.anchor_kind,
    anchor,
    content_sha256: row.content_sha256,
    target_message_id: row.target_message_id,
    target_session_id: row.target_session_id,
    target_turn_id: row.target_turn_id,
    bot_id: row.bot_id,
    session_id: row.session_id,
    message_id: row.message_id,
    body: row.body,
    crop_mime: row.crop_mime,
    resolved_by: row.resolved_by,
    resolved_note: row.resolved_note,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (probe) {
    annotation.stale = annotationStale(annotation, probe.probe(row.relpath, row.anchor_kind === "text_range"));
  }
  return annotation;
}

function annotationRow(ctx: StoreContext, id: string): AnnotationRow {
  const row = ctx.db.query<AnnotationRow, [string]>(`SELECT ${COLUMNS} FROM annotations WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "annotation not found");
  return row;
}

export function getAnnotation(ctx: StoreContext, id: string, probe: FileProbe | null = new FileProbe(ctx)): Annotation {
  return toAnnotation(annotationRow(ctx, id), probe);
}

/** True when the row exists; the event journal asks after a delete. */
export function hasAnnotation(ctx: StoreContext, id: string): boolean {
  return Boolean(ctx.db.query<{ id: string }, [string]>(`SELECT id FROM annotations WHERE id = ?`).get(id));
}

export function listAnnotations(ctx: StoreContext, filter: AnnotationFilter = {}): Annotation[] {
  const where: string[] = [];
  const args: string[] = [];
  const add = (column: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") throw new HttpError(422, "invalid_args", `${column} must be a string`);
    where.push(`${column} = ?`);
    args.push(value);
  };
  add("relpath", filter.relpath === undefined ? undefined : normalizeCitedPath(filter.relpath) ?? filter.relpath);
  add("session_id", filter.session_id);
  add("message_id", filter.message_id);
  add("target_message_id", filter.target_message_id);
  if (filter.status !== undefined && filter.status !== null && (filter.status as string) !== "") {
    if (!["draft", "open", "resolved"].includes(filter.status)) throw new HttpError(422, "invalid_args", "status must be draft, open, or resolved");
    add("status", filter.status);
  }
  const rows = ctx.db
    .query<AnnotationRow, string[]>(
      `SELECT ${COLUMNS} FROM annotations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`,
    )
    .all(...args);
  const probe = new FileProbe(ctx);
  return rows.map((row) => toAnnotation(row, probe));
}

/** The annotations one sent message carries, oldest first — what its cards and the Bot's context list. */
export function annotationsOfMessage(ctx: StoreContext, messageId: string): Annotation[] {
  return listAnnotations(ctx, { message_id: messageId });
}

/** Annotations still waiting on a file; `read_file` names the count. */
export function openAnnotationCount(ctx: StoreContext, relpath: string): number {
  const normalized = normalizeCitedPath(relpath) ?? relpath;
  const row = ctx.db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM annotations WHERE relpath = ? AND status = 'open'`)
    .get(normalized);
  return row?.n ?? 0;
}

export function annotationCrop(ctx: StoreContext, id: string): { mime: string; bytes: Uint8Array } | null {
  const row = ctx.db.query<{ crop_mime: string | null; crop: Uint8Array | null }, [string]>(`SELECT crop_mime, crop FROM annotations WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "annotation not found");
  if (!row.crop_mime || !row.crop) return null;
  return { mime: row.crop_mime, bytes: row.crop };
}

function decodeCrop(input: unknown): { mime: string; bytes: Uint8Array } | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new HttpError(422, "invalid_args", "crop must be { mime, base64 }");
  const crop = input as Partial<AnnotationCrop>;
  if (typeof crop.mime !== "string" || !(ANNOTATION_CROP_MIMES as readonly string[]).includes(crop.mime)) {
    throw new HttpError(422, "invalid_args", "crop must be a PNG or JPEG");
  }
  if (typeof crop.base64 !== "string" || !crop.base64) throw new HttpError(422, "invalid_args", "crop needs base64 bytes");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(crop.base64, "base64"));
  } catch {
    throw new HttpError(422, "invalid_args", "crop is not valid base64");
  }
  if (bytes.byteLength === 0) throw new HttpError(422, "invalid_args", "crop is empty");
  if (bytes.byteLength > ANNOTATION_CROP_MAX_BYTES) throw new HttpError(422, "invalid_args", "crop must be 1 MB or smaller");
  return { mime: crop.mime, bytes };
}

function checkBody(value: unknown): string {
  const body = requireString("body", value).trim();
  if (!body) throw new HttpError(422, "invalid_args", "body must not be empty");
  if ([...body].length > ANNOTATION_BODY_MAX) throw new HttpError(422, "invalid_args", `body must be ${ANNOTATION_BODY_MAX} characters or fewer`);
  return body;
}

function checkSha(value: unknown): string {
  const sha = requireString("content_sha256", value).toLowerCase();
  if (!SHA256_HEX.test(sha)) throw new HttpError(422, "invalid_args", "content_sha256 must be a hex SHA-256");
  return sha;
}

function checkAnchor(kind: unknown, anchor: unknown): { kind: AnnotationAnchorKind; anchor: AnnotationAnchor } {
  if (!isAnnotationAnchorKind(kind)) throw new HttpError(422, "invalid_args", "anchor_kind is not one this build knows");
  const checked = validateAnchor(kind, anchor);
  if (!checked.ok) throw new HttpError(422, "invalid_args", `anchor: ${checked.reason}`);
  return { kind, anchor: checked.anchor };
}

/**
 * Only a workspace file can be annotated: a link has nobody to hand the note to, and a path
 * outside the workspace is not something a Bot can change.
 */
export function checkAnnotatedPath(ctx: StoreContext, value: unknown): string {
  const raw = requireString("relpath", value);
  const relpath = normalizeCitedPath(raw);
  if (!relpath || relpath === ".") throw new HttpError(422, "invalid_args", "relpath must name a file");
  if (/^[a-z][a-z0-9+.-]*:/i.test(relpath) || relpath.includes("://")) {
    throw new HttpError(422, "invalid_args", "only workspace files can be annotated, not links");
  }
  if (relpath.startsWith("/") || relpath.startsWith("~") || relpath.split(/[\\/]/).some((part) => part === "..")) {
    throw new HttpError(422, "invalid_args", "relpath must stay inside the workspace");
  }
  const located = resolveAttachmentLocation(ctx, relpath);
  if (!located) throw new HttpError(422, "invalid_args", "relpath must stay inside the workspace");
  if (!existsSync(located.abs)) throw new HttpError(422, "invalid_args", "the file does not exist");
  if (located.isDir || statSync(located.abs).isDirectory()) throw new HttpError(422, "invalid_args", "relpath must name a file, not a directory");
  return relpath;
}

/**
 * 挂到谁：交付消息必须是 Bot 的消息；批注挂在它和交出它的 Bot 上。发往的会话是交付消息所在的会话，
 * 除非那是一条你不在的 Bot↔Bot 私聊——那就发到你和交付 Bot 的私聊里（没有就建一条）。
 */
function targetOf(ctx: StoreContext, messageId: unknown): { target: MessageRow; botId: string; sessionId: string } {
  const target = messageRow(ctx, requireString("target_message_id", messageId));
  if (target.kind !== "bot" || target.author === USER_MEMBER) {
    throw new HttpError(422, "invalid_args", "annotations hang on a Bot's message");
  }
  const botId = getBot(ctx, target.author).id;
  const sessionId = isPresent(ctx, target.session_id, USER_MEMBER) ? target.session_id : createDirect(ctx, USER_MEMBER, botId).id;
  return { target, botId, sessionId };
}

export function createAnnotation(ctx: StoreContext, input: CreateAnnotationRequest): Annotation {
  const { target, botId, sessionId } = targetOf(ctx, input.target_message_id);
  const relpath = checkAnnotatedPath(ctx, input.relpath);
  const { kind, anchor } = checkAnchor(input.anchor_kind, input.anchor);
  const sha = checkSha(input.content_sha256);
  const body = checkBody(input.body);
  const crop = decodeCrop(input.crop);
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO annotations
       (id, status, relpath, anchor_kind, anchor, content_sha256, target_message_id, target_session_id, target_turn_id, bot_id,
        session_id, message_id, body, crop_mime, crop, resolved_by, resolved_note, resolved_at, created_at, updated_at)
     VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [id, relpath, kind, JSON.stringify(anchor), sha, target.id, target.session_id, target.turn_id, botId, sessionId, body, crop?.mime ?? null, crop?.bytes ?? null, now, now],
  );
  return getAnnotation(ctx, id);
}

/**
 * A draft is still yours to edit; a sent annotation is part of its message and only its state
 * moves — `open ↔ resolved`, by you.
 */
export function patchAnnotation(ctx: StoreContext, id: string, patch: PatchAnnotationRequest): Annotation {
  const row = annotationRow(ctx, id);
  const keys = Object.keys(patch ?? {}).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
  if (keys.length === 0) throw new HttpError(422, "invalid_args", "PATCH body must include at least one field");
  const now = isoNow();
  if (row.status === "draft") {
    if (patch.status !== undefined) throw new HttpError(422, "invalid_args", "a draft is sent, not resolved");
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.body !== undefined) {
      sets.push("body = ?");
      args.push(checkBody(patch.body));
    }
    if (patch.anchor !== undefined) {
      sets.push("anchor = ?");
      args.push(JSON.stringify(checkAnchor(row.anchor_kind, patch.anchor).anchor));
    }
    if ((patch as Record<string, unknown>).content_sha256 !== undefined) {
      sets.push("content_sha256 = ?");
      args.push(checkSha((patch as Record<string, unknown>).content_sha256));
    }
    if (patch.crop !== undefined) {
      const crop = decodeCrop(patch.crop);
      sets.push("crop_mime = ?", "crop = ?");
      args.push(crop?.mime ?? null, crop?.bytes ?? null);
    }
    if (sets.length === 0) throw new HttpError(422, "invalid_args", "nothing to change on a draft");
    ctx.db.run(`UPDATE annotations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...args, now, id] as never);
    return getAnnotation(ctx, id);
  }
  const editing = keys.filter((key) => key !== "status");
  if (editing.length > 0) throw new HttpError(422, "invalid_args", "a sent annotation only changes state");
  if (patch.status !== "open" && patch.status !== "resolved") throw new HttpError(422, "invalid_args", "status must be open or resolved");
  if (patch.status === "resolved") {
    ctx.db.run(`UPDATE annotations SET status = 'resolved', resolved_by = ?, resolved_note = NULL, resolved_at = ?, updated_at = ? WHERE id = ?`, [USER_MEMBER, now, now, id]);
  } else {
    ctx.db.run(`UPDATE annotations SET status = 'open', resolved_by = NULL, resolved_note = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
  }
  return getAnnotation(ctx, id);
}

/** Bots mark a sent annotation handled and say how; they never reopen, delete, or create one. */
export function resolveAnnotationByBot(ctx: StoreContext, id: string, botId: string, note: unknown): Annotation {
  const row = annotationRow(ctx, id);
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new HttpError(422, "invalid_args", "note is required: say what changed");
  if (row.status === "draft") throw new HttpError(422, "invalid_args", "this annotation has not been sent yet");
  if (row.status === "resolved") throw new HttpError(409, "conflict", "this annotation is already resolved");
  const now = isoNow();
  ctx.db.run(`UPDATE annotations SET status = 'resolved', resolved_by = ?, resolved_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?`, [
    botId,
    [...text].slice(0, ANNOTATION_BODY_MAX).join(""),
    now,
    now,
    id,
  ]);
  return getAnnotation(ctx, id);
}

export function deleteAnnotation(ctx: StoreContext, id: string): void {
  const row = annotationRow(ctx, id);
  if (row.status !== "draft") throw new HttpError(422, "invalid_args", "a sent annotation is part of its message; resolve it instead");
  ctx.db.run(`DELETE FROM annotations WHERE id = ?`, [id]);
}

/**
 * 整批发送：在一个事务里建一条引用交付消息的用户消息（正文前面补上交付 Bot 的 `@名字`，已经点过名的
 * 不重复；再接上你的总话），草稿转为 `open` 并填上 `message_id`。交付消息在你不在的 Bot↔Bot 私聊里时，
 * 消息没有 `parent_id`，改为记下 `annotation_source_message_id`。一批里有不属于这个会话的草稿、已经发出
 * 的、或者超过上限，整批拒绝。开轮（点名、参与规则）由调用方按普通用户消息那条路走。
 */
export function sendAnnotations(ctx: StoreContext, input: SendAnnotationsRequest): { message: Message; annotations: Annotation[] } {
  return ctx.tx.run(() => sendAnnotationsRows(ctx, input));
}

function sendAnnotationsRows(ctx: StoreContext, input: SendAnnotationsRequest): { message: Message; annotations: Annotation[] } {
  const sessionId = requireString("session_id", input.session_id);
  const summary = typeof input.body === "string" ? input.body.trim() : "";
  if (input.body !== undefined && typeof input.body !== "string") throw new HttpError(422, "invalid_args", "body must be a string");
  if (!Array.isArray(input.annotation_ids) || !input.annotation_ids.every((id) => typeof id === "string" && id)) {
    throw new HttpError(422, "invalid_args", "annotation_ids must be a list of ids");
  }
  const ids = [...new Set(input.annotation_ids)];
  if (ids.length === 0) throw new HttpError(422, "invalid_args", "annotation_ids must name at least one draft");
  if (ids.length > ANNOTATION_BATCH_MAX) throw new HttpError(422, "invalid_args", `a batch holds at most ${ANNOTATION_BATCH_MAX} annotations`);
  sessionRow(ctx, sessionId);
  if (!isPresent(ctx, sessionId, USER_MEMBER)) throw new HttpError(403, "not_a_member", "you are not in this session");
  const rows = ids.map((id) => annotationRow(ctx, id));
  for (const row of rows) {
    if (row.status !== "draft") throw new HttpError(422, "invalid_args", `annotation ${row.id} was already sent`);
    if (row.session_id !== sessionId) throw new HttpError(422, "invalid_args", `annotation ${row.id} is not for this session`);
  }
  // The quoted delivery is the newest one in the batch; the cards name each of their own.
  const targets = new Map<string, MessageRow>();
  for (const row of rows) if (!targets.has(row.target_message_id)) targets.set(row.target_message_id, messageRow(ctx, row.target_message_id));
  const latest = [...targets.values()].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1)).at(-1)!;
  const sameSession = latest.session_id === sessionId;
  const parentId = sameSession ? (latest.parent_id ?? latest.id) : null;
  const sourceId = sameSession ? null : latest.id;
  // Every delivering Bot is named, once.
  const botIds = [...new Set(rows.map((row) => row.bot_id))];
  const names: string[] = [];
  for (const botId of botIds) {
    try {
      names.push(getBot(ctx, botId).name);
    } catch {
      // A Bot deleted since the delivery has nobody to wake; the annotations still go out.
    }
  }
  const roster = listBots(ctx).map((bot) => bot.name);
  const parsed = parseMentions(summary, roster);
  const missing = parsed.everyone ? [] : names.filter((name) => !parsed.mentions.includes(name));
  const body = `${missing.map((name) => `@${name}`).join(" ")} ${summary}`.trim();
  if (!body) throw new HttpError(422, "invalid_args", "nobody to send this to");
  const taskId = latest.turn_id ? taskOfTurn(ctx, latest.turn_id) : null;
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, task_id, annotation_source_message_id, created_at)
     VALUES (?, ?, NULL, ?, 'user', ?, ?, NULL, ?, ?, ?)`,
    [id, sessionId, parentId, USER_MEMBER, body, taskId, sourceId, now],
  );
  for (const row of rows) {
    ctx.db.run(`UPDATE annotations SET status = 'open', message_id = ?, updated_at = ? WHERE id = ?`, [id, now, row.id]);
  }
  touchSession(ctx, sessionId, now);
  const probe = new FileProbe(ctx);
  return {
    message: hydrateMessage(ctx, messageRow(ctx, id)),
    annotations: ids.map((annotationId) => getAnnotation(ctx, annotationId, probe)),
  };
}

/**
 * The task a message's annotations point back at: the delivery turn's, so the woken turn keeps
 * working in the folder the artifact came from. Null for a message that carries none.
 */
export function annotationTaskOfMessage(ctx: StoreContext, messageId: string): string | null {
  const rows = ctx.db
    .query<{ target_turn_id: string | null }, [string]>(
      `SELECT target_turn_id FROM annotations WHERE message_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(messageId);
  for (const row of rows) {
    if (!row.target_turn_id) continue;
    const taskId = taskOfTurn(ctx, row.target_turn_id);
    if (taskId) return taskId;
  }
  return null;
}
