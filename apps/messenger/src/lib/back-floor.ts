/**
 * A floor under the app's first page in a phone's history (`+page.svelte`, hosted build only).
 *
 * Back is caught by the app only while there is an entry of the app's behind the page: a sheet,
 * a menu or a conversation opened on the very first page — a fresh load, a link from a
 * notification — had nothing behind it, so Back left the app instead of closing what was open.
 * The floor is one entry of ours under the first page, with the same URL and the same SvelteKit
 * state, so SvelteKit takes a step onto it for a step within its own entry and ignores it. When
 * Back lands there, `onBack` closes what is open — a layer, or a screen down to the list — and
 * the page goes up again over a fresh floor; with nothing left to close, Back goes on out of the
 * app. The live entry above the floor is marked too, so a reload does not lay a second one.
 */
const FLOOR = "deskfolkFloor";

type Marked = Record<string, unknown> & { [FLOOR]?: boolean };

export function armBackFloor(onBack: () => boolean, win: Pick<Window, "history" | "addEventListener" | "removeEventListener"> = window): () => void {
  const history = win.history;
  const state = (history.state ?? {}) as Marked;
  if (state[FLOOR] === undefined) {
    history.replaceState({ ...state, [FLOOR]: true }, "");
    history.pushState({ ...state, [FLOOR]: false }, "");
  }
  const onPop = (event: PopStateEvent) => {
    const landed = (event.state ?? {}) as Marked;
    if (landed[FLOOR] !== true) return;
    if (onBack()) history.pushState({ ...landed, [FLOOR]: false }, "");
    else history.back();
  };
  win.addEventListener("popstate", onPop);
  return () => win.removeEventListener("popstate", onPop);
}
