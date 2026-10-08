/** Small pieces several parts of a turn's context share: names, duties, clipping, limits. */
import type { Store } from "../store";
import { takeCodePoints } from "../text";

/**
 * How much of a job's opening request the situation block quotes. The line itself is in the
 * transcript window on the first turn; this is for every turn after a handoff or forty lines on.
 */
export const BRIEF_LIMIT = 1200;

export const LATEST_USER_LIMIT = 200;

export function botDisplayName(store: Store, id: string): string {
  try {
    return store.getBot(id).name;
  } catch {
    return id;
  }
}

export function botDuties(store: Store, id: string): string {
  try {
    return store.getBot(id).duties;
  } catch {
    return "";
  }
}

/** How much of a plan's title a tag spends; the situation block names it in full. */
export const PLAN_TAG_TITLE_MAX = 20;

/** When a line was said, in this machine's time: 「09-28 12:02」. */
export function quoteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function oneLineClip(text: string, limit: number): string {
  const clipped = takeCodePoints(text.replace(/\s+/g, " ").trim(), limit);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}
