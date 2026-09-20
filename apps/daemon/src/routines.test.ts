import { describe, expect, test } from "bun:test";
import { startScheduler } from "./scheduler";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import type { TurnEngine } from "./turn-engine";

function backdate(store: Store, id: string, createdAt: Date): void {
  store.db.run(`UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, updated_at = ? WHERE id = ?`, [
    createdAt.toISOString(),
    createdAt.toISOString(),
    id,
  ]);
}

test('deleting a Bot retains its historical routine and search hit', () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    const { bot } = store.createBot({ name: 'Disposable', duties: 'fixture', boundaries: 'fixture' });
    const row = store.createRoutine({ bot_id: bot.id, title: 'Retained history', instruction: '', schedule: { kind: 'daily', time: '09:00' } });
    store.deleteBot(bot.id);
    expect(store.listBots().some((bot) => bot.id === row.bot_id)).toBe(false);
    expect(store.getRoutine(row.id)).toEqual(row);
    expect(store.search('Retained history').some((hit) => hit.kind === 'routine' && hit.id === row.id)).toBe(true);
  } finally { store.close(); }
});

describe("routine revisions", () => {
  test("patch and scheduler claim advance a future revision without relying on the wall clock", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const { bot } = store.createBot({ name: "Clock", duties: "", boundaries: "" });
      const row = store.createRoutine({ bot_id: bot.id, title: "Future revision", instruction: "", schedule: { kind: "daily", time: "09:00" } });
      const previous = "2099-01-01T00:00:00.000Z";
      store.db.run("UPDATE routines SET created_at = ?, updated_at = ? WHERE id = ?", [new Date(2026, 8, 10, 8).toISOString(), previous, row.id]);
      const next = store.patchRoutine(row.id, { title: "Patched", if_revision: previous });
      expect(next.updated_at).toBe("2099-01-01T00:00:00.001Z");
      const events: string[] = [];
      store.onCommit((event) => events.push(event.event));
      const claimed = store.claimRoutineDue(row.id, new Date(2026, 8, 14, 10));
      expect(claimed?.updated_at).toBe("2099-01-01T00:00:00.002Z");
      expect(store.claimRoutineDue(row.id, new Date(2026, 8, 14, 10))).toBeNull();
      expect(() => store.patchRoutine(row.id, { enabled: false, if_revision: next.updated_at })).toThrow("routine changed");
      expect(() => store.deleteRoutine(row.id, next.updated_at)).toThrow("routine changed");
      expect(events).toEqual(["routine.upsert"]);
      store.deleteRoutine(row.id, claimed!.updated_at);
      expect(events).toEqual(["routine.upsert", "routine.removed"]);
    } finally { store.close(); }
  });

  test("rapid writes advance revisions; stale patches and deletes do not mutate or publish", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
      const row = store.createRoutine({ bot_id: bot.id, title: "First", instruction: "", schedule: { kind: "daily", time: "00:00" }, enabled: false });
      const next = store.patchRoutine(row.id, { title: "Second", if_revision: row.updated_at });
      expect(next.updated_at > row.updated_at).toBe(true);
      expect(() => store.patchRoutine(row.id, { title: "stale", if_revision: row.updated_at })).toThrow("routine changed");
      expect(() => store.deleteRoutine(row.id, row.updated_at)).toThrow("routine changed");
      expect(store.getRoutine(row.id)).toEqual(next);
      store.deleteRoutine(row.id, next.updated_at);
      expect(store.listRoutines()).toHaveLength(0);
    } finally { store.close(); }
  });
});

