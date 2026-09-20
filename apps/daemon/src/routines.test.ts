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
    const swept: Array<Date | undefined> = [];
    const now = new Date(2026, 8, 14, 10, 0, 0);
    const scheduler = startScheduler({
      store,
      engine: {
        fireRoutine(id, at) {
          fired.push(id);
          return store.claimRoutineDue(id, at ?? now) ? ({ id: "t" } as never) : null;
        },
        sweepStalledTurns(at) {
          swept.push(at);
        },
      } as TurnEngine,
      intervalMs: 60_000,
      now: () => now,
    });
    try {
      expect(fired).toEqual([routine.id]);
      // Every tick also closes turns that stopped making progress.
      expect(swept).toEqual([now]);
      scheduler.tick(now);
      expect(fired).toEqual([routine.id, routine.id]);
      expect(swept).toEqual([now, now]);
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
