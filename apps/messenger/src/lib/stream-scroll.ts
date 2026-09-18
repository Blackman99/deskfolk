/** Distance from the bottom at which the transcript is still considered "at latest". */
export const STREAM_NEAR_BOTTOM_PX = 120;

export function distanceFromBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return scrollHeight - scrollTop - clientHeight;
}

export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx: number = STREAM_NEAR_BOTTOM_PX,
): boolean {
  return distanceFromBottom(scrollHeight, scrollTop, clientHeight) <= thresholdPx;
}

export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Programmatic pins ignore the matching scroll event; a user leaving the
 * bottom always unsticks — except while an animated jump-to-bottom is in
 * flight, when intermediate frames are still far from the end.
 */
export function stickAfterScroll(
  ignoreProgrammatic: boolean,
  near: boolean,
  jumping = false,
): {
  ignore: boolean;
  stick: boolean;
} {
  if (jumping) return { ignore: true, stick: true };
  if (ignoreProgrammatic && near) return { ignore: true, stick: true };
  return { ignore: false, stick: near };
}
