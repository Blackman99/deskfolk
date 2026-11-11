/**
 * The rows of the session list, flattened (pure). The Svelte list was a column of sections; a
 * virtualised `List` wants one array, so each header, session, directory and empty note is a row of
 * its own, with a key that stays with it when the list changes under it.
 */
import type { SessionSummary } from "@real-bot/protocol";
import type { ProjectDirGroup } from "../../m/sidebar/project-groups";

export type ListRow =
  /** A section's heading; `add` is the + of the section (a desktop's only). */
  | { kind: "ghead"; key: string; title: string; add?: "bots" | "projects"; first: boolean }
  | { kind: "archived-ghead"; key: string; first: true }
  | { kind: "archived-empty"; key: string }
  | { kind: "session"; key: string; session: SessionSummary; variant: "archived" | "file-drop" | "bot"; first: boolean }
  | { kind: "dir"; key: string; group: ProjectDirGroup; open: boolean; live: boolean }
  | { kind: "project"; key: string; session: SessionSummary; dir: string }
  | { kind: "hint"; key: string; text: string }
  | { kind: "roster-empty"; key: string }
  | { kind: "projects-empty"; key: string };

export type ListInput = {
  /** The archived list is showing instead of the sections. */
  viewingArchived: boolean;
  /** A phone heads the archived list with its own bar and the sections' + is the floating button. */
  phone: boolean;
  archived: readonly SessionSummary[];
  fileDrop: SessionSummary | null;
  showBots: boolean;
  showProjects: boolean;
  botRows: readonly SessionSummary[];
  projectGroups: readonly ProjectDirGroup[];
  /** Null while the list is unfiltered. */
  filtered: boolean;
  isOpen: (dir: string) => boolean;
  isLive: (group: ProjectDirGroup) => boolean;
  renamingSessionId: string | null;
  nothingWorking: boolean;
  rosterEmpty: boolean;
  projectsEmpty: boolean;
  labels: { fileDrop: string; bots: string; projects: string; workingEmpty: string };
  /** `pinnedWorking ? workingEmptyPinned : workingEmpty`. */
  workingHint: string;
};

export function listRows(input: ListInput): ListRow[] {
  const rows: ListRow[] = [];
  const first = () => rows.length === 0;

  if (input.viewingArchived) {
    if (!input.phone) rows.push({ kind: "archived-ghead", key: "archived-ghead", first: true });
    if (input.archived.length === 0) rows.push({ kind: "archived-empty", key: "archived-empty" });
    for (const session of input.archived) rows.push({ kind: "session", key: `archived:${session.id}`, session, variant: "archived", first: false });
    return rows;
  }

  if (input.fileDrop) {
    rows.push({ kind: "ghead", key: "ghead:file-drop", title: input.labels.fileDrop, first: first() });
    rows.push({ kind: "session", key: `file-drop:${input.fileDrop.id}`, session: input.fileDrop, variant: "file-drop", first: false });
  }
  if (input.showBots && (!input.filtered || input.botRows.length > 0)) {
    rows.push({ kind: "ghead", key: "ghead:bots", title: input.labels.bots, add: input.phone ? undefined : "bots", first: first() });
  }
  for (const session of input.botRows) rows.push({ kind: "session", key: `bot:${session.id}`, session, variant: "bot", first: false });

  if (input.showProjects && (!input.filtered || input.projectGroups.length > 0)) {
    rows.push({ kind: "ghead", key: "ghead:projects", title: input.labels.projects, add: input.phone ? undefined : "projects", first: first() });
  }
  for (const group of input.projectGroups) {
    const open = input.isOpen(group.dir);
    rows.push({ kind: "dir", key: `dir:${group.dir}`, group, open, live: !open && input.isLive(group) });
    // A session being renamed stays on screen under a folded directory: its row is the name field.
    const shown = open ? group.sessions : group.sessions.filter((s) => s.id === input.renamingSessionId);
    for (const session of shown) rows.push({ kind: "project", key: `project:${session.id}`, session, dir: group.dir });
  }

  if (input.nothingWorking) rows.push({ kind: "hint", key: "hint", text: input.workingHint });
  if (input.rosterEmpty) rows.push({ kind: "roster-empty", key: "roster-empty" });
  if (input.projectsEmpty) rows.push({ kind: "projects-empty", key: "projects-empty" });
  return rows;
}

/**
 * Hands back each row's previous object while it says the same. NSH's `List` tells its items apart
 * by identity, and the rows were made anew whenever the selection or any conversation changed (each
 * streamed line updates its session): every visible row was built again, each working out its
 * status and its line anew, on every conversation switch and every update.
 */
export function createListRowKeeper(): (rows: readonly ListRow[]) => ListRow[] {
  let kept = new Map<string, ListRow>();
  return (rows) => {
    const next = new Map<string, ListRow>();
    const out = rows.map((row) => {
      const before = kept.get(row.key);
      const keep = before && sameValue(before, row, 2) ? before : row;
      next.set(row.key, keep);
      return keep;
    });
    kept = next;
    return out;
  };
}

/** The same: one object, or arrays of the same items, or (`depth` levels down) objects whose fields are. */
function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  if (depth === 0 || !a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1));
}
