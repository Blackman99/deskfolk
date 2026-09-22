/**
 * How much of a long transcript is mounted at once.
 *
 * Every bubble is a DOM subtree that costs on mount and again on every update — and the stage
 * updates several times a second while a Bot is talking. A conversation that has been going for
 * months would pay that price for messages nobody is looking at, so only the tail is rendered
 * and the window grows when the person actually scrolls back into it.
 */
export const HISTORY_WINDOW_INITIAL = 60;
export const HISTORY_WINDOW_STEP = 40;

/** The newest `count` items; the whole list when it is shorter than that. */
export function windowedItems<T>(items: readonly T[], count: number): readonly T[] {
  if (count >= items.length) return items;
  return items.slice(items.length - Math.max(0, count));
}

/**
 * A window wide enough to include the item at `index`, with a little room above it so the jump
 * does not land against the top edge. A search hit deep in the history has to be mounted before
 * it can be scrolled to.
 */
export function windowForIndex(total: number, index: number, current: number, margin = 10): number {
  if (index < 0) return current;
  return Math.max(current, total - index + margin);
}
