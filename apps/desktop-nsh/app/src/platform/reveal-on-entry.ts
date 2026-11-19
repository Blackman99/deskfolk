/**
 * Whether a view the page's address carries, drawn over the screen it opens from (a file's preview,
 * settings, a conversation's settings), shows yet: from when the page is at the address that names
 * it (`PageRoute.afterEntry`). Until then it is drawn unseen, so the frame the browser draws before
 * NSH writes the view's history entry is still the screen under it. Chrome on Android pictures an
 * entry as the page leaves it and shows that picture under a back swipe: drawn at once, the view was
 * pictured over its own entry's under it, and the swipe back from it showed the view under itself.
 * Shown at once on the desktop, which has no address. Call it where the view mounts.
 */
import { signal } from "nsh";
import { afterEntry } from "./page-route";

export function revealOnEntry(): () => boolean {
  const shown = signal(false);
  if (!afterEntry(() => shown.set(true))) shown.set(true);
  return shown;
}
