/**
 * Whether the page is still running the build the server is serving.
 *
 * A phone keeps one hosted page open for days while the Mac publishes new bundles, so the page
 * asks. The answer is `_app/version.json`, the file SvelteKit already writes beside the build;
 * comparing it with this page's own version is the whole check. The window does not use any of
 * this — it replaces itself through the installer.
 */
export const BUILD_POLL_MS = 30_000;

export function publishedVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const version = (payload as { version?: unknown }).version;
  return typeof version === "string" && version !== "" ? version : null;
}

/**
 * Dismissing the notice says "not this one", not "never again": a build published after the
 * dismissed one asks again, which is what a page left open through an afternoon of deploys needs.
 */
export function offersRefresh(running: string, published: string | null, dismissed: string | null): boolean {
  return published !== null && published !== running && published !== dismissed;
}

/** Never from the cache: a stale answer is the one case where this check is worse than none. */
export async function fetchPublishedVersion(base: string): Promise<unknown> {
  const response = await fetch(`${base}/_app/version.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("version unavailable");
  return response.json();
}
