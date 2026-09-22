import { describe, expect, it } from "bun:test";
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  type NotificationCursorPayload,
} from "./notifications.ts";

describe("notifications protocol", () => {
  it("encodes and decodes valid notification cursors", () => {
    const payload: NotificationCursorPayload = {
      v: 1,
      filter: "actionable",
      upper_ordinal: 42,
      before_ordinal: 15,
    };
    const cursor = encodeNotificationCursor(payload);
    expect(typeof cursor).toBe("string");
    expect(cursor.length).toBeLessThanOrEqual(256);
    const decoded = decodeNotificationCursor(cursor);
    expect(decoded).toEqual(payload);
  });

  it("rejects invalid cursors", () => {
    expect(decodeNotificationCursor("not-base64-json")).toBeNull();
    expect(decodeNotificationCursor("a".repeat(257))).toBeNull();
    expect(decodeNotificationCursor(Buffer.from(JSON.stringify({ v: 2 }), "utf-8").toString("base64url"))).toBeNull();
    expect(decodeNotificationCursor(Buffer.from(JSON.stringify({ v: 1, filter: "bad", upper_ordinal: 1, before_ordinal: 1 }), "utf-8").toString("base64url"))).toBeNull();
    expect(decodeNotificationCursor(Buffer.from(JSON.stringify({ v: 1, filter: "all", upper_ordinal: -1, before_ordinal: 1 }), "utf-8").toString("base64url"))).toBeNull();
  });
});
