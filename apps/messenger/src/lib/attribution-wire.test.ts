import { expect, test } from "bun:test";
import { LocalApi } from "./local-api.ts";

const api = new LocalApi({ origin: "http://127.0.0.1:17890", token: "test" });
const envelope = (payload: unknown) => JSON.stringify({ type: "event", event_instance_id: "a".repeat(32), seq: 1, payload });
const change = { event: "attribution.changed", occurred_at: "now", message_id: "message-1", session_id: "session-1", filing_state: "filed", filings: [{ task_id: "plan-1", ticket_id: null, part_key: null }] };

test("attribution events survive the local wire with all targets, while malformed changes are rejected", () => {
  expect(api.parseSyncFrame(envelope(change))).toMatchObject({ payload: change });
  expect(api.parseSyncFrame(envelope({ ...change, filing_state: "none", filings: [] }))).not.toBeNull();
  for (const patch of [
    { message_id: null }, { session_id: 1 }, { filing_state: "maybe" }, { filings: null },
    { filings: [{ task_id: "plan-1", ticket_id: {}, part_key: null }] },
    { filings: [{ task_id: "plan-1", ticket_id: null, part_key: null, is_primary: "yes" }] },
    { filings: [{ task_id: "plan-1", ticket_id: null, part_key: null, strength: "model-trusted" }] },
    { filing_state: "none" }, { filing_state: "filed", filings: [] },
    { filing_state: ["none"], filings: [] },
    { filings: [{ task_id: "plan-1", ticket_id: null, part_key: null, strength: ["user"] }] },
  ]) expect(api.parseSyncFrame(envelope({ ...change, ...patch }))).toBeNull();
});

test("lead changes accept the authoritative state but refuse malformed evidence or confirmations", () => {
  const lead = { event: "group_lead.changed", occurred_at: "now", session_id: "s", confirmed_bot_id: null,
    suggestion: { bot_id: "b", handoffs: 2, since: "2026-01-01" } };
  expect(api.parseSyncFrame(envelope(lead))).not.toBeNull();
  for (const patch of [{ session_id: null }, { confirmed_bot_id: 1 }, { suggestion: "b" },
    { suggestion: { bot_id: "b", handoffs: -1, since: "now" } }, { suggestion: { bot_id: "b", handoffs: 1.5, since: "now" } }]) {
    expect(api.parseSyncFrame(envelope({ ...lead, ...patch }))).toBeNull();
  }
});

test("legacy messages stay accepted, but a message cannot carry an invalid filing projection", () => {
  const legacy = { event: "message.upsert", id: "m", session_id: "s", kind: "user" };
  expect(api.parseSyncFrame(envelope(legacy))).not.toBeNull();
  expect(api.parseSyncFrame(envelope({ ...legacy, filing_state: "filed", filings: change.filings }))).not.toBeNull();
  expect(api.parseSyncFrame(envelope({ ...legacy, filing_state: "unknown" }))).toBeNull();
  expect(api.parseSyncFrame(envelope({ ...legacy, filings: [{ task_id: 3 }] }))).toBeNull();
});
