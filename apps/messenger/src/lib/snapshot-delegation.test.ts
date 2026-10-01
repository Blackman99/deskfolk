import { expect, test } from "bun:test";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot } from "./snapshot.ts";
import { aBotDirect } from "./test-fixtures.ts";
import { aDelegation } from "./test-delegations.ts";

test("structured event upserts a durable view without message/unread/wake side effects, survives transcript clear", () => {
  const row = aDelegation();
  const snapshot = { ...emptySnapshot(), sessions: [aBotDirect({ unread_count: 4 })] };
  const opened = applyEvent(snapshot, { event: "delegation.changed", occurred_at: row.created_at, ...row });
  expect(opened.delegations).toEqual([row]);
  expect(opened.messages).toBe(snapshot.messages);
  expect(opened.turns).toBe(snapshot.turns);
  expect(opened.sessions).toBe(snapshot.sessions);
  const held = { ...row, wait: { ...row.wait!, state: "held" as const } };
  const next = applyEvent(opened, { event: "delegation.changed", occurred_at: row.created_at, ...held });
  expect(next.delegations).toEqual([held]);
  const cleared = applyEvent(next, { event: "session.cleared", occurred_at: row.created_at, id: row.thread_session_id });
  expect(cleared.delegations).toEqual([held]);
  expect(fromRuntimeSnapshot({ ...emptySnapshot(), event_instance_id: "a".repeat(32), watermark_seq: 0 }).delegations).toEqual([]);
});
