import type { Waiting } from "../../m/chat/waiting";

export type HiddenWaiting = { items: Waiting[]; above: boolean };

/** Where a card sits in the transcript's viewport (y of its top and bottom), or null while the history window has not drawn it. */
export type CardBox = { top: number; bottom: number } | null;

/**
 * The waiting cards out of sight, and on which side of the view the first of them is
 * (`WaitingJump.svelte`'s `measure`): a card with less than 24pt of itself in the view counts as
 * out; one the history window has not drawn yet counts as above. The transcript's owner measures
 * the cards (NSH has no DOM to query) and hands the boxes here.
 */
export function hiddenWaiting(waiting: readonly Waiting[], box: (id: string) => CardBox, view: { top: number; bottom: number }): HiddenWaiting {
  const items: Waiting[] = [];
  let above = false;
  for (const item of waiting) {
    const at = box(item.id);
    const isAbove = !at || at.bottom < view.top + 24;
    const isBelow = at ? at.top > view.bottom - 24 : false;
    if (isAbove || isBelow) {
      if (items.length === 0) above = isAbove;
      items.push(item);
    }
  }
  return { items, above };
}
