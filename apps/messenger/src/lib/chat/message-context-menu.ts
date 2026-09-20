import {
  extensionOf,
  looksLikeWorkspacePath,
  normalizeCitedPath,
  WORKSPACE_PATH_EXTENSIONS,
  type Attachment,
  type Message,
} from "@real-bot/protocol";
import { computeContextMenuPosition } from "../sidebar/session-context-menu.ts";
import { canQuoteReply } from "./quote-reply.ts";

export { computeContextMenuPosition };

const KNOWN_EXT = new Set<string>(WORKSPACE_PATH_EXTENSIONS);

function isCleanWorkspacePath(path: string): boolean {
  if (!looksLikeWorkspacePath(path)) return false;
  if (/[\s*`'"<>{}|\\^~:;，。！？：；（）()\[\]]/.test(path)) return false;
  const ext = extensionOf(path);
  if (ext && KNOWN_EXT.has(ext)) return true;
  return /^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*\/?$/.test(path);
}

/**
 * Extract workspace-relative file paths associated with a message:
 * 1. Attached files (`workspace_relpath`)
 * 2. Markdown links `[text](path)` or `[text](artifact:path)`
 * 3. Artifact links `artifact:path`
 * 4. Inline code backticks `` `path` ``
 * 5. Bare path tokens in text that look like workspace relative paths
 */
export function extractAssociatedFiles(message: {
  body?: string | null;
  attachments?: Attachment[] | null;
}): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  function add(raw: string | null | undefined): void {
    if (!raw) return;
    let path = raw.trim();
    if (path.startsWith("artifact:")) path = path.slice("artifact:".length).trim();
    path = path.replace(/^[*_`'"()（）:：<>[\]]+|[*_`'"()（）:：<>[\]]+$/g, "").trim();
    const normalized = normalizeCitedPath(path);
    if (!normalized || normalized === "." || seen.has(normalized)) return;
    if (isCleanWorkspacePath(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  // 1. Attachments first
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.workspace_relpath) {
        add(att.workspace_relpath);
      }
    }
  }

  const body = message.body ?? "";
  if (!body) return result;

  // 2. Markdown links: [text](href)
  const mdLinkRegex = /\[(?:[^\]]*)\]\(([^)\s]+)\)/g;
  for (const match of body.matchAll(mdLinkRegex)) {
    add(match[1]);
  }

  // 3. Artifact scheme: artifact:path
  const artifactRegex = /artifact:([^\s)'"`]+)/g;
  for (const match of body.matchAll(artifactRegex)) {
    add(match[1]);
  }

  // 4. Backticked tokens: `path/to/file`
  const backtickRegex = /`([^`\n]+)`/g;
  for (const match of body.matchAll(backtickRegex)) {
    const candidate = match[1]?.trim();
    if (candidate && looksLikeWorkspacePath(candidate)) {
      add(candidate);
    }
  }

  // 5. Bare path tokens in text
  const tokens = body.split(/[\s,;()[\]{}'"`]+/);
  for (const token of tokens) {
    if (looksLikeWorkspacePath(token)) {
      add(token);
    }
  }

  return result;
}

export type MessageContextMenuData = {
  messageId: string;
  canReply: boolean;
  canCopy: boolean;
  associatedFiles: string[];
  canOpenWorkspace: boolean;
  targetPath: string | null;
};

export function deriveMessageContextMenu(
  message: Message,
  opts: {
    lockedComposer?: boolean;
    hasWorkspace?: boolean;
  } = {},
): MessageContextMenuData {
  const associatedFiles = extractAssociatedFiles(message);
  const canReply = canQuoteReply(message) && !opts.lockedComposer;
  const canCopy = Boolean(message.body && message.body.length > 0);
  const canOpenWorkspace = Boolean(opts.hasWorkspace);
  const targetPath = associatedFiles[0] ?? null;

  return {
    messageId: message.id,
    canReply,
    canCopy,
    associatedFiles,
    canOpenWorkspace,
    targetPath,
  };
}
