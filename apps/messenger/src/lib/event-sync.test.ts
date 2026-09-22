import { describe, expect, test } from "bun:test";
import type { SequencedEvent } from "@real-bot/protocol";
import { EventSync, MAX_NOTIFICATION_TAIL } from "./event-sync.ts";
import { LocalApi } from "./local-api.ts";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot } from "./snapshot.ts";

const instance = "a".repeat(32);
const cursor = (seq = 0) => ({ event_instance_id: instance, watermark_seq: seq });
const event = (seq: number): SequencedEvent => ({
  type: "event", event_instance_id: instance, seq,
  payload: { event: "routine.removed", occurred_at: "now", id: String(seq) },
});

describe("snapshot event barrier", () => {
  test("buffers before snapshot, ignores watermarked events and duplicates, and applies only contiguous successors", () => {
    const sync = new EventSync();
    expect(sync.receive(event(1))).toEqual([]);
    expect(sync.receive(event(2))).toEqual([]);
    expect(sync.install(cursor(1))).toEqual([event(2)]);
    expect(sync.snapshotCursor()).toEqual(cursor(2));
    expect(sync.receive(event(2))).toEqual([]);
    expect(sync.receive(event(3))).toEqual([event(3)]);
    expect(sync.receive(event(5))).toBeNull();
  });
  test("out of order, new process, ring reset and bounded-buffer overflow require resnapshot", () => {
    const disorder = new EventSync();
    disorder.receive(event(2)); disorder.receive(event(1));
    expect(disorder.install(cursor())).toBeNull();
    const restart = new EventSync();
    restart.install(cursor());
    expect(restart.receive({ ...event(1), event_instance_id: "b".repeat(32) })).toBeNull();
    expect(new EventSync().receive({ type: "resnapshot", ...cursor() })).toBeNull();
    const overflow = new EventSync();
    for (let i = 1; i <= 2000; i++) expect(overflow.receive(event(i))).toEqual([]);
    expect(overflow.receive(event(2001))).toBeNull();
    expect(overflow.install(cursor())).toBeNull();
  });
  test("session-detail pause preserves events for other sessions and replays from the existing cursor", () => {
    const sync = new EventSync();
    sync.install(cursor(4)); sync.pause();
    sync.receive(event(5)); sync.receive(event(6));
    expect(sync.install()).toEqual([event(5), event(6)]);
    expect(sync.receive(event(7))).toEqual([event(7)]);
  });
  test("notification tail replays only frames after an HTTP page watermark", () => {
    const sync = new EventSync();
    sync.install(cursor());
    const unrelated = event(1);
    const upsert: SequencedEvent = {
      type: "event", event_instance_id: instance, seq: 2,
      payload: {
        event: "notification.upsert", occurred_at: "now",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 12, semantic_key: "ask:1", kind: "ask",
        created_at: "now", action_state: "open", revision: 1,
        display: { title: "Live", summary: "" }, target: {},
      },
    };
    const removed: SequencedEvent = {
      type: "event", event_instance_id: instance, seq: 3,
      payload: { event: "notification.removed", occurred_at: "now", id: "01ARZ3NDEKTSV4RRFFQ69G5FAB" },
    };
    expect(sync.receive(unrelated)).toEqual([unrelated]);
    expect(sync.receive(upsert)).toEqual([upsert]);
    expect(sync.receive(removed)).toEqual([removed]);
    const afterOne = sync.notificationEventsAfter(cursor(1));
    expect(afterOne.complete).toBe(true);
    if (afterOne.complete) expect(afterOne.frames.map((frame) => frame.seq)).toEqual([2, 3]);
    const afterTwo = sync.notificationEventsAfter(cursor(2));
    expect(afterTwo.complete).toBe(true);
    if (afterTwo.complete) expect(afterTwo.frames.map((frame) => frame.seq)).toEqual([3]);
    expect(sync.notificationEventsAfter({ event_instance_id: "b".repeat(32), watermark_seq: 0 })).toEqual({
      complete: false, frames: [], reason: "instance",
    });
    const paused = new EventSync();
    paused.install(cursor(4));
    paused.pause();
    const buffered: SequencedEvent = {
      type: "event", event_instance_id: instance, seq: 5,
      payload: { event: "notification.summary", occurred_at: "now", summary: { unread_count: 2, open_count: 1, attention_count: 2 } },
    };
    expect(paused.receive(buffered)).toEqual([]);
    expect(paused.notificationEventsAfter(cursor(4))).toEqual({ complete: true, frames: [buffered] });
  });
  test("truncated notification tail is unavailable when a dropped removal is still needed", () => {
    const sync = new EventSync();
    sync.install(cursor());
    const notice = (seq: number, id: string): SequencedEvent => ({
      type: "event", event_instance_id: instance, seq,
      payload: { event: "notification.removed", occurred_at: "now", id },
    });
    for (let seq = 1; seq <= MAX_NOTIFICATION_TAIL + 1; seq++) {
      expect(sync.receive(notice(seq, String(seq).padStart(26, "0"))).map((frame) => frame.seq)).toEqual([seq]);
    }
    const behind = sync.notificationEventsAfter(cursor(0));
    expect(behind.complete).toBe(false);
    if (!behind.complete) expect(behind.reason).toBe("truncated");
    const covered = sync.notificationEventsAfter(cursor(1));
    expect(covered.complete).toBe(true);
    if (covered.complete) expect(covered.frames[0]?.seq).toBe(2);
  });
  test("instance switch and invalid gap refuse replay and clear the live cursor", () => {
    const switched = new EventSync();
    switched.install(cursor());
    expect(switched.receive({ ...event(1), event_instance_id: "b".repeat(32) })).toBeNull();
    expect(switched.snapshotCursor()).toBeNull();
    expect(switched.notificationEventsAfter(cursor())).toEqual({ complete: false, frames: [], reason: "invalid" });
    const gapped = new EventSync();
    gapped.install(cursor());
    expect(gapped.receive(event(1))).toEqual([event(1)]);
    expect(gapped.receive(event(3))).toBeNull();
    expect(gapped.snapshotCursor()).toBeNull();
    expect(gapped.notificationEventsAfter(cursor(1))).toEqual({ complete: false, frames: [], reason: "invalid" });
  });
  test("detail watermark waits are cancelled on close and never skip global gaps", async () => {
    const sync = new EventSync();
    sync.install(cursor()); sync.pause();
    const ready = sync.waitThrough(cursor(2));
    sync.receive(event(2));
    expect(await ready).toBe(true);
    expect(sync.install()).toBeNull();
    const closed = new EventSync();
    closed.install(cursor()); closed.pause();
    const cancelled = closed.waitThrough(cursor(4));
    closed.close();
    expect(await cancelled).toBe(false);
  });
  test("negotiates sync-v1 and rejects unsafe cursors, raw or ephemeral frames", () => {
    const api = new LocalApi({ origin: "http://127.0.0.1:17891", token: "fixture" });
    expect(JSON.parse(api.authFrame()).protocol).toBe("sync-v1");
    for (const frame of [null, {}, { ...event(1), seq: -1 }, { ...event(1), seq: Number.MAX_SAFE_INTEGER + 1 }, { ...event(1), event_instance_id: "bad" }, { ...event(1), payload: { event: "turn.token" } }, { ...event(1), payload: { event: "turn.tool" } }]) {
      expect(api.parseSyncFrame(JSON.stringify(frame))).toBeNull();
    }
    expect(api.parseSyncFrame(JSON.stringify(event(1)))).toEqual(event(1));
  });
  test("routine/allow-rule snapshots and live changes are idempotent; absolute partials never append twice", () => {
    const routine = { id: "r", bot_id: "b", title: "before", instruction: "fixture", schedule: { kind: "daily" as const, time: "09:00" }, enabled: true, last_fired_for_due_at: null, created_at: "now", updated_at: "now" };
    const rule = { id: "a", kind_key: "outside-read", scope: "/fixture", created_at: "now" };
    const base = emptySnapshot();
    let snapshot = fromRuntimeSnapshot({ ...base, ...cursor(), routines: [routine], allowRules: [rule] });
    snapshot = applyEvent(snapshot, { ...routine, event: "routine.upsert", occurred_at: "now", title: "after" });
    snapshot = applyEvent(snapshot, { ...rule, event: "allow_rule.upsert", occurred_at: "now", scope: "/next" });
    expect(snapshot.routines[0]!.title).toBe("after");
    expect(snapshot.allowRules).toHaveLength(1);
    expect(snapshot.allowRules[0]!.scope).toBe("/next");
    const turn = { id: "t", session_id: "s", bot_id: "b", trigger_message_id: "m", status: "running" as const, partial_text: "once", created_at: "now", updated_at: "now", last_activity_at: "now" };
    const upsert = { ...turn, event: "turn.upsert" as const, occurred_at: "now" };
    snapshot = applyEvent(applyEvent(snapshot, upsert), upsert);
    expect(snapshot.turns[0]!.partial_text).toBe("once");
    snapshot = applyEvent(snapshot, { event: "routine.removed", occurred_at: "now", id: "r" });
    snapshot = applyEvent(snapshot, { event: "allow_rule.removed", occurred_at: "now", id: "a" });
    expect(snapshot.routines).toEqual([]);
    expect(snapshot.allowRules).toEqual([]);
  });
});
