/**
 * Focus across a step back the page takes itself (`+page.svelte`, mobile-route.ts).
 *
 * Switching to the conversation that is the history entry underneath — the other pane of a
 * split, say — is a `history.back()`, so phone Back keeps walking the same stack. SvelteKit
 * treats every popstate as a fresh page: it blurs whatever has focus, focuses the body, and a
 * moment later clears the selection. The click that switched panes had just put the caret in
 * that pane's composer, so every other switch left you typing into nothing (2026-10-23). The
 * `goto` beside it keeps focus; this gives the same step back what it had, caret and all.
 *
 * Not on a touch screen. There a step back the page takes itself closes a screen — the
 * conversation sliding away to the list, a page put down — and the field still sliding out
 * would bring the soft keyboard back up over the screen underneath. Panes are a desktop thing.
 */
export interface KeptFocus {
  /** Before the step: remember what has focus, and the caret if it is inside it. */
  hold(): void;
  /** After it: put them back, unless something else took focus meanwhile. */
  restore(): void;
  /** Some other navigation: nothing to put back. */
  drop(): void;
}

export function keptFocus(
  doc: Document = document,
  later: (run: () => void) => void = (run) => setTimeout(run, 0),
  touch: () => boolean = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
): KeptFocus {
  let held: { el: HTMLElement; caret: Range | null } | null = null;
  return {
    hold() {
      const el = doc.activeElement;
      if (!(el instanceof HTMLElement) || el === doc.body || touch()) {
        held = null;
        return;
      }
      // A text field keeps its own selection; a contenteditable's caret lives in the document's.
      const selection = doc.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      held = { el, caret: range && el.contains(range.startContainer) ? range.cloneRange() : null };
    },
    restore() {
      const kept = held;
      held = null;
      if (!kept) return;
      // After SvelteKit's own timer, which clears a selection the navigation did not change.
      later(() => {
        const { el, caret } = kept;
        const active = doc.activeElement;
        if (!el.isConnected || (active && active !== doc.body)) return;
        el.focus({ preventScroll: true });
        if (caret && el.contains(caret.startContainer)) {
          const selection = doc.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(caret);
        }
      });
    },
    drop() {
      held = null;
    },
  };
}
