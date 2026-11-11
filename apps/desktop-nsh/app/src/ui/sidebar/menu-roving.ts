/**
 * Arrow keys, Home and End in a floating menu (`menu-roving.ts` of the messenger): the focus moves
 * through the items and wraps at both ends; Tab closes. The items register by key, in the order
 * `keys()` lists them; the keys are the menu's only while it is `open`.
 */
import { effect, keymap, type ViewRef } from "nsh";

export function rovingMenu(opts: { open: () => boolean; keys: () => string[]; onTab: () => void }) {
  const refs = new Map<string, ViewRef>();
  let focused: string | null = null;

  function items(): ViewRef[] {
    return opts.keys().flatMap((key) => {
      const node = refs.get(key);
      return node ? [node] : [];
    });
  }

  function move(to: (index: number, count: number) => number): void {
    const keys = opts.keys().filter((key) => refs.has(key));
    if (keys.length === 0) return;
    const at = focused ? keys.indexOf(focused) : -1;
    refs.get(keys[((to(at, keys.length) % keys.length) + keys.length) % keys.length]!)?.focus();
  }

  effect(() => {
    if (!opts.open()) return;
    const off = [
      keymap.bind("down", () => move((i) => i + 1), { when: "always", repeat: true }),
      keymap.bind("up", () => move((i, n) => (i < 0 ? n - 1 : i - 1)), { when: "always", repeat: true }),
      keymap.bind("home", () => move(() => 0), { when: "always" }),
      keymap.bind("end", () => move((_, n) => n - 1), { when: "always" }),
      keymap.bind("tab", () => opts.onTab(), { when: "always" }),
    ];
    return () => off.forEach((f) => f());
  });

  return {
    /** The `ref` of the item `key`. */
    ref: (key: string) => (node: ViewRef) => {
      refs.set(key, node);
    },
    /** The item `key` took the focus (its `onFocus`). */
    focused: (key: string) => {
      focused = key;
    },
    blurred: (key: string) => {
      if (focused === key) focused = null;
    },
    /** Focuses the first item, or the last. */
    focusEdge: (last: boolean) => {
      const list = items();
      (last ? list[list.length - 1] : list[0])?.focus();
    },
  };
}
