/** Annotation tools: what you wrote on a Bot's files. */
import { clipQuote, describeAnchor, normalizeCitedPath, USER_MEMBER, type Annotation, type AnnotationFilter, type AnnotationStatus, type TextRangeAnchor } from "@real-bot/protocol";
import { isAbsolute } from "node:path";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { toolFail as fail } from "../tool-result";
import { classifyPath, expandHome } from "../workspace-paths";
import { optionalString, requireString } from "./args";

const ANNOTATION_LIST_MAX = 100;

/** Oldest first, like the store's own order, when two status queries are merged. */
function byCreation(a: Annotation, b: Annotation): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Where a list_annotations `path` may point, in order: resolved the way read_file resolves it
 * (workspace-relative, `~`, or a host absolute path inside the workspace), then — for a relative
 * path — from this turn's work dir, the shell's point of view. `outside` when no reading lands in
 * the workspace, where nothing can be annotated.
 */
function annotationPathCandidates(ctx: ToolCtx, root: string, path: string): { relpaths: string[] } | { outside: string } {
  const input = normalizeCitedPath(path) ?? path;
  const readings = [input];
  if (ctx.workDir && !isAbsolute(expandHome(input)) && !input.startsWith(`${ctx.workDir}/`)) readings.push(`${ctx.workDir}/${input}`);
  const relpaths: string[] = [];
  let outside = "";
  for (const reading of readings) {
    const classified = classifyPath(root, reading);
    if (classified.zone === "outside") outside ||= classified.abs;
    else if (!relpaths.includes(classified.rel)) relpaths.push(classified.rel);
  }
  return relpaths.length > 0 ? { relpaths } : { outside };
}

/**
 * The user's annotations for this job: by default every pending one on a file in this turn's work
 * dir, on this job's deliveries, or sent in this session; one file when `path` names it. Each says
 * which Bot it was handed to.
 */
export function listAnnotations(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const locale = ctx.store.settingsCached().locale === "en" ? "en" : "zh";
  const status = optionalString(args.status) ?? "open";
  if (!["open", "resolved", "all"].includes(status)) return fail("invalid_args", "status must be open, resolved, or all");
  // By status in the query itself: drafts are the user's until sent, and are never even read here.
  const statuses: AnnotationStatus[] = status === "all" ? ["open", "resolved"] : [status as AnnotationStatus];
  const query = (filter: AnnotationFilter = {}): Annotation[] => {
    const found = statuses.flatMap((one) => ctx.store.listAnnotations({ ...filter, status: one }));
    return statuses.length > 1 ? found.sort(byCreation) : found;
  };
  const path = optionalString(args.path);
  let rows: Annotation[] = [];
  if (path) {
    const root = ctx.store.workspacePath();
    if (!root) return fail("failed", "workspace is not set");
    const candidates = annotationPathCandidates(ctx, root, path);
    if ("outside" in candidates) {
      return fail("invalid_args", `${candidates.outside} is outside the workspace; annotations only hang on files inside it`);
    }
    for (const relpath of candidates.relpaths) {
      rows = query({ relpath });
      if (rows.length > 0) break;
    }
  } else {
    const taskId = ctx.store.taskOfTurn(ctx.turnId);
    // The work dir as cited and as resolved (a symlinked `work/` resolves elsewhere); a row counts
    // when either spelling of its file sits under either spelling of the dir.
    const dirs: string[] = [];
    const scopeDir = ctx.planDir ?? ctx.workDir;
    if (scopeDir) {
      dirs.push(`${scopeDir}/`);
      const root = ctx.store.workspacePath();
      if (root) {
        try {
          const resolved = classifyPath(root, scopeDir);
          if (resolved.zone === "inside" && resolved.rel && resolved.rel !== scopeDir) dirs.push(`${resolved.rel}/`);
        } catch {
          // A dir that is not there yet has only the one spelling.
        }
      }
    }
    const inJob = (row: Annotation): boolean =>
      row.session_id === ctx.sessionId
      // The file it is on, cited or resolved: a delivery may have cited it by an absolute or `~` path.
      || [row.relpath, row.file_key].some((path) => path && dirs.some((dir) => path.startsWith(dir)))
      || (taskId !== null && row.target_turn_id !== null && ctx.store.taskOfTurn(row.target_turn_id) === taskId);
    rows = query().filter(inJob);
  }
  const names = new Map<string, string | null>();
  /** A Bot's name; null once it is deleted. */
  const botName = (id: string): string | null => {
    if (names.has(id)) return names.get(id) ?? null;
    let name: string | null = null;
    try { name = ctx.store.getBot(id).name; } catch { /* deleted */ }
    names.set(id, name);
    return name;
  };
  const resolverName = (id: string | null): string | null => {
    if (!id) return null;
    if (id === USER_MEMBER) return locale === "en" ? "user" : "用户";
    return botName(id) ?? id; // a deleted Bot keeps its id
  };
  const items = rows.slice(0, ANNOTATION_LIST_MAX).map((row) => ({
    id: row.id,
    // The Bot it was handed to — the one that delivered the file. Handle yours; leave another Bot's to it.
    for_bot: botName(row.bot_id) ?? (locale === "en" ? "a deleted Bot" : "已删除的 Bot"),
    path: row.relpath,
    kind: row.anchor_kind,
    position: describeAnchor(row.anchor_kind, row.anchor, locale),
    ...(row.anchor_kind === "text_range" ? { quote: clipQuote((row.anchor as TextRangeAnchor).quote, undefined, locale) } : {}),
    note: row.body,
    status: row.status,
    stale: row.stale?.kind ?? null,
    ...(row.stale?.kind === "moved" ? { moved_to: { start_line: row.stale.start_line, end_line: row.stale.end_line } } : {}),
    has_crop: Boolean(row.crop_mime),
    message_id: row.message_id,
    resolved_by: resolverName(row.resolved_by),
    resolved_note: row.resolved_note,
  }));
  return { ok: true, data: { annotations: items, total: rows.length, truncated: rows.length > ANNOTATION_LIST_MAX }, emitted: [] };
}

/**
 * Any Bot may mark one handled — a Bot is not a permission boundary — and the mark records who.
 * Whose it is to handle is the prompt's business: each one names the Bot it was handed to.
 */
export function resolveAnnotation(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const id = requireString(args.id, "id");
  const note = optionalString(args.note) ?? "";
  if (!note.trim()) return fail("invalid_args", "note is required: say what changed");
  try {
    const row = ctx.store.resolveAnnotationByBot(id, ctx.botId, note);
    // `relpath`, not `path`: a top-level `path` in tool data reads as a file this turn wrote.
    return { ok: true, data: { id: row.id, relpath: row.relpath, status: row.status, resolved_note: row.resolved_note }, emitted: [] };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.code === "not_found") return fail("not_found", "annotation not found");
      return fail(error.code, error.message);
    }
    throw error;
  }
}
