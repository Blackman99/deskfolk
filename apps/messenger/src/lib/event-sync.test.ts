import { describe, expect, test } from "bun:test";
import type { SequencedEvent } from "@real-bot/protocol";
import { EventSync } from "./event-sync.ts";
import { LocalApi } from "./api.ts";
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
