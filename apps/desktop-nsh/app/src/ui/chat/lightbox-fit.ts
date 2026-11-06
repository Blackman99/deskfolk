/**
 * The enlargement's own geometry (`MessageImageLightbox.svelte`'s `measure` and `stageBox`): where
 * the picture sits once its shape is known, and the box that holds the spinner until it is.
 * Pure: the zoom maths themselves are `src/m/chat/image-zoom.ts`.
 */
import type { ViewRef } from "nsh";
import type { ImageOrigin } from "../../m/chat/enlarged-images.ts";

export type { ImageOrigin };

/** Room kept under the picture for the offer of the original, above the caption. */
export const OFFER_RESERVE = 44;
const MARGIN_X = 48;
const MARGIN_Y = 96;

/** The picture's box: as large as the stage allows (minus margins and the offer's room), centred. */
export function fitPicture(stage: ImageOrigin, natural: { width: number; height: number }, reserve: number): ImageOrigin {
  const maxW = Math.max(1, stage.width - MARGIN_X);
  const maxH = Math.max(1, stage.height - MARGIN_Y - reserve);
  const ratio = natural.width / natural.height;
  let width = maxW;
  let height = width / ratio;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }
  return {
    top: stage.top + (stage.height - reserve - height) / 2,
    left: stage.left + (stage.width - width) / 2,
    width,
    height,
  };
}

/** A large centred box to hold the spinner until the picture's own size is known. */
export function placeholderBox(stage: ImageOrigin): ImageOrigin {
  const width = Math.max(1, Math.min(960, stage.width - MARGIN_X));
  const height = Math.max(1, Math.min(stage.height * 0.8, stage.height - MARGIN_Y));
  return {
    top: stage.top + (stage.height - height) / 2,
    left: stage.left + (stage.width - width) / 2,
    width,
    height,
  };
}

/** Whether a box is large enough to carry the progress's words, not just its ring (the frame's container query). */
export function roomForCopy(box: ImageOrigin | null): boolean {
  return Boolean(box && box.width >= 148 && box.height >= 96);
}

/**
 * Where a picture on screen is, in the window, for the enlargement to grow out of
 * (`pictureOrigin` of `enlarged-images.ts`, which reads a DOM element). Null when it is not laid
 * out or is smaller than two points.
 */
export async function originOf(node: ViewRef | null | undefined): Promise<ImageOrigin | null> {
  const found = await node?.measure();
  if (!found) return null;
  const { width, height } = found.bounds.size;
  if (width < 2 || height < 2) return null;
  return { top: found.pagePosition.y, left: found.pagePosition.x, width, height };
}
