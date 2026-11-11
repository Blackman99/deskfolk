/**
 * The video's box in the media annotator, as the Svelte's `max-height: 100%` + `flex: 0 1 auto` gave
 * it: the picture at its own shape across the pane's width, and when that is taller than the pane
 * leaves after the timeline and the buttons, smaller (centred) down to a usable minimum, below which
 * the pane scrolls. NSH's video has no size of its own to lay out by, so it is worked out here from
 * the size its load reports.
 */
export const VIDEO_MIN_HEIGHT = 96;

export type Size = { width: number; height: number };

/** Null while the video's own size is not known (before it loads, or a stream with no picture). */
export function videoBox(natural: Size | null, room: Size, below: number, gap: number, min = VIDEO_MIN_HEIGHT): Size | null {
  if (!natural || !(natural.width > 0) || !(natural.height > 0) || !(room.width > 0)) return null;
  const aspect = natural.width / natural.height;
  const roomLeft = room.height - below - (below > 0 ? gap : 0);
  const height = Math.min(room.width / aspect, Math.max(min, roomLeft));
  return { width: Math.min(room.width, height * aspect), height };
}
