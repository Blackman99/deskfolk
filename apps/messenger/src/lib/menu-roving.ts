/**
 * Arrow keys, Home and End in a menu: the focus moves through its items and wraps at both ends.
 * Any other key is left to the caller. The items are read only once one of those four keys has
 * been taken from the page (`preventDefault`), and an empty menu just keeps the keystroke.
 */
export function roveFocus(e: KeyboardEvent, itemsOf: () => HTMLElement[]): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const items = itemsOf();
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? index + 1 : index - 1;
  items[(next + items.length) % items.length]?.focus();
}

/**
 * ArrowDown and ArrowUp in a menu that handles its other keys itself (`list` is what can take
 * focus). Unlike `roveFocus` it also stops the keystroke reaching the shell, and ArrowUp with
 * nothing focused lands on the last item rather than wrapping from before the first.
 */
export function roveArrows(e: KeyboardEvent, list: HTMLElement[]): void {
  e.preventDefault();
  e.stopPropagation();
  if (list.length === 0) return;
  const index = list.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : -1;
  const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
  list[next]!.focus();
}
