import { handedOverPaths, looksLikeWorkspaceHref, withoutAttachmentDeclarations } from "../overlays/artifacts.ts";

/** Old messages may end with a generated inventory already represented by attachment entries. */
export function messageDisplayBody(body: string, attached: readonly string[]): string {
  const paths = new Set(handedOverPaths(body, attached));
  if (paths.size === 0) return body;
  const source = withoutAttachmentDeclarations(resolvePathsToAttachments(body, attached));
  const lines = source.split("\n");
  let fence: { marker: string; length: number } | null = null;
  const inventory = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { marker: run[0]!, length: run.length };
      else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]!.trim()) fence = null;
      return false;
    }
    if (fence) return false;
    const link = /^\[([^\]\n]+)\]\(([^\n]+)\)[ \t]*$/.exec(line);
    return Boolean(link && link[1] === link[2] && paths.has(link[2]!));
  });
  let end = lines.length;
  while (end > 0 && (!lines[end - 1]!.trim() || inventory[end - 1])) end--;
  return lines.slice(0, end).join("\n");
}

const MD_LINK_TARGET = /\[(?:[^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g;
const BACKTICK = /`([^`\n]+)`/g;
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

/**
 * Messages stored before the daemon corrected them name a file from the Bot's shell cwd: the
 * `poster.png` it handed over as `work/<job>/poster.png`. Linked as written that is a root path
 * nothing exists at, so the preview says the file is gone. The message's own attachments say where
 * it is: a cited path that is not one of them but is the trailing segments of exactly one is shown
 * as that one, the way the daemon now stores it. Anything else, and code fences, stay as written.
 */
function resolvePathsToAttachments(body: string, attached: readonly string[]): string {
  if (attached.length === 0) return body;
  const known = new Set(attached.map((path) => path.trim()).filter(Boolean));
  let out = "";
  let last = 0;
  for (const match of body.matchAll(FENCE)) {
    const start = match.index ?? 0;
    out += resolveOutsideFences(body.slice(last, start), known) + match[0];
    last = start + match[0].length;
  }
  return out + resolveOutsideFences(body.slice(last), known);
}

function resolveOutsideFences(text: string, known: ReadonlySet<string>): string {
  const cited = new Set<string>();
  for (const match of text.matchAll(MD_LINK_TARGET)) cited.add(citedPath(match[1]!));
  for (const match of text.matchAll(BACKTICK)) cited.add(citedPath(match[1]!));
  let out = text;
  for (const path of cited) {
    if (!path || known.has(path) || !looksLikeWorkspaceHref(path)) continue;
    const owners = [...known].filter((candidate) => candidate.endsWith(`/${path}`));
    if (owners.length !== 1) continue;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\w./-])(?:\\./)?${escaped}(?![\\w./-])`, "g"), owners[0]!);
  }
  return out;
}

function citedPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1).trim();
  return path.startsWith("./") ? path.slice(2) : path;
}
