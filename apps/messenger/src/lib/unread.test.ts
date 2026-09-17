import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { countsAsUnread, isSessionUnread, sessionUnreadCount, unreadBadge } from "./unread.ts";

test("selected session is never shown as unread", () => {
  expect(isSessionUnread(3, true)).toBe(false);
  expect(isSessionUnread(3, false)).toBe(true);
  expect(isSessionUnread(0, false)).toBe(false);
  expect(isSessionUnread(undefined, false)).toBe(false);
});

test("unread badge caps at 99+", () => {
  expect(unreadBadge(1)).toBe("1");
  expect(unreadBadge(99)).toBe("99");
  expect(unreadBadge(100)).toBe("99+");
});

test("only main-transcript messages from others count as unread", () => {
  expect(countsAsUnread({ parent_id: null, author: "writer" })).toBe(true);
  expect(countsAsUnread({ parent_id: null, author: "user" })).toBe(false);
  expect(countsAsUnread({ parent_id: "m1", author: "writer" })).toBe(false);
  expect(countsAsUnread({ parent_id: null, author: "writer", kind: "profile_change" })).toBe(false);
});

test("sessionUnreadCount prefers the stored count and never marks the open session", () => {
  const session = {
    id: "s1",
    unread_count: 4,
    last_read_at: "t0",
    last_message: {
      parent_id: null,
      author: "writer",
      created_at: "t1",
    } as SessionSummary["last_message"],
  };
  expect(sessionUnreadCount(session, "s1")).toBe(0);
  expect(sessionUnreadCount(session, "s2")).toBe(4);
});

test("sessionUnreadCount falls back to last_message vs last_read_at", () => {
  const session = {
    id: "s1",
    last_read_at: "t0",
    last_message: {
      parent_id: null,
      author: "writer",
      created_at: "t1",
    } as SessionSummary["last_message"],
  };
  expect(sessionUnreadCount(session, null)).toBe(1);
  expect(sessionUnreadCount({ ...session, last_read_at: "t2" }, null)).toBe(0);
});
