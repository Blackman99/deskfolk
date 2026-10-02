import { expect, test } from "bun:test";
import {
  desktopReadingMode,
  transcriptReadingReady,
  pickReadThrough,
  type PageReadingFacts,
  type VisibleBound,
} from "./reading.ts";
import { MessengerRuntime } from "../runtime.svelte.ts";

test("desktop reading mode requires native bridge for auto mode", () => {
  expect(desktopReadingMode(true, { native_reading_v1: false, native_delivery_v1: false })).toBe("explicit_only");
  expect(desktopReadingMode(true, { native_reading_v1: true, native_delivery_v1: false })).toBe("auto");
  expect(desktopReadingMode(false, { native_reading_v1: false, native_delivery_v1: false })).toBe("auto");
});

test("transcript reading readiness enforces foreground facts and unobstructed view", () => {
  const foreground: PageReadingFacts = {
    visibility: "visible",
    hasFocus: true,
    connected: true,
    snapshotReady: true,
    overlayBlocksTranscript: false,
  };
  expect(transcriptReadingReady(foreground, "auto")).toBe(true);
  expect(transcriptReadingReady(foreground, "explicit_only")).toBe(false);
  expect(transcriptReadingReady({ ...foreground, overlayBlocksTranscript: true }, "auto")).toBe(false);
  expect(transcriptReadingReady({ ...foreground, hasFocus: false }, "auto")).toBe(false);
  expect(transcriptReadingReady({ ...foreground, visibility: "hidden" }, "auto")).toBe(false);
});

test("pickReadThrough identifies the newest bound when held at latest", () => {
  const rendered: VisibleBound[] = [
    { messageId: "m1", seq: 10 },
    { messageId: "m2", seq: 15 },
    { messageId: "m3", seq: 12 },
  ];
  expect(pickReadThrough(rendered, false, 1500)).toBeNull();
  expect(pickReadThrough(rendered, true, 500)).toBeNull();
  expect(pickReadThrough(rendered, true, 1000)).toEqual({ messageId: "m2", seq: 15 });
});

test("submitBoundedRead updates session unread count in snapshot", async () => {
  const runtime = new MessengerRuntime();
  runtime.connection = "connected";
  runtime.selectedId = "s1";
  runtime.snapshot = {
    ...runtime.snapshot,
    sessions: [{ id: "s1", unread_count: 5, last_read_at: "t0" } as any],
  };
  (runtime as any).api = {
    markSessionReadThrough: async (sId: string, mId: string) => {
      return { id: sId, unread_count: 0, last_read_at: "t1" };
    },
  };
  await runtime.submitBoundedRead("s1", "m3");
  expect(runtime.snapshot.sessions.find((s) => s.id === "s1")?.unread_count).toBe(0);
});

test("a notification that lands in a conversation already read lets the read go once more", async () => {
  const runtime = new MessengerRuntime();
  runtime.connection = "connected";
  runtime.selectedId = "s1";
  runtime.snapshot = {
    ...runtime.snapshot,
    sessions: [{ id: "s1", unread_count: 0, last_read_at: "t0" } as any],
  };
  const sent: string[] = [];
  (runtime as any).api = {
    markSessionReadThrough: async (sId: string, mId: string) => {
      sent.push(mId);
      return { id: sId, unread_count: 0, last_read_at: "t0" };
    },
  };
  const notice = (ordinal: number, readAt: string | null, sessionId = "s1") =>
    ({ id: `n${ordinal}`, ordinal, session_id: sessionId, read_at: readAt, kind: "failure", action_state: "open" }) as any;
  const read = () => runtime.submitBoundedRead("s1", "m3", runtime.noticeMark("s1"));

  await read();
  await read();
  // Nothing new on screen: the same read is not sent again.
  expect(sent).toEqual(["m3"]);

  // A note the conversation does not list gets a notification of its own; nothing else changes
  // for the page, so this is the only way it learns there is something left to read.
  (runtime as any).notificationCenter.applyNotificationUpsert(notice(7, null));
  expect(runtime.noticeMark("s1")).toBe(7);
  await read();
  await read();
  expect(sent).toEqual(["m3", "m3"]);

  // One that is born read, or belongs to another conversation, changes nothing here.
  (runtime as any).notificationCenter.applyNotificationUpsert(notice(8, "t1"));
  (runtime as any).notificationCenter.applyNotificationUpsert(notice(9, null, "s2"));
  expect(runtime.noticeMark("s1")).toBe(7);
  await read();
  expect(sent).toEqual(["m3", "m3"]);
});
