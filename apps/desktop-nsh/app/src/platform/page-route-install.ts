/**
 * `page-route.ts` on the page: NSH's `UrlScheme` and the page's window (the app runs in a frame of
 * it, so `top` is the page), and the effects that keep the address and what is open together.
 * `Main.tsx` seeds before the runtime starts and installs while it renders, hosted only.
 */
import { cleanup, effect, signal, untracked, UrlScheme } from "nsh";
import { provideSelectionGate } from "../m/chat/selection-gate";
import { runtime } from "../runtime";
import { followLevels } from "./page-levels";
import { ENTRY_WAIT_MS, PageRoute, provideRoute, viewOf, withoutHash, type PageHistory } from "./page-route";

type PageWindow = {
  location: { href: string; hash: string };
  history: { back(): void; go(delta: number): void; state: { nsh?: number } | null };
  performance: { getEntriesByType(type: string): Array<{ type?: string }> };
};

const pageWindow = (): PageWindow => (globalThis as { top?: PageWindow | null }).top ?? (globalThis as unknown as PageWindow);

export const browserHistory: PageHistory = {
  href: () => pageWindow().location.href,
  navigation: () => pageWindow().performance.getEntriesByType("navigation")[0]?.type,
  setUrl: (url, history) => UrlScheme.setUrl(url, { history }),
  back: () => pageWindow().history.back(),
  go: (delta) => pageWindow().history.go(delta),
  whenAt(hash, then) {
    // NSH writes the address once the turn's entries exist; two seconds at most.
    let tries = 0;
    const look = () => {
      if (pageWindow().location.hash === hash || ++tries > 120) then();
      else setTimeout(look, 16);
    };
    look();
  },
  whenThere(ready, then) {
    // NSH writes it on a timer of its own, set when the address was: the first look comes after it.
    const until = Date.now() + ENTRY_WAIT_MS;
    const look = () => {
      if (ready() || Date.now() >= until) then();
      else setTimeout(look, 4);
    };
    setTimeout(look, 0);
  },
  later(then) {
    setTimeout(then, 0);
  },
  dialogDepth: () => pageWindow().history.state?.nsh ?? 0,
  onAddress(listener) {
    const changes = UrlScheme.on("change", (change) => listener(change.url, change.reason));
    const opens = UrlScheme.on("open", (open) => listener(open.url, "open"));
    return () => {
      changes();
      opens();
    };
  },
};

/** The route for the hosted page: `seed()` before `runtime.start()`, `install()` inside the component. */
export function pageRoute() {
  const address = signal(withoutHash(browserHistory.href()));
  const route = new PageRoute(browserHistory, runtime, address);
  return {
    route,
    seed: () => route.seed(),
    install(): void {
      route.armFloor();
      cleanup(browserHistory.onAddress((url, move) => route.moved(url, move)));
      // What has pages of its own reports them (`reportLevels`) and opens them by `stepIn`.
      cleanup(provideRoute(route));
      followLevels();
      // A conversation opened from a screen the address names alone gets its entry first.
      cleanup(provideSelectionGate((id) => route.entryFirst(id)));
      // The address moved (a link, Back, Forward): what it names opens. Each reads only the address,
      // as on the Svelte page: read together with what is open, the two would fight over a click.
      effect(() => {
        const url = route.url();
        untracked(() => route.applySession(url));
      });
      effect(() => {
        const url = route.url();
        untracked(() => route.applyAttachment(url));
      });
      // An overlay that names a session or a Bot waits for the snapshot to know it.
      effect(() => {
        const url = route.url();
        void runtime.snapshot.sessions;
        void runtime.snapshot.bots;
        void runtime.connection;
        void runtime.snapshot.settings.workspace_path;
        untracked(() => route.applyOverlay(url));
      });
      // What is open moved: the address follows.
      effect(() => {
        const wanted = viewOf(runtime);
        untracked(() => route.write(wanted));
      });
    },
  };
}
