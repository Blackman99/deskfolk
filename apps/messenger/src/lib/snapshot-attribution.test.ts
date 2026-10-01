import { expect, test } from "bun:test";
import { applyEvent, emptySnapshot } from "./snapshot.ts";
import { aDirect, aMessage } from "./test-fixtures.ts";

test("attribution event changes transcript and sidebar primary projection; unfile clears stale ids without unread side effects", () => {
  const message = aMessage({ task_id: "old", ticket_id: "old-ticket" });
  const snapshot = { ...emptySnapshot(), messages: [message], sessions: [aDirect({ id: message.session_id, last_message: message, unread_count: 5 })] };
  const next = applyEvent(snapshot, {
    event: "attribution.changed", occurred_at: "2026-09-19T03:00:00Z", message_id: message.id, session_id: message.session_id,
    filing_state: "filed", filings: [
      { task_id: "other", ticket_id: null, part_key: null },
      { task_id: "primary", ticket_id: "ticket", part_key: "part", is_primary: true },
    ],
  });
  expect(next.messages[0]?.task_id).toBe("primary");
  expect(next.messages[0]?.ticket_id).toBe("ticket");
  expect(next.messages[0]?.filings).toHaveLength(2);
  expect(next.sessions[0]?.last_message).toEqual(next.messages[0]);
  expect(next.sessions[0]?.unread_count).toBe(5);
  const unfiled = applyEvent(next, { event: "attribution.changed", occurred_at: "t", message_id: message.id, session_id: message.session_id, filing_state: "none", filings: [] });
  expect(unfiled.messages[0]).toMatchObject({ filing_state: "none", filings: [], task_id: null, ticket_id: null });
  expect(applyEvent(unfiled, { event: "attribution.changed", occurred_at: "t", message_id: "missing", session_id: "missing", filing_state: "undetermined", filings: [] }).messages).toHaveLength(1);
});
