/**
 * The open session lives in the URL as `?s=<id>`. The open artifact preview is `?p=<relpath>`.
 * Queries rather than paths because the Tauri window serves a static build over the asset
 * protocol, which has no SPA fallback: `/s/<id>` would 404 the moment the window reloaded, while
 * `index.html?s=<id>&p=<relpath>` is always the file on disk.
 */
export const SESSION_PARAM = "s";
export const PREVIEW_PARAM = "p";

export function sessionFromUrl(url: URL): string | null {
  return url.searchParams.get(SESSION_PARAM);
}

export function previewFromUrl(url: URL): string | null {
  return sanitizePreviewPath(url.searchParams.get(PREVIEW_PARAM));
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

/**
 * Where the URL should go for this selection, or `null` when it is already right. Returning null
 * is what keeps the two mirrored effects from navigating each other in circles.
 *
 * Pass `previewRelpath` to write or clear `?p=`. Omit it to leave the preview query alone.
 */
export function sessionUrl(
  current: URL,
  selectedId: string | null,
  previewRelpath?: string | null,
): string | null {
  const next = new URL(current);
  if (selectedId) next.searchParams.set(SESSION_PARAM, selectedId);
  else next.searchParams.delete(SESSION_PARAM);
  if (previewRelpath !== undefined) {
    const preview = sanitizePreviewPath(previewRelpath);
    if (preview) next.searchParams.set(PREVIEW_PARAM, preview);
    else next.searchParams.delete(PREVIEW_PARAM);
  }
  // Compare decoded params, not `search` strings: `/` in a preview path is legal unencoded in
  // the href, but `URLSearchParams` always writes it as `%2F`. String equality would bounce
  // forever between the two spellings.
  if (sameSearch(current, next)) return null;
  return `${next.pathname}${next.search}`;
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
