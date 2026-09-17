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

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
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

export function looksLikeWorkspaceHref(href: string): boolean {
  const path = href.trim();
  if (!path || path.includes("://") || /^(https?:|mailto:|javascript:|data:|artifact:)/i.test(path)) {
    return false;
  }
  if (path.startsWith("/") || path.startsWith("#") || path.startsWith("?")) return false;
  if (path.startsWith("@")) return false;
  const ext = extensionOf(path);
  return path.includes("/") || ext.length > 0;
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

export function stripSvgActiveContent(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2$2');
}
