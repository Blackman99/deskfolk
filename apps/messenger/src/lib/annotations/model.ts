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

/**
 * The rows drawn on the file itself — the boxes on a picture, the marks in a margin, the points
 * on a timeline. A resolved one comes off the moment it is resolved: a Bot fixing it mid-task takes
 * its box away, so what is still drawn is what is still to do. Two things put a resolved row back:
 * the person asking for resolved ones (`showResolved`, the bar's checkbox), or going to that very
 * row from the list (`revealedId`) — a 定位 has to land somewhere. The list itself keeps every row.
 */
export function drawnAnnotations(rows: readonly Annotation[], view: { showResolved: boolean; revealedId: string | null }): Annotation[] {
  if (view.showResolved) return [...rows];
  return rows.filter((row) => row.status !== "resolved" || row.id === view.revealedId);
}

/** Where a text range sits now: the relocated lines when the file moved it, else the stored ones. */
export function effectiveLines(row: Annotation): { start_line: number; end_line: number } | null {
  if (row.anchor_kind !== "text_range") return null;
  if (row.stale?.kind === "moved") return { start_line: row.stale.start_line, end_line: row.stale.end_line };
  const anchor = row.anchor as TextRangeAnchor;
  return { start_line: anchor.start_line, end_line: anchor.end_line };
}

/**
 * A cited path with the spelling noise taken off — the workspace prefix of an absolute path,
 * `./`, doubled and trailing slashes — so two spellings of the same place compare equal. `..` is
 * left alone: through a symlink it can name another file, and only the daemon knows which
 * (`file_key`).
 */
export function canonicalRelpath(path: string, workspacePath: string | null = null): string {
  let p = path.trim();
  const root = workspacePath?.trim().replace(/\/+$/, "");
  if (root && (p === root || p.startsWith(`${root}/`))) p = p.slice(root.length);
  return p
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * One file's annotations in reading order: by position for text, by time for the rest. The rows
 * made on this spelling of its path, and — by the file the daemon resolved them to — the ones
 * made on any other spelling of the same file.
 */
export function annotationsForFile(
  rows: readonly Annotation[],
  relpath: string,
  workspacePath: string | null = null,
  fileKey: string | null = null,
): Annotation[] {
  const want = canonicalRelpath(relpath, workspacePath);
  const own = (row: Annotation): boolean => row.relpath === relpath || canonicalRelpath(row.relpath, workspacePath) === want;
  const key = fileKey ?? rows.find((row) => own(row) && row.file_key)?.file_key ?? null;
  return rows
    .filter((row) => own(row) || (key !== null && row.file_key === key))
    .sort((a, b) => {
      const la = effectiveLines(a);
      const lb = effectiveLines(b);
      if (la && lb && la.start_line !== lb.start_line) return la.start_line - lb.start_line;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1;
    });
}

/**
 * Put rows a reply brought back into the list, unless the list already holds a newer copy: a
 * reply can land after the events it raced (a fast Bot resolves a batch before the send returns),
 * and the reply's `open` must not paint over the event's `resolved`. On a tie `onTie` decides — a
 * write's own reply is the event's twin, so the list keeps its row; a fresh read carries `stale`,
 * which no event refreshes, so the read wins.
 */
export function mergeAnnotationRows(list: readonly Annotation[], incoming: readonly Annotation[], onTie: "keep" | "replace" = "keep"): Annotation[] {
  const next = new Map(list.map((row) => [row.id, row]));
  for (const row of incoming) {
    const current = next.get(row.id);
    const newer = !current || row.updated_at > current.updated_at || (row.updated_at === current.updated_at && onTie === "replace");
    if (newer) next.set(row.id, row);
  }
  return [...next.values()];
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
    handsOver(message, relpath);
  const later = (a: Message, b: Message): number => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);
  const citing = messages.filter(cites).sort(later);
  if (scope.taskId) {
    const inJob = citing.filter((message) => message.task_id === scope.taskId);
    if (inJob.length > 0) return inJob.at(-1)!;
  }
  return citing.at(-1) ?? null;
}

/** Whether a message handed this path over: attached it, or named it on an `附件：` line. */
function handsOver(message: Message, relpath: string): boolean {
  return handedOverPaths(message.body ?? "", message.attachments.map((row) => row.workspace_relpath)).includes(relpath);
}

/**
 * 挂到谁，给预览上的这个路径：打开预览的那条消息自己交出了这个路径，就挂它；否则（在文件树里切到了
 * 别的 Bot 交出的文件、你自己上传的文件）按 `deliveryFor` 找——同一会话里最近交出它的 Bot 消息，先找
 * 那件事里的。没有哪条 Bot 消息交出过的文件没有去处。
 */
export function targetFor(
  messages: readonly Message[],
  relpath: string,
  owner: Message | null | undefined,
  scope: { sessionId: string | null; taskId?: string | null },
): AnnotationTarget | null {
  const own = owner && handsOver(owner, relpath) ? targetFromMessage(owner) : null;
  return own ?? targetFromMessage(deliveryFor(messages, relpath, scope));
}

/** Which anchor adapter the view on screen uses; null for a kind nothing can be annotated on. */
export type AnnotationAdapter = "text" | "markdown" | "image" | "pdf" | "html" | "media";

export function adapterFor(kind: ArtifactKind, sourceMode: boolean): AnnotationAdapter | null {
  if (kind === "text") return "text";
  if (kind === "markdown") return sourceMode ? "text" : "markdown";
  if (kind === "html") return sourceMode ? "text" : "html";
  if (kind === "image" || kind === "svg") return "image";
  if (kind === "pdf") return "pdf";
  if (kind === "audio" || kind === "video") return "media";
  return null;
}

/** The anchor kind each adapter writes. */
export const ADAPTER_ANCHOR_KIND = {
  text: "text_range",
  markdown: "text_range",
  image: "image_region",
  pdf: "pdf_region",
  html: "html_element",
  media: "media_time",
} as const satisfies Record<AnnotationAdapter, Annotation["anchor_kind"]>;

export type AnnotateGate = { ok: true; adapter: AnnotationAdapter } | { ok: false; reason: "no-target" | "dirty" | "kind" };

/**
 * Whether the preview on screen can take a new annotation, and if not, why. Unsaved edits block
 * every text-backed view: an anchor must point at text that is on disk.
 */
export function annotateGate(input: { target: AnnotationTarget | null; kind: ArtifactKind; sourceMode: boolean; dirty: boolean }): AnnotateGate {
  const adapter = adapterFor(input.kind, input.sourceMode);
  if (!adapter) return { ok: false, reason: "kind" };
  if (!input.target) return { ok: false, reason: "no-target" };
  const textBacked = input.kind === "text" || input.kind === "markdown" || input.kind === "html";
  if (input.dirty && textBacked) return { ok: false, reason: "dirty" };
  return { ok: true, adapter };
}

/** The label of a session for the send bar's "will be sent to" line. */
export function destinationLabel(t: Copy, sessionId: string, viewedSessionId: string | null, bots: ReadonlyMap<string, { name: string }>, botIds: readonly string[], sessions: readonly SessionSummary[]): string | null {
  if (sessionId === viewedSessionId) return null;
  const session = sessions.find((row) => row.id === sessionId);
  const names = botIds.map((id) => bots.get(id)?.name ?? t.top.deleted);
  if (session?.kind === "direct" || names.length > 0) return t.stream.annotationSendTo(names.join(" / ") || t.top.deleted);
  return t.stream.annotationSendTo(session?.name ?? t.top.deleted);
}
