import { extensionOf, looksLikeWorkspacePath } from "@real-bot/protocol";

export { extensionOf };

export type ArtifactKind =
  | "image"
  | "svg"
  | "audio"
  | "video"
  | "pdf"
  | "html"
  | "markdown"
  | "text"
  | "directory"
  | "file";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v"]);
const HTML = new Set(["html", "htm"]);
const MARKDOWN = new Set(["md", "markdown"]);
const TEXT = new Set([
  "txt",
  "csv",
  "tsv",
  "log",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "svelte",
  "vue",
  "py",
  "pyi",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "php",
  "rb",
  "swift",
  "dart",
  "scala",
  "lua",
  "r",
  "pl",
  "pm",
  "hs",
  "ex",
  "exs",
  "erl",
  "hrl",
  "clj",
  "cljs",
  "zig",
  "nim",
  "json",
  "jsonc",
  "json5",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "css",
  "scss",
  "less",
  "sql",
  "graphql",
  "gql",
  "proto",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "diff",
  "patch",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "tf",
  "tfvars",
  "hcl",
  "mk",
]);

export const ARTIFACT_HREF_SCHEME = "artifact:";

/**
 * HTML preview iframe flags. `allow-scripts` is required for JS/CSS-driven
 * motion in single-file design HTML. Omit `allow-same-origin` so the frame
 * stays an opaque origin and cannot read the messenger page or local token.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-modals";

export function htmlPreviewBlob(source: string): Blob {
  return new Blob([source], { type: "text/html;charset=utf-8" });
}

/** Tell the preview document which scheme the messenger is using. */
export function injectHtmlPreviewColorScheme(source: string, scheme: "light" | "dark"): string {
  if (scheme !== "light" && scheme !== "dark") return source;
  const meta = `<meta name="color-scheme" content="${scheme}">`;
  let out = source;
  if (/<meta\s[^>]*name=["']color-scheme["'][^>]*>/i.test(out)) {
    out = out.replace(/<meta\s[^>]*name=["']color-scheme["'][^>]*>/i, meta);
  } else if (/<head[\s>]/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  } else if (/<html[\s>]/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  } else {
    out = `<!DOCTYPE html><html><head>${meta}</head><body>${out}</body></html>`;
  }
  return out;
}

/** Nonce from the messenger document, if Tauri injected one into CSP. */
export function pageCspNonce(doc: Document | null | undefined = typeof document === "undefined" ? null : document): string | null {
  if (!doc) return null;
  for (const el of doc.querySelectorAll("script, style")) {
    const nonce = (el as HTMLElement).nonce || el.getAttribute("nonce");
    if (nonce) return nonce;
  }
  return null;
}

/**
 * Blob documents inherit the parent CSP. Tauri puts a nonce on script-src /
 * style-src, which disables `'unsafe-inline'`, so preview HTML must carry
 * the same nonce on its own script and style tags.
 */
export function injectHtmlPreviewNonce(source: string, nonce: string | null | undefined): string {
  const token = nonce?.trim();
  if (!token || /["'<>]/.test(token)) return source;
  const attr = ` nonce="${token}"`;
  return source
    .replace(/<script\b(?![^>]*\bnonce\s*=)/gi, `<script${attr}`)
    .replace(/<style\b(?![^>]*\bnonce\s*=)/gi, `<style${attr}`);
}

export function artifactKind(filename: string, opts: { isDir?: boolean } = {}): ArtifactKind {
  if (opts.isDir) return "directory";
  const ext = extensionOf(filename);
  if (IMAGE.has(ext)) return "image";
  if (ext === "svg") return "svg";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (HTML.has(ext)) return "html";
  if (MARKDOWN.has(ext)) return "markdown";
  if (TEXT.has(ext)) return "text";
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase();
  if (base === "dockerfile" || base === "makefile" || base.startsWith("makefile.")) return "text";
  return "file";
}

export function isRasterImageName(name: string): boolean {
  return IMAGE.has(extensionOf(name));
}

/** Kinds the messenger can preview itself. Everything else uses the system opener. */
export function isInAppPreviewKind(kind: ArtifactKind): boolean {
  return (
    kind === "image" ||
    kind === "svg" ||
    kind === "audio" ||
    kind === "video" ||
    kind === "pdf" ||
    kind === "html" ||
    kind === "markdown" ||
    kind === "text"
  );
}

export type ArtifactByteSource = "attachment" | "workspace";

/** Where the preview pane should fetch bytes. Chat links that never became attachments still live in the workspace. */
export function artifactByteSource(opts: {
  mode: "cited" | "workspace";
  relpath: string;
  attachment?: { exists?: boolean; is_dir?: boolean } | null;
}): ArtifactByteSource | null {
  const path = opts.relpath.trim();
  if (!path) return null;
  if (opts.attachment?.is_dir) return null;
  if (opts.mode === "workspace") return "workspace";
  if (opts.attachment && opts.attachment.exists !== false) return "attachment";
  return "workspace";
}

export function looksLikeWorkspaceHref(href: string): boolean {
  const path = href.trim();
  if (path.startsWith("/") || path.startsWith("#") || path.startsWith("?")) return false;
  return looksLikeWorkspacePath(path);
}

export function artifactHref(path: string): string {
  return `${ARTIFACT_HREF_SCHEME}${encodeURIComponent(decodePercentPath(path))}`;
}

export function parseArtifactHref(href: string): string | null {
  const raw = href.trim();
  if (!raw.startsWith(ARTIFACT_HREF_SCHEME)) return null;
  const decoded = decodePercentPath(raw.slice(ARTIFACT_HREF_SCHEME.length));
  return decoded || null;
}

/** marked encodeURI's CJK hrefs before sanitize; encodeURIComponent then double-encodes. Undo until stable. */
function decodePercentPath(path: string): string {
  let current = path;
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(current)) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

/** Join a workspace-relative POSIX path onto an absolute workspace root. Rejects escapes. */
export function absWorkspacePath(root: string, rel: string): string | null {
  const base = root.trim();
  const path = rel.trim();
  if (!base || !path) return null;
  if (path.startsWith("/") || path.includes("://")) return null;
  let depth = 0;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (depth === 0) return null;
      parts.pop();
      depth--;
      continue;
    }
    parts.push(seg);
    depth++;
  }
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  if (parts.length === 0) return prefix;
  return `${prefix}/${parts.join("/")}`;
}

export function bodyMentionsPath(body: string, path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return body.includes(trimmed);
}

/** Turn known workspace paths in chat markdown into links; skip fenced code. */
export function linkifyWorkspacePaths(body: string, extraPaths: string[] = []): string {
  const extras = uniquePaths(extraPaths);
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

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
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
    if (!looksLikeWorkspaceHref(inner.trim())) return full;
    return `[${inner.trim()}](${inner.trim()})`;
  });
  for (const path of known) {
    if (!path || next.includes(`](${path})`)) continue;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, "g");
    next = next.replace(re, `[${path}](${path})`);
  }
  return next.replace(/\u0000L(\d+)\u0000/g, (_, i: string) => protectedLinks[Number(i)] ?? "");
}

const SVG_EVENT_ATTR = /(?:[\s/])on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>/]*)/gi;
const SVG_UNSAFE_URL = /(?:xlink:href|href|src|values|to|from)\s*=\s*(?:"\s*(?:javascript|data|vbscript):[^"]*"|'\s*(?:javascript|data|vbscript):[^']*'|(?:javascript|data|vbscript):[^\s>]+)/gi;

export function stripSvgActiveContent(svg: string): string {
  let previous = "";
  let next = svg;
  while (next !== previous) {
    previous = next;
    next = next
      .replace(/<script\b[\s\S]*?(?:<\/script\b[^>]*>|$)/gi, "")
      .replace(/<foreignObject\b[\s\S]*?(?:<\/foreignObject\b[^>]*>|$)/gi, "")
      .replace(SVG_EVENT_ATTR, " ")
      .replace(SVG_UNSAFE_URL, "");
  }
  const leftover = next.search(/<(?:script|foreignObject)\b/i);
  return leftover >= 0 ? next.slice(0, leftover) : next;
}

export async function svgDisplayBlob(source: Blob | string): Promise<Blob> {
  const raw = typeof source === "string" ? source : await source.text();
  return new Blob([stripSvgActiveContent(raw)], { type: "image/svg+xml" });
}
