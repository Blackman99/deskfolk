import { expect, test } from "bun:test";
import { armBackFloor } from "./back-floor.ts";

/** A browser's session history: entries, where the page is, and Back as a popstate. */
function fakeWindow(first: Record<string, unknown> = { "sveltekit:history": 7 }) {
  const entries: Array<Record<string, unknown> | null> = [{ page: "before the app" }, first];
  let at = 1;
  let left = false;
  const listeners: Array<(event: PopStateEvent) => void> = [];
  const history = {
    get state() { return entries[at]; },
    get length() { return entries.length; },
    replaceState(state: Record<string, unknown>) { entries[at] = state; },
    pushState(state: Record<string, unknown>) { entries.splice(at + 1); entries.push(state); at = entries.length - 1; },
    back() {
      if (at === 0) return;
      at -= 1;
      if (at === 0) { left = true; return; }
      for (const listener of listeners) listener({ state: entries[at] } as PopStateEvent);
    },
  };
  const win = {
    history: history as unknown as History,
    addEventListener: (_: string, listener: (event: PopStateEvent) => void) => listeners.push(listener),
    removeEventListener: (_: string, listener: (event: PopStateEvent) => void) => listeners.splice(listeners.indexOf(listener), 1),
  };
  return { win: win as unknown as Window, history, entries, at: () => at, left: () => left, listeners };
}

test("the first page gets a floor under it, with SvelteKit's own state kept", () => {
  const w = fakeWindow();
  armBackFloor(() => false, w.win);
  expect(w.entries.slice(1)).toEqual([{ "sveltekit:history": 7, deskfolkFloor: true }, { "sveltekit:history": 7, deskfolkFloor: false }]);
  expect(w.at()).toBe(2);
});

test("Back onto the floor closes what is open and goes up again; with nothing open it leaves", () => {
  const w = fakeWindow();
  let open = 2;
  armBackFloor(() => (open > 0 ? (open--, true) : false), w.win);
  w.history.back();
  // Something closed: the page is back over a fresh floor, so the next Back lands here again.
  expect([open, w.at(), w.entries.length]).toEqual([1, 2, 3]);
  w.history.back();
  expect([open, w.at(), w.left()]).toEqual([0, 2, false]);
  w.history.back();
  expect(w.left()).toBe(true);
});

test("a reload of an armed page lays no second floor, and disarming stops listening", () => {
  const w = fakeWindow();
  const disarm = armBackFloor(() => true, w.win);
  armBackFloor(() => true, w.win);
  expect(w.entries).toHaveLength(3);
  disarm();
  expect(w.listeners).toHaveLength(1);
});

test("a step back within the app's own entries is not the floor's", () => {
  const w = fakeWindow();
  let asked = 0;
  armBackFloor(() => (asked++, true), w.win);
  w.history.pushState({ "sveltekit:history": 8 });
  w.history.back();
  expect(asked).toBe(0);
});
