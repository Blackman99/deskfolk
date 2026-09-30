/**
 * The work log (ADR 0040): appended, and read back in the order it was written, never by its clock.
 */
import { expect, test } from "bun:test";
import { Store } from ".";

test("reads back in the order written, by kind and after an event already read", () => {
  const store = new Store();
  const first = store.recordWorkEvent({ kind: "wake.suppressed", actor: "app", botId: "b1", payload: { cause: "mention", holds: ["h1"] } });
  const other = store.recordWorkEvent({ kind: "other.kind", actor: "app" });
  const second = store.recordWorkEvent({ kind: "wake.suppressed", actor: "app", botId: "b2", sessionId: "s1", payload: { cause: "routine", holds: ["h1"] } });

  expect(store.listWorkEvents().map((row) => row.seq)).toEqual([first.seq, other.seq, second.seq]);
  expect(store.listWorkEvents({ kind: "wake.suppressed" }).map((row) => [row.bot_id, row.payload.cause])).toEqual([
    ["b1", "mention"],
    ["b2", "routine"],
  ]);
  expect(store.listWorkEvents({ afterSeq: first.seq }).map((row) => row.kind)).toEqual(["other.kind", "wake.suppressed"]);
  expect(store.listWorkEvents({ kind: "wake.suppressed", limit: 1 }).map((row) => row.seq)).toEqual([first.seq]);
  expect(second).toMatchObject({ actor: "app", session_id: "s1", task_id: null, turn_id: null, part_key: null, work_item_id: null });
  store.close();
});
