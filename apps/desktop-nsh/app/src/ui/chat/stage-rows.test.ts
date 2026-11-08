/** The stage's rows keep their objects while they show the same (the list rebuilds a new one). */
import { expect, test } from "nsh/test";
import type { Message, Turn } from "@real-bot/protocol";
import type { TranscriptGroup } from "../../m/chat/chat-view.ts";
import { createRowKeeper, stageRows } from "./stage-rows";

const message = (id: string, body: string): Message => ({ id, body, kind: "bot", author: "b1", created_at: "2026-11-08T00:00:00Z" }) as unknown as Message;
const group = (id: string, items: TranscriptGroup["items"]): TranscriptGroup => ({ id, kind: "bot", author: "b1", created_at: "2026-11-08T00:00:00Z", items });
const rowsOf = (groups: TranscriptGroup[], newMarkId: string | null = null) => stageRows(groups, { earlier: true, delegations: false, newMarkId });

test("rows made again from the same lines are the same objects", () => {
  const keep = createRowKeeper();
  const a = message("m1", "one");
  const b = message("m2", "two");
  const first = keep(rowsOf([group("g1", [{ type: "message", message: a }]), group("g2", [{ type: "message", message: b }])]));
  // Another pane's line changed the snapshot: these groups come back as new objects holding the same lines.
  const again = keep(rowsOf([group("g1", [{ type: "message", message: a }]), group("g2", [{ type: "message", message: b }])]));
  expect(again.length).toBe(3);
  again.forEach((row, index) => expect(row).toBe(first[index]));
});

test("a line fetched again that says the same keeps its row", () => {
  const keep = createRowKeeper();
  const first = keep(rowsOf([group("g1", [{ type: "message", message: message("m1", "one") }])]));
  // Making the pane current selects its conversation, which loads the page again: new objects, the same lines.
  const refetched = keep(rowsOf([group("g1", [{ type: "message", message: message("m1", "one") }])]));
  expect(refetched[1]).toBe(first[1]);
});

test("only the row whose line changed is a new object", () => {
  const keep = createRowKeeper();
  const a = message("m1", "one");
  const first = keep(rowsOf([group("g1", [{ type: "message", message: a }]), group("g2", [{ type: "message", message: message("m2", "two") }])]));
  const edited = message("m2", "two, edited");
  const next = keep(rowsOf([group("g1", [{ type: "message", message: a }]), group("g2", [{ type: "message", message: edited }])]));
  expect(next[1]).toBe(first[1]);
  expect(next[2]).not.toBe(first[2]);
  expect(next[2]!.kind === "group" && next[2]!.group.items[0]!.type === "message" && next[2]!.group.items[0]!.message.body).toBe("two, edited");
});

test("a turn streaming keeps its row; a new line in a group, the date and the New line each make it anew", () => {
  const keep = createRowKeeper();
  const a = message("m1", "one");
  const turn = { id: "t1", text: "he" } as unknown as Turn;
  const first = keep(rowsOf([group("g1", [{ type: "message", message: a }, { type: "streaming", turn }])]));
  // Its reply reads the turn live: a token is not a new row.
  const streamed = keep(rowsOf([group("g1", [{ type: "message", message: a }, { type: "streaming", turn: { ...turn, text: "hello" } as Turn }])]));
  expect(streamed[1]).toBe(first[1]);
  const grown = keep(rowsOf([group("g1", [{ type: "message", message: a }, { type: "streaming", turn: streamed[1]!.kind === "group" ? (streamed[1]!.group.items[1] as { turn: Turn }).turn : turn }, { type: "message", message: message("m3", "three") }])]));
  expect(grown[1]).not.toBe(streamed[1]);
  const marked = keep(rowsOf([group("g1", (grown[1] as { group: TranscriptGroup }).group.items)], "m1"));
  expect(marked[1]).not.toBe(grown[1]);
  expect(marked[0]).toBe(first[0]);
});
