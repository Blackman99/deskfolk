import type { ImageOrigin } from "./MessageImageLightbox.svelte";

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

/** Where on screen the picture that was clicked is, for the enlargement to grow out of. */
export function pictureOrigin(from?: HTMLElement | null): ImageOrigin | null {
  const picture =
    from?.querySelector("img, .attachment-chip-pending, .md-artifact-pending") ?? from;
  if (!(picture instanceof HTMLElement)) return null;
  const box = picture.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/**
 * The thumbnail already on screen for this picture, if any: the enlargement shows it at the
 * picture's own proportions while the real bytes come, instead of growing to a guess first.
 * The chip keeps owning the object URL; it stays mounted under the enlargement.
 */
export function pictureStandIn(from?: HTMLElement | null): string | null {
  const img = from instanceof HTMLImageElement ? from : from?.querySelector("img");
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
}
