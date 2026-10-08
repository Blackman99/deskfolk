/**
 * What a context menu portalled to `document.body` shares: focus goes to its first item, and it
 * closes on a press outside it, a scroll outside it, a window resize and the window losing focus.
 * Returns the cleanup an `$effect` hands back. Escape and the arrow keys stay with each menu.
 *
 * `first` picks the item that takes the focus (the first `menuitem` by default). `anchor` reads
 * the button the menu hangs from: a press on it is not outside, since the button closes the menu
 * itself.
 */
export function dismissOnOutside(
  menu: HTMLElement,
  close: () => void,
  options: { first?: () => HTMLElement | undefined; anchor?: () => Node | null | undefined } = {}
): () => void {
  queueMicrotask(() =>
    (options.first ? options.first() : menu.querySelector<HTMLElement>('[role="menuitem"]'))?.focus({
      preventScroll: true,
    })
  );
  const onDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !options.anchor?.()?.contains(target)) close();
  };
  const onScroll = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const dismiss = () => close();
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  return () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
  };
}
