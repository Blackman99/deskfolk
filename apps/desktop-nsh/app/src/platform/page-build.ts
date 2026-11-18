/**
 * Which build the phone's page is, and the notice when the relay serves a newer one (the Svelte
 * page's `+layout.svelte` and `BuildUpdateNotice.svelte`). A phone keeps the page open for days
 * while new builds go up; the page polls `_app/version.json` and offers a reload, never forces one.
 *
 * `scripts/phone-package.ts` writes the build's version twice: in the page's params (`#nsh-params`,
 * here `host.params.build`) and in `_app/version.json` beside the page. The desktop's shell passes
 * params without a build, so there is nothing to poll there; nor on a page packaged without
 * `phone-package.ts` (the local web build).
 */
import { host } from "nsh";
import { fetchPublishedVersion } from "../m/build-version.ts";
import { BuildUpdates } from "../m/build-version.svelte.ts";

/** The build the page was served as, or null when it was not served with one. */
export function pageBuild(params: unknown): string | null {
  const build = (params as { build?: unknown } | null | undefined)?.build;
  return typeof build === "string" && build !== "" ? build : null;
}

/** The poll for a newer build than this page's, or null when the page does not know its own. */
export function pageBuildUpdates(params: unknown = host.params): BuildUpdates | null {
  const running = pageBuild(params);
  // Relative to the page: the app's realm resolves its `fetch` URLs against the page's address.
  return running ? new BuildUpdates(running, () => fetchPublishedVersion(".")) : null;
}

type Reloadable = { location: { reload(): void } };

/**
 * Loads the page again. The app runs in a frame of the page (NSH's realm for the app's modules),
 * and that frame's own reload would start the app over inside the old page; the page is `top`.
 */
export function reloadPage(realm: { top?: Reloadable | null } & Partial<Reloadable> = globalThis as never): void {
  (realm.top ?? (realm as Reloadable)).location.reload();
}
