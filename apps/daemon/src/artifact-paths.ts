/** Workspace-relative paths a Bot may cite as artifacts. Path detection lives in the protocol. */

import { looksLikeWorkspacePath, normalizeCitedPath } from "@real-bot/protocol";

export { looksLikeWorkspacePath };

const MD_LINK = /\[(?:[^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g;
const BACKTICK = /`([^`\n]+)`/g;

export function extractWorkspacePathsFromBody(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string) => {
    const path = normalizeCitedPath(raw);
    if (!path || !looksLikeWorkspacePath(path) || seen.has(path)) return;
    seen.add(path);
    found.push(path);
  };
  for (const match of body.matchAll(MD_LINK)) {
    consider(stripMdHref(match[1] ?? ""));
  }
  for (const match of body.matchAll(BACKTICK)) {
    consider(match[1] ?? "");
  }
  return found;
}

export function mergeCitedPaths(explicit: string[], fromBody: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...explicit, ...fromBody]) {
    const path = normalizeCitedPath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Wrap known workspace paths in the body as Markdown links; append any that never appear. */
export function linkifyWorkspacePaths(body: string, extraPaths: string[] = []): string {
  const extras = mergeCitedPaths(extraPaths, []);
  const known = [...extras].sort((a, b) => b.length - a.length);
  const parts = splitFences(body);
  const linked = parts
    .map((part) => (part.fence ? part.text : linkifyOutsideFences(part.text, known)))
    .join("");
  const missing = extras.filter((path) => !bodyMentionsPath(linked, path));
  if (missing.length === 0) return linked;
  const block = missing.map((path) => `[${path}](${path})`).join("\n");
  if (!linked.trim()) return block;
  return `${linked.replace(/\s+$/, "")}\n\n${block}`;
}

export function bodyMentionsPath(body: string, path: string): boolean {
  const normalized = normalizeCitedPath(path);
  if (!normalized) return false;
  if (extractWorkspacePathsFromBody(body).includes(normalized)) return true;
  return body.includes(normalized);
}

export function writtenPathFromToolData(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const consider = (value: unknown) => {
    if (typeof value !== "string") return;
    const path = normalizeCitedPath(value);
    if (path && looksLikeWorkspacePath(path)) out.push(path);
  };
  consider(data.path);
  consider(data.file);
  consider(data.output_path);
  if (Array.isArray(data.paths)) {
    for (const item of data.paths) consider(item);
  }
  return mergeCitedPaths(out, []);
}

function stripMdHref(href: string): string {
  const trimmed = href.trim();
  const sp = trimmed.search(/\s/);
  return sp === -1 ? trimmed : trimmed.slice(0, sp);
}

function splitFences(body: string): Array<{ text: string; fence: boolean }> {
  const parts: Array<{ text: string; fence: boolean }> = [];
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let last = 0;
  for (const match of body.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: body.slice(last, start), fence: false });
    parts.push({ text: match[0]!, fence: true });
    last = start + match[0]!.length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), fence: false });
  if (parts.length === 0) parts.push({ text: body, fence: false });
  return parts;
}

function linkifyOutsideFences(text: string, known: string[]): string {
  const protectedLinks: string[] = [];
  let next = text.replace(/\[(?:[^\]]*)\]\((?:<[^>]+>|[^)\s]+)\)/g, (link) => {
    const token = `\u0000L${protectedLinks.length}\u0000`;
    protectedLinks.push(link);
    return token;
  });
  next = next.replace(/`([^`\n]+)`/g, (full, inner: string) => {
    const path = normalizeCitedPath(inner);
    if (!path || !looksLikeWorkspacePath(path)) return full;
    return `[${inner.trim()}](${path})`;
  });
  for (const path of known) {
    next = replaceBarePath(next, path);
  }
  next = next.replace(/`([^`\n]+)`/g, (full, inner: string) => {
    const path = normalizeCitedPath(inner);
    if (!path || !looksLikeWorkspacePath(path)) return full;
    return `[${inner.trim()}](${path})`;
  });
  return next.replace(/\u0000L(\d+)\u0000/g, (_, i: string) => protectedLinks[Number(i)] ?? "");
}

function replaceBarePath(text: string, path: string): string {
  if (!path || text.includes(`](${path})`)) return text;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, "g");
  return text.replace(re, `[${path}](${path})`);
}
