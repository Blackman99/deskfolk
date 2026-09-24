/**
 * A right-click on a picture the app drew itself. Avatars and icons are not pictures: only an
 * `img` marked `data-copy-image` counts, and only while it has pixels and an address to read.
 */
export function copyableImageAt(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest("img[data-copy-image]");
  if (!(image instanceof HTMLImageElement)) return null;
  if (!image.currentSrc || image.naturalWidth === 0) return null;
  return image;
}
