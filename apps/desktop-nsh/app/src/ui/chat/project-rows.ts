/**
 * A project session's rows (pure; `ProjectChat.tsx` uses it): the questions one call asked are one
 * row, and those the run waits on are asked at its end instead of among the lines.
 *
 * The rows keep their objects while they show the same, as a Bot's stage keeps its rows
 * (`stage-rows.ts`). The rows are made anew whenever the snapshot's lines change, a line in any other conversation included, and while an agent works its
 * run changes many times a second. Handed to NSH's `List` as new objects, and many times over for
 * one change, they made it measure every row again on the phone's page: the transcript's height
 * fell to its estimates and came back within a frame, and the browser, which cannot scroll above
 * the top, kept only part of the way there and back. A reader scrolled up was moved towards the
 * newest line, often all the way down.
 */
import type { Message } from "@real-bot/protocol";
import { isDifferentDay } from "../../m/chat/chat-view.ts";
import type { ProjectRow } from "./project-chat-lines";

/** One call's questions are written within a moment of each other; two calls are an answer apart. */
const ASKED_TOGETHER_MS = 1000;

function askedTogether(a: Message, b: Message): boolean {
  if (a.kind !== "ask" || b.kind !== "ask") return false;
  const gap = Date.parse(b.created_at) - Date.parse(a.created_at);
  return Number.isFinite(gap) && gap >= 0 && gap <= ASKED_TOGETHER_MS;
}

/**
 * The lines the transcript shows (oldest first, each a group: a line alone, or the questions one
 * call asked together), and the questions the run waits on. Those are asked at the end, under what
 * the agent said before them (`ProjectWorking`), with the rest of their call: they leave the lines
 * until the run waits on none of them, and come back as one card.
 */
export function splitAsks(lines: readonly Message[], awaits: (id: string) => boolean): { shown: Message[][]; open: Message[] } {
  const groups: Message[][] = [];
  for (const message of lines) {
    const last = groups.at(-1);
    if (last && askedTogether(last.at(-1)!, message)) last.push(message);
    else groups.push([message]);
  }
  const shown: Message[][] = [];
  const open: Message[] = [];
  for (const group of groups) {
    if (group[0]!.kind === "ask" && group.some((message) => awaits(message.id))) open.push(...group);
    else shown.push(group);
  }
  return { shown, open };
}

/** A row for each group of lines shown, with the day above the first of each day and a "New" mark on the first unread line. */
export function lineRows(shown: readonly Message[][], newMarkId: string | null = null): ProjectRow[] {
  return shown.map((group, index): ProjectRow => {
    const first = group[0]!;
    const previous = index > 0 ? shown[index - 1]!.at(-1)! : null;
    const date = !previous || isDifferentDay(previous.created_at, first.created_at) ? first.created_at : null;
    const fresh = newMarkId !== null && group.some((message) => message.id === newMarkId);
    return group.length > 1 ? { id: `asks:${first.id}`, kind: "asks", messages: group, date, fresh } : { id: first.id, kind: "line", message: first, date, fresh };
  });
}

/** The same messages, object for object. */
export function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
  return a.length === b.length && a.every((message, index) => message === b[index]);
}

/** Hands back each row's previous object while it shows the same: the same line or questions (by identity, or fetched again and saying the same), the same day line. */
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

const sameMessage = (a: Message, b: Message) => a === b || JSON.stringify(a) === JSON.stringify(b);

function sameRow(a: ProjectRow, b: ProjectRow): boolean {
  if (a.kind === "line" && b.kind === "line") return a.date === b.date && Boolean(a.fresh) === Boolean(b.fresh) && sameMessage(a.message, b.message);
  if (a.kind === "asks" && b.kind === "asks") return a.date === b.date && Boolean(a.fresh) === Boolean(b.fresh) && a.messages.length === b.messages.length && a.messages.every((message, index) => sameMessage(message, b.messages[index]!));
  return a.kind === b.kind && a.kind !== "line" && a.kind !== "asks";
}

/** The same rows, object for object: what the transcript's list is handed changes only when a row does. */
export function sameRows(a: readonly ProjectRow[], b: readonly ProjectRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}
