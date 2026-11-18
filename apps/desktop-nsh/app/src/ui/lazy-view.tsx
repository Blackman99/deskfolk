/**
 * A view whose code loads the first time one is shown, so the phone's page starts without it.
 *
 * NSH's web package links into the engine every page downloads first only what the app's entry
 * uses; each later chunk (an `import()`) brings the parts of `nsh/base` it draws with as side
 * modules, fetched before the chunk runs (`chunkSides`). The whole app was one such chunk
 * (`Main.js`), so the rich editor, the code editor, `TextView`, the data table, the date pickers,
 * the tree and the terminal all came before the first screen. A module that draws with one of them
 * is behind a `lazyView` now: the module of the old name keeps its exports, and its view is this
 * wrapper around an `import()` of the real one.
 *
 * Until the chunk is there the wrapper draws nothing (or `pending`, a stand-in of the same size); it
 * then makes the real view once, with the same props object, so every prop stays live. A load that
 * fails (a phone between networks) is tried again a few times, a little later each time, and on
 * the next mount after that.
 *
 * `preloadLazyViews()` (`Main.tsx`, once the shell is up) fetches those made with `preload: true`, so
 * the first conversation opened does not wait for the composer; the rest load when first shown.
 */
import { signal, untracked, type JSX } from "nsh";

type View<P> = (props: P) => JSX.Element;
type Lazy<P> = View<P> & { preload(): Promise<void> };

const early: Array<() => Promise<void>> = [];
const RETRY_MS = [500, 2000, 8000];

export function lazyView<P>(load: () => Promise<View<P>>, options: { pending?: View<P>; preload?: boolean } = {}): Lazy<P> {
  let view: View<P> | null = null;
  const loaded = signal(false);
  let loading: Promise<void> | null = null;
  const attempt = (tries: number): Promise<void> =>
    load().then(
      (real) => {
        view = real;
        loaded.set(true);
      },
      (error: unknown) => {
        if (tries >= RETRY_MS.length) {
          loading = null;
          throw error;
        }
        return new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS[tries])).then(() => attempt(tries + 1));
      },
    );
  const preload = () => (loading ??= attempt(0));
  const Lazy = (props: P): JSX.Element => {
    if (view) {
      const real = view;
      return untracked(() => real(props));
    }
    void preload().catch((error: unknown) => console.error("a view's code could not be loaded", error));
    return (
      <If when={loaded()} else={options.pending ? untracked(() => options.pending!(props)) : undefined}>
        {() => untracked(() => view!(props))}
      </If>
    );
  };
  if (options.preload) early.push(() => preload().catch(() => {}));
  return Object.assign(Lazy, { preload });
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
