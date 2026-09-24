import type { Bot, Routine, SearchHit, SessionSummary } from "@real-bot/protocol";
import { searchJump } from "../sidebar/search-jump.ts";

export function canOpenSearchHit(hit: SearchHit, sessions: readonly SessionSummary[], routines: readonly Routine[], bots: readonly Bot[]): boolean {
  if (hit.kind === "file") return Boolean(hit.path);
  const jump = searchJump(hit, sessions, routines, bots);
  if (!jump) return false;
  return "routineId" in jump || sessions.some((session) => session.id === jump.sessionId);
}

/** Wrap through available results while keeping unavailable historical rows readable. */
export function nextSearchIndex(available: readonly boolean[], current: number, direction: 1 | -1): number {
  if (!available.some(Boolean)) return -1;
  let at = current < 0 ? (direction === 1 ? -1 : 0) : current;
  for (let step = 0; step < available.length; step++) {
    at = (at + direction + available.length) % available.length;
    if (available[at]) return at;
  }
  return -1;
}
