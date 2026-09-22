/**
 * Workspace-relative paths a Bot may cite as artifacts. Not a preview-kind enum:
 * the messenger still classifies image / markdown / generic file for the pane.
 */

/** Filename suffixes that make a bare `report.md` look like a path (slash-less names otherwise do not). */
export const WORKSPACE_PATH_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "opus",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "pdf",
  "html",
  "htm",
  "md",
  "markdown",
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
  "cc",
  "cpp",
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
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xd",
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  "glb",
  "gltf",
  "obj",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "sqlite",
  "db",
] as const;

const KNOWN_EXT = new Set<string>(WORKSPACE_PATH_EXTENSIONS);

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function normalizeCitedPath(raw: string): string | null {
  let path = raw.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1).trim();
  if (path.startsWith("./")) path = path.slice(2);
  if (!path || path === ".") return path === "." ? "." : null;
  return path;
}

function hasScheme(path: string): boolean {
  return /^(https?:|mailto:|javascript:|data:|artifact:|bot:)/i.test(path) || path.includes("://");
}

/** True for a relative workspace path: has a slash, or a known filename suffix. */
export function looksLikeWorkspacePath(raw: string): boolean {
  const path = normalizeCitedPath(raw);
  if (!path) return false;
  if (hasScheme(path)) return false;
  if (path.startsWith("@")) return false;
  const ext = extensionOf(path);
  return path.includes("/") || (Boolean(ext) && KNOWN_EXT.has(ext));
}

/**
 * The transcript line the runtime itself writes for a file it handed over:
 * `附件：inbox/notes.pdf`. A Bot that copies that shape back is handing files over the same way.
 * A line already turned into a markdown link (`附件：[path](path)`) is not this shape.
 */
const ATTACHMENT_LINE = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?附件[：:][ \t]*(`[^`\n]+`|[^\s[\]]+)/g;

/** A display line that is only an attachment handoff, raw or already linkified. */
const ATTACHMENT_DECLARATION = /^[ \t]*(?:[-*][ \t]+)?附件[：:][ \t]*(?:`[^`\n]+`|[^\s[\]]+|\[(?:[^\]]*)\]\([^)\s]+\))[ \t]*$/;

/** Paths named on their own line as `附件：<path>`, the shape transcript serialization uses. */
export function attachmentLinePaths(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_LINE)) {
    let token = (match[1] ?? "").trim();
    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) token = token.slice(1, -1);
    const path = normalizeCitedPath(token);
    if (!path || !looksLikeWorkspacePath(path) || seen.has(path)) continue;
    seen.add(path);
    found.push(path);
  }
  return found;
}

/** Drop lines whose only content is an attachment handoff, so the chip can stand in for them. */
export function withoutAttachmentDeclarations(body: string): string {
  const kept = body.split("\n").filter((line) => !ATTACHMENT_DECLARATION.test(line));
  return kept.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
