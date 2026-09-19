/**
 * The open session lives in the URL as `?s=<id>`. A query rather than a path because the Tauri
 * window serves a static build over the asset protocol, which has no SPA fallback: `/s/<id>`
 * would 404 the moment the window reloaded, while `index.html?s=<id>` is always the file on disk.
 */
export const SESSION_PARAM = "s";

export function sessionFromUrl(url: URL): string | null {
  return url.searchParams.get(SESSION_PARAM);
}

/**
 * Where the URL should go for this selection, or `null` when it is already right. Returning null
 * is what keeps the two mirrored effects from navigating each other in circles.
 */
export function sessionUrl(current: URL, selectedId: string | null): string | null {
  const next = new URL(current);
  if (selectedId) next.searchParams.set(SESSION_PARAM, selectedId);
  else next.searchParams.delete(SESSION_PARAM);
  if (next.search === current.search) return null;
  return `${next.pathname}${next.search}`;
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
