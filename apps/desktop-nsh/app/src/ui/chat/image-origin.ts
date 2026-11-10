import type { ViewRef } from "nsh";
import type { ImageOrigin } from "./lightbox-fit";

/**
 * A picture pressed on screen, for the enlargement (the Svelte's `pictureOrigin` and
 * `pictureStandIn`, which read both off the clicked element): `view` is the picture's own view,
 * the thumbnail inside a chip rather than the chip, so the enlargement grows out of where the
 * picture sits; `shown` is what it shows there (a `data:` URL), so the enlargement starts from it
 * at the picture's proportions and grows at once instead of waiting for the bytes.
 */
export type PressedPicture = { view: ViewRef | null; shown: string | null };

/** Where the picture that was pressed sits in the window, for the enlargement to grow out of; null when it cannot be told (the picture opens plainly). */
export async function imageOrigin(from?: ViewRef | null): Promise<ImageOrigin | null> {
  if (!from || typeof from.measure !== "function") return null;
  try {
    const box = await from.measure();
    if (!box || box.bounds.size.width < 2 || box.bounds.size.height < 2) return null;
    return { top: box.pagePosition.y, left: box.pagePosition.x, width: box.bounds.size.width, height: box.bounds.size.height };
  } catch {
    return null;
  }
}
