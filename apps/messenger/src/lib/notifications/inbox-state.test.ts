import { expect, test } from "bun:test";
import {
  acceptFirstPage,
  acceptMore,
  applySummary,
  beginInboxLoad,
  beginMore,
  disconnectInbox,
  emptyInbox,
  markLocalRead,
  rejectInboxLoad,
  removeInboxItem,
  sectionInbox,
  upsertInboxItem,
} from "./inbox-state.ts";
import type { NotificationItem, NotificationListPage } from "./types.ts";

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ordinal: 4,
    kind: "approval",
    session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    message_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    turn_id: null,
    approval_id: null,
    routine_id: null,
    created_at: "2026-09-22T00:00:00.000Z",
    read_at: null,
    action_state: "open",
    resolution_reason: null,
    revision: 1,
    display: { title: "Writer", summary: "等你批准" },
    target: { session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX", approval_id: null },
    ...over,
  };
}

function page(items: NotificationItem[], over: Partial<NotificationListPage> = {}): NotificationListPage {
  return {
    items,
    next: null,
    summary: { unread_count: items.length, open_count: items.filter((row) => row.action_state === "open").length, attention_count: items.length },
    upper_ordinal: 9,
    event_instance_id: "a".repeat(32),
    watermark_seq: 1,
    ...over,
  };
}

test("a newer filter generation drops a late first page", () => {
  let state = emptyInbox("unread");
  state = beginInboxLoad(state, "actionable");
  const stale = beginInboxLoad(emptyInbox("unread"), "unread");
  state = acceptFirstPage(state, {
    filter: "unread",
    generation: stale.generation,
    instanceId: "old",
    watermark: 1,
    upperOrdinal: 9,
    page: page([item()]),
  });
  expect(state.items).toEqual([]);
  expect(state.filter).toBe("actionable");
});

test("more pages require the same instance, filter, and upper ordinal", () => {
  let state = beginInboxLoad(emptyInbox(), "all");
  state = acceptFirstPage(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "inst",
    watermark: 2,
    upperOrdinal: 9,
    page: page([item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 9 })], { next: "c1" }),
  });
  const later = acceptMore(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "other",
    watermark: 3,
    upperOrdinal: 9,
    page: page([item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", ordinal: 8 })]),
  });
  expect(later.error).toBe("stale");
  expect(later.items).toHaveLength(1);
});

test("upserts follow the live filter and disconnect clears business rows", () => {
  let state = beginInboxLoad(emptyInbox(), "unread");
  state = acceptFirstPage(state, {
    filter: "unread",
    generation: state.generation,
    instanceId: "inst",
    watermark: 1,
    upperOrdinal: 4,
    page: page([item()]),
  });
  state = upsertInboxItem(state, item({ read_at: "2026-09-22T01:00:00.000Z" }));
  expect(state.items).toHaveLength(0);
  state = upsertInboxItem(state, item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAC", ordinal: 5 }));
  expect(state.items.map((row) => row.ordinal)).toEqual([5]);
  state = applySummary(state, { unread_count: 1, open_count: 1, attention_count: 1 });
  state = disconnectInbox(state);
  expect(state.items).toEqual([]);
  expect(state.error).toBe("offline");
});

test("marking read locally can shrink the unread filter without touching open state", () => {
  let state = beginInboxLoad(emptyInbox(), "unread");
  const open = item();
  state = acceptFirstPage(state, {
    filter: "unread",
    generation: state.generation,
    instanceId: "inst",
    watermark: 1,
    upperOrdinal: 4,
    page: page([open]),
  });
  state = markLocalRead(state, [open.id], "2026-09-22T01:00:00.000Z");
  expect(state.items).toEqual([]);
});

test("rejecting a load does not clobber a replacement generation", () => {
  let state = beginInboxLoad(emptyInbox(), "all");
  const first = state.generation;
  state = beginInboxLoad(state, "unread");
  state = rejectInboxLoad(state, first, "unavailable");
  expect(state.filter).toBe("unread");
  expect(state.error).toBeNull();
});

test("removing a deleted target drops the row", () => {
  let state = beginInboxLoad(emptyInbox(), "all");
  const row = item();
  state = acceptFirstPage(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "inst",
    watermark: 1,
    upperOrdinal: 4,
    page: page([row]),
  });
  expect(removeInboxItem(state, row.id).items).toEqual([]);
});

test("needs-you rows stay above work results", () => {
  const sections = sectionInbox([
    item({ kind: "reply", action_state: "none", id: "01ARZ3NDEKTSV4RRFFQ69G5FAD" }),
    item({ kind: "ask", id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" }),
  ]);
  expect(sections.map((section) => section.id)).toEqual(["needs-you", "work"]);
});

test("a stale HTTP first page from empty applies the page then replays newer upsert/delete/summary", () => {
  let state = beginInboxLoad(emptyInbox("all"), "all");
  const older = item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", ordinal: 4 });
  const newer = item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 12 });
  const removed = item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAC", ordinal: 3 });
  const liveSummary = { unread_count: 9, open_count: 2, attention_count: 9 };
  state = acceptFirstPage(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "a".repeat(32),
    watermark: 4,
    upperOrdinal: 4,
    page: page([older, removed], { watermark_seq: 4, summary: { unread_count: 1, open_count: 0, attention_count: 1 } }),
    live: { event_instance_id: "a".repeat(32), watermark_seq: 10 },
    replay: [
      { seq: 6, event: "notification.upsert", item: newer },
      { seq: 7, event: "notification.removed", id: removed.id },
      { seq: 10, event: "notification.summary", summary: liveSummary },
    ],
  });
  expect(state.items.map((row) => row.id)).toEqual([newer.id, older.id]);
  expect(state.summary).toEqual(liveSummary);
  expect(state.watermark).toBe(10);
  expect(state.loading).toBe(false);
});

test("a stale HTTP more page appends older unchanged rows and keeps live summary after replay", () => {
  const first = item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 12 });
  const older = item({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", ordinal: 3 });
  let state = beginInboxLoad(emptyInbox("all"), "all");
  state = acceptFirstPage(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "a".repeat(32),
    watermark: 10,
    upperOrdinal: 12,
    page: page([first], { next: "c1", watermark_seq: 10, upper_ordinal: 12, summary: { unread_count: 9, open_count: 2, attention_count: 9 } }),
  });
  const liveSummary = { unread_count: 8, open_count: 1, attention_count: 8 };
  state = applySummary(state, liveSummary);
  state = beginMore(state);
  state = acceptMore(state, {
    filter: "all",
    generation: state.generation,
    instanceId: "a".repeat(32),
    watermark: 4,
    upperOrdinal: 12,
    page: page([older, item({ id: first.id, ordinal: 12, read_at: "2026-09-22T01:00:00.000Z" })], {
      summary: { unread_count: 1, open_count: 0, attention_count: 1 },
      watermark_seq: 4,
    }),
    live: { event_instance_id: "a".repeat(32), watermark_seq: 11 },
    replay: [
      { seq: 11, event: "notification.summary", summary: liveSummary },
    ],
  });
  expect(state.items.map((row) => row.id)).toEqual([first.id, older.id]);
  expect(state.items[0]!.read_at).toBeNull();
  expect(state.summary).toEqual(liveSummary);
  expect(state.loadingMore).toBe(false);
});
