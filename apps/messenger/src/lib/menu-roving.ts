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
