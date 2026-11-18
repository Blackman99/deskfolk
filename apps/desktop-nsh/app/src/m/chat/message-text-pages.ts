/**
 * Messages open on a page of their own to select from (MessageTextSheet), newest last.
 *
 * The page is in no URL: it lies over the conversation it was opened from. So the phone's Back
 * closes it before walking history, which would take the conversation away with it — the
 * `message-text` layer in mobile-route.ts. Escape needs none of this; the page listens for that
 * key itself.
 */
const closers: Array<() => void> = [];

/** While a message's text is open, Back runs `close`. The returned function takes it off again. */
export function holdBack(close: () => void): () => void {
  closers.push(close);
  return () => {
    const at = closers.lastIndexOf(close);
    if (at >= 0) closers.splice(at, 1);
  };
}

export function messageTextOpen(): boolean {
  return closers.length > 0;
}

/** Back, answered by the newest page. False when none is open. */
export function closeMessageText(): boolean {
  const close = closers[closers.length - 1];
  if (!close) return false;
  close();
  return true;
}
