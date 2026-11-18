/**
 * A view whose code loads the first time one is shown, so the phone's page starts without it.
 *
 * NSH's web package links into the engine every page downloads first only what the app's entry
 * uses; each later chunk (an `import()`) brings the parts of `nsh/base` it draws with as side
 * modules, fetched before the chunk runs (`chunkSides`). The whole app was one such chunk
 * (`Main.js`), so the rich editor, the code editor, `TextView`, the data table, the date pickers,
 * the tree and the terminal all came before the first screen. A module that draws with one of them
 * is behind a `lazyView` now (`lazy-views.ts`), and its view is this wrapper around an `import()` of
 * the real one.
 *
 * Until the chunk is there the wrapper draws nothing (or `pending`, a stand-in of the same size); it
 * then makes the real view once, with the same props object, so every prop stays live.
 *
 * A chunk that fails to load (a phone between networks) is not asked for again: the browser keeps
 * a failed `import()` of a URL, so importing it again fails at once without a request (measured
 * 2026-11-18: three retries, no second request). Where the view would be, the wrapper says so with
 * a button: on the web it reloads the page, which keeps the address and the device and fetches the
 * chunk anew; on the desktops, where a chunk is a file of the app, it tries again.
 *
 * `preloadLazyViews()` (`Main.tsx`, once the shell is up) fetches those made with `preload: true`, so
 * the first conversation opened does not wait for the composer; the rest load when first shown.
 */
import { platform, signal, Text, untracked, View, type JSX } from "nsh";
import { reloadPage } from "../platform/page-build";
import { copy } from "../runtime";
import { Button } from "./Button";

type ViewOf<P> = (props: P) => JSX.Element;
type Lazy<P> = ViewOf<P> & { preload(): Promise<void> };

const early: Array<() => Promise<void>> = [];

export function lazyView<P>(load: () => Promise<ViewOf<P>>, options: { pending?: ViewOf<P>; preload?: boolean } = {}): Lazy<P> {
  let view: ViewOf<P> | null = null;
  const loaded = signal(false);
  const failed = signal(false);
  let loading: Promise<void> | null = null;
  const preload = () =>
    (loading ??= load().then(
      (real) => {
        view = real;
        loaded.set(true);
      },
      (error: unknown) => {
        loading = null;
        failed.set(true);
        console.error("a view's code could not be loaded", error);
        throw error;
      },
    ));
  const retry = () => {
    if (platform.os === "web") {
      reloadPage();
      return;
    }
    failed.set(false);
    void preload().catch(() => {});
  };
  const Lazy = (props: P): JSX.Element => {
    if (view) {
      const real = view;
      return untracked(() => real(props));
    }
    void preload().catch(() => {});
    return (
      <If when={loaded()} else={<If when={failed()} else={options.pending ? untracked(() => options.pending!(props)) : undefined}><LoadFailed onRetry={retry} /></If>}>
        {() => untracked(() => view!(props))}
      </If>
    );
  };
  if (options.preload) early.push(() => preload().catch(() => {}));
  return Object.assign(Lazy, { preload });
}

/** Where a view would be when its code did not load: what happened, and the way to fetch it again. */
function LoadFailed(props: { onRetry: () => void }) {
  return (
    <View testID="lazy-view-failed" class="flex-row flex-wrap items-center gap-2 px-3 py-2">
      <Text class="text-[13px] text-ink-muted">{copy().common.viewLoadFailed}</Text>
      <Button testID="lazy-view-retry" size="sm" variant="secondary" onPress={props.onRetry}>
        {platform.os === "web" ? copy().common.viewLoadReload : copy().common.viewLoadRetry}
      </Button>
    </View>
  );
}

/**
 * Fetches the views made with `preload: true`, the ones the first conversation opened needs (the
 * composer, a message's text), one after another so they do not crowd what the screen asks for.
 * The others (the code editor, a spreadsheet, the date pickers, the terminal…) load when first
 * shown: a phone that never opens one never downloads it.
 */
export async function preloadLazyViews(): Promise<void> {
  for (const preload of early) await preload();
}
