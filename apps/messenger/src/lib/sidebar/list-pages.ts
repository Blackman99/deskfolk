/**
 * The phone's pages that open in place of the conversation list — usage and the archived
 * conversations — newest last.
 *
 * They are in no URL: each lies over the list it was opened from. So the phone's Back closes it
 * before walking history, which would otherwise step through the entries under it while it stays
 * on screen — the `list-page` layer in mobile-route.ts.
 */
const closers: Array<() => void> = [];

/** While a page is over the list, Back runs `close`. The returned function takes it off again. */
export function holdListPage(close: () => void): () => void {
  closers.push(close);
  return () => {
    const at = closers.lastIndexOf(close);
    if (at >= 0) closers.splice(at, 1);
  };
}

export function listPageOpen(): boolean {
  return closers.length > 0;
}

/** Back, answered by the newest page. False when none is open. */
export function closeListPage(): boolean {
  const close = closers[closers.length - 1];
  if (!close) return false;
  close();
  return true;
}
