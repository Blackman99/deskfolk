/**
 * The phone's service worker: `/sw.js`, which `scripts/phone-package.ts` copies into the package
 * from the messenger's `static/`, as the Svelte page registers it (`routes/+layout.svelte`). Web
 * push, the app badge, a tapped notification and remote media all go through it; without it
 * `navigator.serviceWorker.ready` never settles, so turning notifications on in the phone's
 * settings waited for ever.
 *
 * The app runs in a hidden `about:blank` frame of the page (ADR 0107, Phase 1c). The worker is the
 * page's: it controls the page, and a tapped notification focuses the page and posts it
 * `{ type: "inbox" }`. So the realm's `navigator.serviceWorker` is made the page's container: the
 * messenger's code (`remote/push.ts`, `remote/media-source.ts`, the runtime's push listener) then
 * registers, waits for `ready`, subscribes and hears the worker on the page, whichever way a
 * browser treats an `about:blank` frame's own container. A page that runs the app in its own realm
 * (an opaque origin) already has it.
 */
type Container = ServiceWorkerContainer;
type Realm = { navigator?: Navigator; parent?: { navigator?: Navigator } | null; isSecureContext?: boolean };

/** The page's container, or null where there is no worker to have (an insecure page, no support). */
export function pageContainer(realm: Realm = globalThis as unknown as Realm): Container | null {
  let page: Realm | null = null;
  try {
    if (realm.parent && realm.parent !== (realm as unknown) && realm.parent.navigator) page = realm.parent as Realm;
  } catch {
    // A parent of another origin: this realm's own container is the only one there is.
  }
  return (page ?? realm).navigator?.serviceWorker ?? null;
}

export function pageServiceWorker(realm: Realm = globalThis as unknown as Realm): Container | null {
  if (!realm.isSecureContext) return null;
  const container = pageContainer(realm);
  if (!container) return null;
  const own = realm.navigator;
  if (own && own.serviceWorker !== container) {
    Object.defineProperty(own, "serviceWorker", { configurable: true, enumerable: true, get: () => container });
  }
  void container.register("/sw.js").catch(() => {
    // No worker (a page served without it): push stays unsupported, media plays without streaming.
  });
  return container;
}
