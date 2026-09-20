/**
 * The open session lives in the URL as `?s=<id>`. The open artifact preview is `?p=<relpath>`.
 * Settings, the session drawer and the workspace overlay share `?o=`. Queries rather than paths
 * because the Tauri window serves a static build over the asset protocol, which has no SPA
 * fallback: `/s/<id>` would 404 the moment the window reloaded, while
 * `index.html?s=<id>&p=<relpath>&o=settings` is always the file on disk.
 */
export const SESSION_PARAM = "s";
export const PREVIEW_PARAM = "p";
export const OVERLAY_PARAM = "o";
export const OVERLAY_BOT_PARAM = "b";
export const WORKSPACE_FILE_PARAM = "w";
export const ATTACHMENT_PARAM = "a";

export const OVERLAY_SETTINGS = "settings";
export const OVERLAY_SESSION = "session";
export const OVERLAY_BOT = "bot";
export const OVERLAY_WORKSPACE = "workspace";

export type UrlOverlay =
  | { kind: "none" }
  | { kind: "settings" }
  | { kind: "session" }
  | { kind: "bot"; botId: string }
  | { kind: "workspace"; selected: string | null };

export type UrlView = {
  selectedId: string | null;
  previewRelpath: string | null;
  previewAttachmentId: string | null;
  overlay: UrlOverlay;
};

export function sessionFromUrl(url: URL): string | null {
  return url.searchParams.get(SESSION_PARAM);
}

export function previewFromUrl(url: URL): string | null {
  return sanitizePreviewPath(url.searchParams.get(PREVIEW_PARAM));
}

export function attachmentFromUrl(url: URL): string | null {
  return sanitizeBotId(url.searchParams.get(ATTACHMENT_PARAM));
}

export function overlayFromUrl(url: URL, remote = false): UrlOverlay {
  const raw = url.searchParams.get(OVERLAY_PARAM);
  if (raw === OVERLAY_SETTINGS) return { kind: "settings" };
  if (raw === OVERLAY_SESSION) return { kind: "session" };
  if (raw === OVERLAY_BOT) {
    const botId = sanitizeBotId(url.searchParams.get(OVERLAY_BOT_PARAM));
    return botId ? { kind: "bot", botId } : { kind: "none" };
  }
  if (raw === OVERLAY_WORKSPACE) {
    return { kind: "workspace", selected: remote ? null : sanitizePreviewPath(url.searchParams.get(WORKSPACE_FILE_PARAM)) };
  }
  return { kind: "none" };
}

export function viewFromUrl(url: URL, remote = false): UrlView {
  return {
    selectedId: sessionFromUrl(url),
    previewRelpath: remote ? null : previewFromUrl(url),
    previewAttachmentId: remote ? sanitizeBotId(url.searchParams.get(ATTACHMENT_PARAM)) : null,
    overlay: overlayFromUrl(url, remote),
  };
}

export function overlayFromFlags(flags: {
  settingsOpen: boolean;
  sessionSettingsOpen: boolean;
  profileBotId: string | null;
  workspaceOpen: boolean;
  workspaceSelected: string | null;
}): UrlOverlay {
  if (flags.settingsOpen) return { kind: "settings" };
  if (flags.sessionSettingsOpen) {
    const botId = sanitizeBotId(flags.profileBotId);
    return botId ? { kind: "bot", botId } : { kind: "session" };
  }
  if (flags.workspaceOpen) {
    return { kind: "workspace", selected: sanitizePreviewPath(flags.workspaceSelected) };
  }
  return { kind: "none" };
}

export function overlaysEqual(a: UrlOverlay, b: UrlOverlay): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "bot" && b.kind === "bot") return a.botId === b.botId;
  if (a.kind === "workspace" && b.kind === "workspace") return a.selected === b.selected;
  return true;
}

/** Workspace-relative POSIX path, or null when the value is empty or would escape the workspace. */
export function sanitizePreviewPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const path = raw.trim();
  if (!path || path.startsWith("/") || path.includes("://")) return null;
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
  return parts.length === 0 ? null : parts.join("/");
}

export function sanitizeBotId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const id = raw.trim();
  if (!id || id.includes("/") || id.includes("://")) return null;
  return id;
}

/**
 * Where the URL should go for this view, or `null` when it is already right. Returning null
 * is what keeps the mirrored effects from navigating each other in circles.
 */
