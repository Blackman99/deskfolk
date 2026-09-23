/**
 * 批注在信使里的纯逻辑：按文件、按消息、按去向归批；筛选；卡片和列表上的位置、状态、陈旧文案；
 * 从预览打开的方式推出「挂到谁」；以及能不能在当前预览里加批注。
 */
import {
  USER_MEMBER,
  describeAnchor,
  type Annotation,
  type AnnotationLocale,
  type AnnotationStatus,
  type Message,
  type SessionSummary,
  type TextRangeAnchor,
} from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { handedOverPaths, type ArtifactKind } from "../overlays/artifacts.ts";

export type AnnotationListFilter = "open" | "resolved" | "draft" | "all";

/** The message an annotation hangs on, as the preview knows it. */
export type AnnotationTarget = {
  messageId: string;
  sessionId: string;
  turnId: string | null;
  botId: string;
};

export function filterAnnotations(rows: readonly Annotation[], filter: AnnotationListFilter): Annotation[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) => row.status === filter);
}

/** Where a text range sits now: the relocated lines when the file moved it, else the stored ones. */
export function effectiveLines(row: Annotation): { start_line: number; end_line: number } | null {
  if (row.anchor_kind !== "text_range") return null;
  if (row.stale?.kind === "moved") return { start_line: row.stale.start_line, end_line: row.stale.end_line };
  const anchor = row.anchor as TextRangeAnchor;
  return { start_line: anchor.start_line, end_line: anchor.end_line };
}

/** One file's annotations in reading order: by position for text, by time for the rest. */
export function annotationsForFile(rows: readonly Annotation[], relpath: string): Annotation[] {
  return rows
    .filter((row) => row.relpath === relpath)
    .sort((a, b) => {
      const la = effectiveLines(a);
      const lb = effectiveLines(b);
      if (la && lb && la.start_line !== lb.start_line) return la.start_line - lb.start_line;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1;
    });
}

/** Rows keyed by the message that carries them, for the transcript's cards. */
export function annotationsByMessage(rows: readonly Annotation[]): Map<string, Annotation[]> {
  const index = new Map<string, Annotation[]>();
  for (const row of rows) {
    if (!row.message_id) continue;
    const list = index.get(row.message_id);
    if (list) list.push(row);
    else index.set(row.message_id, [row]);
  }
  for (const list of index.values()) list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return index;
}

/**
 * The drafts a person could send from the session on screen: the ones written on deliveries in
 * this session. A batch belongs to its destination, which for a Bot↔Bot direct is your direct
 * with the delivering Bot, so the same drafts group by where they go.
 */
export function draftsForView(rows: readonly Annotation[], viewedSessionId: string | null): Annotation[] {
  if (!viewedSessionId) return [];
  return rows
    .filter((row) => row.status === "draft" && (row.target_session_id === viewedSessionId || row.session_id === viewedSessionId))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export function groupByDestination(drafts: readonly Annotation[]): Array<{ sessionId: string; botIds: string[]; drafts: Annotation[] }> {
  const groups = new Map<string, { sessionId: string; botIds: string[]; drafts: Annotation[] }>();
  for (const draft of drafts) {
    let group = groups.get(draft.session_id);
    if (!group) {
      group = { sessionId: draft.session_id, botIds: [], drafts: [] };
      groups.set(draft.session_id, group);
    }
    group.drafts.push(draft);
    if (!group.botIds.includes(draft.bot_id)) group.botIds.push(draft.bot_id);
  }
  return [...groups.values()];
}

export function statusLabel(t: Copy, status: AnnotationStatus): string {
  if (status === "draft") return t.stream.annotationStatusDraft;
  if (status === "resolved") return t.stream.annotationStatusResolved;
  return t.stream.annotationStatusOpen;
}

/** The stale badge, or null for a fresh row. */
export function staleLabel(t: Copy, row: Annotation, locale: AnnotationLocale): string | null {
  const stale = row.stale;
  if (!stale) return null;
  if (stale.kind === "missing") return t.stream.annotationStaleMissing;
  if (stale.kind === "moved") {
    const lines = describeAnchor("text_range", { ...(row.anchor as TextRangeAnchor), start_line: stale.start_line, end_line: stale.end_line }, locale);
    return t.stream.annotationStaleMoved(lines);
  }
  return t.stream.annotationStaleChanged;
}

export function positionLabel(row: Annotation, locale: AnnotationLocale): string {
  return describeAnchor(row.anchor_kind, row.anchor, locale);
}

/** Who resolved it, as a name: you, a Bot, or a Bot that is gone. */
export function resolverName(row: Annotation, bots: ReadonlyMap<string, { name: string }>, t: Copy): string | null {
  if (!row.resolved_by) return null;
  if (row.resolved_by === USER_MEMBER) return t.stream.annotationResolvedByYou;
  return bots.get(row.resolved_by)?.name ?? t.top.deleted;
}

/** The daemon's ETag is `"<sha256 hex>"`; the draft stores the bare hash. */
export function contentShaFromEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const bare = etag.replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(bare) ? bare : null;
}

