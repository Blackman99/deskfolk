import { expect, test } from "bun:test";
import {
  clipCodes,
  defaultFilter,
  encodeNotificationCursor,
  parseNotificationCursor,
  parseNotificationItem,
  parseNotificationList,
  parseNotificationPolicy,
  parsePushStateV2,
  validateQuietHours,
} from "./parse.ts";

const item = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ordinal: 12,
  kind: "approval",
  session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  message_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  turn_id: null,
  approval_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  routine_id: null,
  created_at: "2026-09-22T00:00:00.000Z",
  read_at: null,
  action_state: "open",
  resolution_reason: null,
  revision: 1,
  display: { title: "Writer", summary: "等你批准" },
  target: {
    session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    message_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    approval_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  },
};

test("parses a contract notification and rejects extra kinds", () => {
  expect(parseNotificationItem(item)?.id).toBe(item.id);
  expect(parseNotificationItem({ ...item, kind: "token" })).toBeNull();
  expect(parseNotificationItem({ ...item, id: "not-a-ulid" })).toBeNull();
});

test("clips display strings to the documented code-point limits", () => {
  const long = "字".repeat(200);
  const parsed = parseNotificationItem({
    ...item,
    display: { title: long, summary: long },
  });
  expect([...parsed!.display.title].length).toBe(80);
  expect([...parsed!.display.summary].length).toBe(160);
  expect(clipCodes("abc", 2)).toBe("ab");
});

test("list parser requires a watermark barrier and ordinal order payload", () => {
  const page = parseNotificationList({
    items: [item],
    next: null,
    summary: { unread_count: 1, open_count: 1, attention_count: 1 },
    upper_ordinal: 12,
    event_instance_id: "a".repeat(32),
    watermark_seq: 4,
  });
  expect(page?.items).toHaveLength(1);
  expect(parseNotificationList({ items: [item], upper_ordinal: 12 })).toBeNull();
});

test("cursors bind filter and upper ordinal and stay under 256 bytes", () => {
  const raw = encodeNotificationCursor({ v: 1, filter: "unread", upper_ordinal: 9, before_ordinal: 3 });
  expect(raw.length).toBeLessThanOrEqual(256);
  expect(parseNotificationCursor(raw, "unread", 9)).toEqual({
    v: 1,
    filter: "unread",
    upper_ordinal: 9,
    before_ordinal: 3,
  });
  expect(parseNotificationCursor(raw, "all", 9)).toBeNull();
  expect(parseNotificationCursor(raw, "unread", 8)).toBeNull();
});

test("quiet hours reject equal bounds and unknown IANA zones", () => {
  expect(validateQuietHours("22:00", "08:00", "Asia/Shanghai")).toBeNull();
  expect(validateQuietHours("22:00", "22:00", "Asia/Shanghai")).toBe("equal_range");
  expect(validateQuietHours("22:00", "08:00", "Not/AZone")).toBe("invalid_time_zone");
});

test("policy and push v2 parsers ignore unknown fields", () => {
  const policy = parseNotificationPolicy({
    revision: 2,
    categories: { approval: false, extra: true },
    quiet_hours: { enabled: true, start: "22:00", end: "08:00", time_zone: "UTC" },
    secret: "nope",
  });
  expect(policy?.categories.approval).toBe(false);
  expect(policy?.categories.ask).toBe(true);
  expect(parsePushStateV2({
    applicationServerKey: "A",
    subscribed: true,
    enabled: false,
    device_revision: 3,
    recovery: "gone",
    endpoint: "https://example",
  })?.recovery).toBe("gone");
});

test("push v2 GET maps vapid_key_fingerprint onto subscribe fingerprint and parses transport", () => {
  const parsed = parsePushStateV2({
    applicationServerKey: "B".repeat(87),
    subscribed: true,
    enabled: true,
    device_revision: 4,
    push_generation: 2,
    vapid_key_fingerprint: "vapid-fp-hex",
    recovery: "none",
    current_endpoint_hash: null,
    last_gone_endpoint_hash: null,
    last_error_code: null,
    contact_configured: true,
    push_transport: "paused_upgrade",
  });
  expect(parsed?.application_server_key_fingerprint).toBe("vapid-fp-hex");
  expect(parsed?.push_transport).toBe("paused_upgrade");
  expect(parsed?.current_endpoint_hash).toBeNull();
  expect(parsed?.last_gone_endpoint_hash).toBeNull();
  expect(parsed?.last_error_code).toBeNull();
});

test("push v2 GET keeps endpoint hashes and last_error_code when present", () => {
  const parsed = parsePushStateV2({
    applicationServerKey: "C".repeat(87),
    subscribed: false,
    enabled: true,
    device_revision: 1,
    push_generation: 8,
    vapid_key_fingerprint: "vapid-fp-hex",
    recovery: "gone",
    current_endpoint_hash: "cur-hash",
    last_gone_endpoint_hash: "gone-hash",
    last_error_code: "gone",
    contact_configured: false,
    push_transport: "policy_v2",
  });
  expect(parsed?.application_server_key_fingerprint).toBe("vapid-fp-hex");
  expect(parsed?.current_endpoint_hash).toBe("cur-hash");
  expect(parsed?.last_gone_endpoint_hash).toBe("gone-hash");
  expect(parsed?.last_error_code).toBe("gone");
  expect(parsed?.push_transport).toBe("policy_v2");
});

test("default filter prefers actionable when open items exist", () => {
  expect(defaultFilter({ unread_count: 4, open_count: 1, attention_count: 4 })).toBe("actionable");
  expect(defaultFilter({ unread_count: 2, open_count: 0, attention_count: 2 })).toBe("unread");
});