describe("routine claim and catch-up", () => {
  test("claim stamps the latest civil due and a second claim at the same now is a no-op", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const routine = store.createRoutine({
      bot_id: bot.id,
      title: "日报",
      instruction: "write the daily",
      schedule: { kind: "daily", time: "09:00" },
    });
    backdate(store, routine.id, new Date(2026, 8, 10, 8, 0, 0));
    const now = new Date(2026, 8, 14, 10, 0, 0);
    const claimed = store.claimRoutineDue(routine.id, now);
    expect(claimed?.last_fired_for_due_at).toBe(new Date(2026, 8, 14, 9, 0, 0).toISOString());
    expect(store.claimRoutineDue(routine.id, now)).toBeNull();
    store.close();
  });

  test("a cursor from an older due still only claims the latest missed occurrence", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const routine = store.createRoutine({
      bot_id: bot.id,
      title: "日报",
      instruction: "write the daily",
      schedule: { kind: "daily", time: "09:00" },
    });
    const created = new Date(2026, 8, 10, 8, 0, 0).toISOString();
    const oldDue = new Date(2026, 8, 12, 9, 0, 0).toISOString();
    store.db.run(`UPDATE routines SET created_at = ?, last_fired_for_due_at = ?, updated_at = ? WHERE id = ?`, [
      created,
      oldDue,
      created,
      routine.id,
    ]);
    const claimed = store.claimRoutineDue(routine.id, new Date(2026, 8, 14, 10, 0, 0));
    expect(claimed?.last_fired_for_due_at).toBe(new Date(2026, 8, 14, 9, 0, 0).toISOString());
    store.close();
  });

  test("disabled and archived bots do not claim", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const routine = store.createRoutine({
      bot_id: bot.id,
      title: "日报",
      instruction: "write the daily",
      schedule: { kind: "daily", time: "09:00" },
      enabled: false,
    });
    backdate(store, routine.id, new Date(2026, 8, 10, 8, 0, 0));
    const now = new Date(2026, 8, 14, 10, 0, 0);
    expect(store.claimRoutineDue(routine.id, now)).toBeNull();

    store.patchRoutine(routine.id, { enabled: true });
    backdate(store, routine.id, new Date(2026, 8, 10, 8, 0, 0));
    store.archiveBot(bot.id);
    expect(store.claimRoutineDue(routine.id, now)).toBeNull();
    store.close();
  });

  test("scheduler tick catch-up asks the engine once per due", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const routine = store.createRoutine({
      bot_id: bot.id,
      title: "日报",
      instruction: "write the daily",
      schedule: { kind: "daily", time: "09:00" },
    });
    backdate(store, routine.id, new Date(2026, 8, 10, 8, 0, 0));
    const fired: string[] = [];
    const now = new Date(2026, 8, 14, 10, 0, 0);
    const scheduler = startScheduler({
      store,
      engine: {
        fireRoutine(id, at) {
          fired.push(id);
          return store.claimRoutineDue(id, at ?? now) ? ({ id: "t" } as never) : null;
        },
      } as TurnEngine,
      intervalMs: 60_000,
      now: () => now,
    });
    try {
      expect(fired).toEqual([routine.id]);
      scheduler.tick(now);
      expect(fired).toEqual([routine.id, routine.id]);
      expect(store.getRoutine(routine.id).last_fired_for_due_at).toBe(
        new Date(2026, 8, 14, 9, 0, 0).toISOString(),
      );
    } finally {
      scheduler.stop();
      store.close();
    }
  });

  test("weekly catch-up does not invent a weekday outside the set", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const { bot } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const routine = store.createRoutine({
      bot_id: bot.id,
      title: "周报",
      instruction: "weekly note",
      schedule: { kind: "weekly", time: "09:00", weekdays: ["mon", "wed", "fri"] },
    });
    backdate(store, routine.id, new Date(2026, 8, 7, 8, 0, 0));
    // Thursday 2026-09-17 → latest is Wednesday 16th.
    const claimed = store.claimRoutineDue(routine.id, new Date(2026, 8, 17, 10, 0, 0));
    expect(claimed?.last_fired_for_due_at).toBe(new Date(2026, 8, 16, 9, 0, 0).toISOString());
    store.close();
  });
});