export function sessionUrl(current: URL, view: UrlView, remote = false): string | null {
  const next = new URL(current);
  if (view.selectedId) next.searchParams.set(SESSION_PARAM, view.selectedId);
  else next.searchParams.delete(SESSION_PARAM);

  if (remote) {
    next.searchParams.delete(PREVIEW_PARAM);
    next.searchParams.delete(WORKSPACE_FILE_PARAM);
    next.searchParams.delete(ATTACHMENT_PARAM);
  } else {
    next.searchParams.delete(ATTACHMENT_PARAM);
    const preview = sanitizePreviewPath(view.previewRelpath);
    if (preview) next.searchParams.set(PREVIEW_PARAM, preview);
    else next.searchParams.delete(PREVIEW_PARAM);
  }

  writeOverlay(next, remote ? stripRemoteOverlay(view.overlay) : view.overlay);
  if (remote) {
    const attachment = sanitizeBotId(view.previewAttachmentId);
    if (attachment) next.searchParams.set(ATTACHMENT_PARAM, attachment);
  }

  // Compare decoded params, not `search` strings: `/` in a preview path is legal unencoded in
  // the href, but `URLSearchParams` always writes it as `%2F`. String equality would bounce
  // forever between the two spellings.
  if (sameSearch(current, next)) return null;
  return `${next.pathname}${next.search}`;
}

function stripRemoteOverlay(overlay: UrlOverlay): UrlOverlay {
  if (overlay.kind === "workspace") return { kind: "workspace", selected: null };
  return overlay;
}

function writeOverlay(url: URL, overlay: UrlOverlay): void {
  url.searchParams.delete(OVERLAY_PARAM);
  url.searchParams.delete(OVERLAY_BOT_PARAM);
  url.searchParams.delete(WORKSPACE_FILE_PARAM);
  if (overlay.kind === "settings") {
    url.searchParams.set(OVERLAY_PARAM, OVERLAY_SETTINGS);
    return;
  }
  if (overlay.kind === "session") {
    url.searchParams.set(OVERLAY_PARAM, OVERLAY_SESSION);
    return;
  }
  if (overlay.kind === "bot") {
    url.searchParams.set(OVERLAY_PARAM, OVERLAY_BOT);
    url.searchParams.set(OVERLAY_BOT_PARAM, overlay.botId);
    return;
  }
  if (overlay.kind === "workspace") {
    url.searchParams.set(OVERLAY_PARAM, OVERLAY_WORKSPACE);
    if (overlay.selected) url.searchParams.set(WORKSPACE_FILE_PARAM, overlay.selected);
  }
}

function sameSearch(a: URL, b: URL): boolean {
  if (a.pathname !== b.pathname) return false;
  const left = [...a.searchParams.entries()].sort(compareEntry);
  const right = [...b.searchParams.entries()].sort(compareEntry);
  if (left.length !== right.length) return false;
  return left.every(([key, value], i) => key === right[i][0] && value === right[i][1]);
}

function compareEntry(a: readonly [string, string], b: readonly [string, string]): number {
  return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
}

export type UrlSelection =
  | { action: "none" }
  | { action: "clear" }
  /** The id is not in the snapshot yet; leave it until the session list arrives. */
  | { action: "wait"; id: string }
  | { action: "select"; id: string };

/** What a URL change should do to the runtime, given what it already has. */
export function selectionFromUrl(
  wanted: string | null,
  selectedId: string | null,
  knownSessionIds: readonly string[],
): UrlSelection {
  if (wanted === selectedId) return { action: "none" };
  if (!wanted) return { action: "clear" };
  if (!knownSessionIds.includes(wanted)) return { action: "wait", id: wanted };
  return { action: "select", id: wanted };
}

export type OverlayApply =
  | { action: "none" }
  | { action: "wait" }
  | { action: "set"; overlay: UrlOverlay };

export type OverlayContext = {
  selectedId: string | null;
  knownSessionIds: readonly string[];
  knownBotIds: readonly string[];
  hasWorkspacePath: boolean;
  snapshotReady: boolean;
};

export function overlayApply(
  wanted: UrlOverlay,
  current: UrlOverlay,
  ctx: OverlayContext,
): OverlayApply {
  const resolved = resolveOverlay(wanted, ctx);
  if (resolved === "wait") return { action: "wait" };
  if (overlaysEqual(resolved, current)) return { action: "none" };
  return { action: "set", overlay: resolved };
}

function resolveOverlay(wanted: UrlOverlay, ctx: OverlayContext): UrlOverlay | "wait" {
  if (wanted.kind === "none" || wanted.kind === "settings") return wanted;
  if (wanted.kind === "workspace") {
    if (!ctx.snapshotReady) return "wait";
    if (!ctx.hasWorkspacePath) return { kind: "none" };
    return wanted;
  }
  if (!ctx.selectedId) return { kind: "none" };
  if (!ctx.knownSessionIds.includes(ctx.selectedId)) {
    return ctx.snapshotReady ? { kind: "none" } : "wait";
  }
  if (wanted.kind === "session") return wanted;
  if (!ctx.snapshotReady) return "wait";
  if (!ctx.knownBotIds.includes(wanted.botId)) return { kind: "none" };
  return wanted;
}
