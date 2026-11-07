import { expect, test } from "nsh/test";
import { lifecycle, pageLifecycle, type PageWindow } from "./lifecycle";

/** A page as the web's realm sees its parent: a document with a visibility and a focus, and the events that change them. */
function fakePage(start: { hidden: boolean; focused: boolean }) {
  const state = { ...start };
  const listeners = new Map<string, Array<() => void>>();
  const on = (type: string, listener: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const page: PageWindow = {
    document: { get visibilityState() { return state.hidden ? "hidden" : "visible"; }, hasFocus: () => state.focused, addEventListener: (type, listener) => on(`document:${type}`, listener) },
    addEventListener: on,
  };
  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { page, state, fire };
}

test("NSH's own lifecycle is used where it has one", () => {
  expect(["active", "inactive", "background"]).toContain(lifecycle());
});

test("on the web the page says how the app is in use, and follows its focus and visibility", () => {
  const { page, state, fire } = fakePage({ hidden: false, focused: true });
  const phase = pageLifecycle(page);
  expect(phase()).toBe("active");
  state.focused = false;
  fire("blur");
  expect(phase()).toBe("inactive");
  state.hidden = true;
  fire("document:visibilitychange");
  expect(phase()).toBe("background");
  state.hidden = false;
  state.focused = true;
  fire("focus");
  expect(phase()).toBe("active");
});

test("with no page to ask the app counts as in use", () => {
  expect(pageLifecycle(null)()).toBe("active");
  expect(pageLifecycle({ addEventListener() {} })()).toBe("active");
});