/** The message a preview hangs on: the one it was opened from, when that is a Bot's. */
export function targetFromMessage(message: Message | null | undefined): AnnotationTarget | null {
  if (!message || message.kind !== "bot" || message.author === USER_MEMBER) return null;
  return { messageId: message.id, sessionId: message.session_id, turnId: message.turn_id, botId: message.author };
}

/**
 * 挂到谁：在文件树里切到别的路径、或从工作区查看器打开的文件，挂到这件事里（没有的话就在整个会话里找）
 * 最近一条引用了这个路径的 Bot 消息。从没被 Bot 消息引用过的文件找不到该找谁。
 */
export function deliveryFor(
  messages: readonly Message[],
  relpath: string,
  scope: { sessionId: string | null; taskId?: string | null },
): Message | null {
  if (!scope.sessionId) return null;
  const cites = (message: Message): boolean =>
    message.kind === "bot" &&
    message.author !== USER_MEMBER &&
    message.session_id === scope.sessionId &&
    handedOverPaths(message.body ?? "", message.attachments.map((row) => row.workspace_relpath)).includes(relpath);
  const later = (a: Message, b: Message): number => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);
  const citing = messages.filter(cites).sort(later);
  if (scope.taskId) {
    const inJob = citing.filter((message) => message.task_id === scope.taskId);
    if (inJob.length > 0) return inJob.at(-1)!;
  }
  return citing.at(-1) ?? null;
}

export type AnnotateGate = { ok: true } | { ok: false; reason: "no-target" | "dirty" | "kind" };

/** Whether the preview on screen can take a new annotation, and if not, why. */
export function annotateGate(input: { target: AnnotationTarget | null; kind: ArtifactKind; sourceMode: boolean; dirty: boolean }): AnnotateGate {
  const textLike = input.kind === "text" || ((input.kind === "markdown" || input.kind === "html") && input.sourceMode);
  if (!textLike) return { ok: false, reason: "kind" };
  if (!input.target) return { ok: false, reason: "no-target" };
  if (input.dirty) return { ok: false, reason: "dirty" };
  return { ok: true };
}

/** The label of a session for the send bar's "will be sent to" line. */
export function destinationLabel(t: Copy, sessionId: string, viewedSessionId: string | null, bots: ReadonlyMap<string, { name: string }>, botIds: readonly string[], sessions: readonly SessionSummary[]): string | null {
  if (sessionId === viewedSessionId) return null;
  const session = sessions.find((row) => row.id === sessionId);
  const names = botIds.map((id) => bots.get(id)?.name ?? t.top.deleted);
  if (session?.kind === "direct" || names.length > 0) return t.stream.annotationSendTo(names.join(" / ") || t.top.deleted);
  return t.stream.annotationSendTo(session?.name ?? t.top.deleted);
}
