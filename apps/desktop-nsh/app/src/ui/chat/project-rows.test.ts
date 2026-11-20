/** A project session's rows keep their objects while they show the same (the list measures a new one again). */
import { expect, test } from "nsh/test";
import type { Message } from "@real-bot/protocol";
import type { ProjectRow } from "./project-chat-lines";
import { createProjectRowKeeper, lineRows, sameRows, splitAsks } from "./project-rows";

const message = (id: string, body: string): Message => ({ id, body, kind: "bot", author: "claude-code", created_at: "2026-11-18T00:00:00Z" }) as unknown as Message;
const line = (m: Message, date: string | null = null): ProjectRow => ({ id: m.id, kind: "line", message: m, date });
const ask = (id: string, at: string): Message => ({ id, body: id, kind: "ask", author: "claude-code", created_at: at }) as unknown as Message;
const said = (id: string, at: string): Message => ({ id, body: id, kind: "bot", author: "claude-code", created_at: at }) as unknown as Message;
const ids = (groups: Message[][]) => groups.map((group) => group.map((m) => m.id).join("+"));

test("rows made again from the same lines are the same objects, and so is the list", () => {
  const keep = createProjectRowKeeper();
  const a = message("m1", "one");
  const b = message("m2", "two");
  const first = keep([line(a, "2026-11-18T00:00:00Z"), line(b), { id: "working", kind: "working" }]);
  // A line in another conversation, or the run's progress: the rows come back as new objects.
  const again = keep([line(a, "2026-11-18T00:00:00Z"), line(b), { id: "working", kind: "working" }]);
  again.forEach((row, index) => expect(row).toBe(first[index]));
  expect(sameRows(first, again)).toBe(true);
});

test("a line fetched again that says the same keeps its row", () => {
  const keep = createProjectRowKeeper();
  const first = keep([line(message("m1", "one"))]);
  const refetched = keep([line(message("m1", "one"))]);
  expect(refetched[0]).toBe(first[0]);
});

test("only a row that changed is a new object, and a new line makes a new list", () => {
  const keep = createProjectRowKeeper();
  const a = message("m1", "one");
  const first = keep([line(a), line(message("m2", "two"))]);
  const edited = keep([line(a), line(message("m2", "two, edited"))]);
  expect(edited[0]).toBe(first[0]);
  expect(edited[1]).not.toBe(first[1]);
  expect(sameRows(first, edited)).toBe(false);
  const grown = keep([line(a), edited[1]!, line(message("m3", "three"))]);
  expect(grown[1]).toBe(edited[1]);
  expect(sameRows(edited, grown)).toBe(false);
});

test("a line that gains its day line is a new row", () => {
  const keep = createProjectRowKeeper();
  const a = message("m1", "one");
  const first = keep([line(a)]);
  const dated = keep([line(a, "2026-11-18T00:00:00Z")]);
  expect(dated[0]).not.toBe(first[0]);
});

test("the questions one call asked are one group; another call's, a moment later, are not", () => {
  const lines = [
    said("a", "2026-11-20T10:00:00.000Z"),
    ask("q1", "2026-11-20T10:00:01.000Z"),
    ask("q2", "2026-11-20T10:00:01.001Z"),
    ask("q3", "2026-11-20T10:00:01.002Z"),
    ask("r1", "2026-11-20T10:03:00.000Z"),
    said("b", "2026-11-20T10:04:00.000Z"),
  ];
  const { shown, open } = splitAsks(lines, () => false);
  expect(ids(shown)).toEqual(["a", "q1+q2+q3", "r1", "b"]);
  expect(open).toEqual([]);
});

test("questions the run waits on leave the lines with the rest of their call, oldest first", () => {
  const lines = [
    said("a", "2026-11-20T10:00:00.000Z"),
    ask("q1", "2026-11-20T10:00:01.000Z"),
    ask("q2", "2026-11-20T10:00:01.001Z"),
  ];
  // The first is answered already, and the run has not heard yet that it waits on it no more.
  const { shown, open } = splitAsks(lines, (id) => id === "q2");
  expect(ids(shown)).toEqual(["a"]);
  expect(open.map((m) => m.id)).toEqual(["q1", "q2"]);
});

test("a group of questions is one row, with the day over the first line of each day as shown", () => {
  const lines = [
    said("a", "2026-11-19T10:00:00.000Z"),
    ask("q1", "2026-11-20T10:00:01.000Z"),
    ask("q2", "2026-11-20T10:00:01.001Z"),
    said("b", "2026-11-20T10:04:00.000Z"),
  ];
  const rows = lineRows(splitAsks(lines, () => false).shown);
  expect(rows.map((row) => `${row.kind}:${row.id}:${row.kind === "line" || row.kind === "asks" ? (row.date ?? "") : ""}`)).toEqual([
    "line:a:2026-11-19T10:00:00.000Z",
    "asks:asks:q1:2026-11-20T10:00:01.000Z",
    "line:b:",
  ]);
  // The questions the run waits on are not shown, and the day goes to the next line shown.
  const waiting = lineRows(splitAsks(lines, (id) => id === "q1").shown);
  expect(waiting.map((row) => `${row.id}:${row.kind === "line" ? (row.date ?? "") : ""}`)).toEqual(["a:2026-11-19T10:00:00.000Z", "b:2026-11-20T10:04:00.000Z"]);
});

test("a group of questions keeps its row while its questions say the same, and is new once one is answered", () => {
  const keep = createProjectRowKeeper();
  const group = (answered: boolean): ProjectRow => ({
    id: "asks:q1",
    kind: "asks",
    messages: [ask("q1", "2026-11-20T10:00:01.000Z"), { ...ask("q2", "2026-11-20T10:00:01.001Z"), ask_answer: answered ? { selected: [], custom: "x", answered_at: "2026-11-20T10:01:00.000Z" } : null } as Message],
    date: null,
  });
  const first = keep([group(false)]);
  expect(keep([group(false)])[0]).toBe(first[0]);
  expect(keep([group(true)])[0]).not.toBe(first[0]);
});
