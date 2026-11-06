import type { ViewRef } from "nsh";
import type { ImageOrigin } from "./lightbox-fit";

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
