/**
 * A project session's rows keep their objects while they show the same (pure; `ProjectChat.tsx`
 * uses it), as a Bot's stage keeps its rows (`stage-rows.ts`). The rows are made anew whenever the
 * snapshot's lines change, a line in any other conversation included, and while an agent works its
 * run changes many times a second. Handed to NSH's `List` as new objects, and many times over for
 * one change, they made it measure every row again on the phone's page: the transcript's height
 * fell to its estimates and came back within a frame, and the browser, which cannot scroll above
 * the top, kept only part of the way there and back. A reader scrolled up was moved towards the
 * newest line, often all the way down.
 */
import type { ProjectRow } from "./project-chat-lines";

/** Hands back each row's previous object while it shows the same: the same line (by identity, or one fetched again that says the same), the same day line. */
export function createProjectRowKeeper(): (rows: readonly ProjectRow[]) => ProjectRow[] {
  let kept = new Map<string, ProjectRow>();
  return (rows) => {
    const next = new Map<string, ProjectRow>();
    const out = rows.map((row) => {
      const before = kept.get(row.id);
      const keep = before && sameRow(before, row) ? before : row;
      next.set(row.id, keep);
      return keep;
    });
    kept = next;
    return out;
  };
}

function sameRow(a: ProjectRow, b: ProjectRow): boolean {
  if (a.kind !== "line" || b.kind !== "line") return a.kind === b.kind;
  return a.date === b.date && (a.message === b.message || JSON.stringify(a.message) === JSON.stringify(b.message));
}

/** The same rows, object for object: what the transcript's list is handed changes only when a row does. */
export function sameRows(a: readonly ProjectRow[], b: readonly ProjectRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}
