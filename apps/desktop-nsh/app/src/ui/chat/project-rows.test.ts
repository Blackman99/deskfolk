/** A project session's rows keep their objects while they show the same (the list measures a new one again). */
import { expect, test } from "nsh/test";
import type { Message } from "@real-bot/protocol";
import type { ProjectRow } from "./project-chat-lines";
import { createProjectRowKeeper, sameRows } from "./project-rows";

const message = (id: string, body: string): Message => ({ id, body, kind: "bot", author: "claude-code", created_at: "2026-11-18T00:00:00Z" }) as unknown as Message;
const line = (m: Message, date: string | null = null): ProjectRow => ({ id: m.id, kind: "line", message: m, date });

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
