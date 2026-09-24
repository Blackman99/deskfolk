/**
 * Pictures enlarged over the whole app right now, newest last.
 *
 * An enlargement is in no URL and sits over every screen, wherever it was opened from — a
 * conversation, a preview, a workbench pane. So the phone's Back closes it before anything
 * else, instead of walking history out from under it: the `image` layer in mobile-route.ts.
 * Escape needs none of this; the enlargement listens for that key itself.
 */
const closers: Array<() => void> = [];

/** While a picture is enlarged, Back runs `close`. The returned function takes it off again. */
export function holdBack(close: () => void): () => void {
  closers.push(close);
  return () => {
    const at = closers.lastIndexOf(close);
    if (at >= 0) closers.splice(at, 1);
  };
}

export function imageEnlarged(): boolean {
  return closers.length > 0;
}

/** Back, answered by the newest enlargement. False when none is up. */
export function closeEnlargedImage(): boolean {
  const close = closers[closers.length - 1];
  if (!close) return false;
  close();
  return true;
}
