/**
 * Which slice of a long list is worth putting in the DOM. A session that ran for a week holds
 * hundreds of turns; rendering them all costs layout on every open and every scroll, so the log
 * keeps only what is on screen (plus a margin) and pads the rest out with empty space.
 */

/** Height assumed for a row nobody has measured yet: one two-line row plus the gap under it. */
export const ROUTE_ROW_ESTIMATE_PX = 80;

/** Rows kept above and below the viewport, so a flick does not land on a blank patch. */
export const ROUTE_ROW_OVERSCAN = 6;

export type ListWindow = {
  /** First index in the DOM. */
  start: number;
  /** One past the last index in the DOM. */
  end: number;
  /** Empty space standing in for the rows before `start`. */
  padTop: number;
  /** Empty space standing in for the rows after `end`. */
  padBottom: number;
  /** Height of the whole list, measured rows included. */
  total: number;
};

export type ListWindowInput = {
  count: number;
  scrollTop: number;
  /** Height of the scrolling box; 0 before it has been laid out. */
  viewportHeight: number;
  /** Measured pitch per index (row box + the gap under it); a hole means not measured yet. */
  heights: readonly number[];
  estimate?: number;
  overscan?: number;
};

export function listWindow({
  count,
  scrollTop,
  viewportHeight,
  heights,
  estimate = ROUTE_ROW_ESTIMATE_PX,
  overscan = ROUTE_ROW_OVERSCAN,
}: ListWindowInput): ListWindow {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 };

  const pitch = (index: number): number => {
    const measured = heights[index];
    return measured && measured > 0 ? measured : estimate;
  };

  // Before the first layout there is no viewport to measure against; paint a first slab so the
  // rows that get measured are real ones.
  const height = viewportHeight > 0 ? viewportHeight : estimate * overscan;
  const top = Math.max(0, scrollTop);
  const bottom = top + height;

  let offset = 0;
  let first = count - 1;
  let last = count;
  for (let i = 0; i < count; i += 1) {
    const next = offset + pitch(i);
    if (next > top && i < first) first = i;
    if (offset >= bottom) {
      last = i;
      break;
    }
    offset = next;
  }
  if (last > count) last = count;
  if (first > last) first = last;

  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + overscan);

  let padTop = 0;
  for (let i = 0; i < start; i += 1) padTop += pitch(i);
  let rendered = 0;
  for (let i = start; i < end; i += 1) rendered += pitch(i);
  let padBottom = 0;
  for (let i = end; i < count; i += 1) padBottom += pitch(i);

  return { start, end, padTop, padBottom, total: padTop + rendered + padBottom };
}
