/**
 * The day's spend cap (ADR 0088): once today has cost what you set, the scheduler's tick stops
 * every Bot with one hold of the app's that waits for your Lift; a Lift lets them go on for the rest
 * of the day, and a new cap arms it again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompletionResult } from "../completions";
import { Store } from "../store";
import { localDayStart } from "../store/spend-cap";
import { createScenario, endTurn, call, say, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

async function scenario(): Promise<Scenario> {
  const h = await createScenario({ holds: true });
  open.push(h);
  return h;
}

function spend(h: Scenario, session: string, usd: number): void {
  h.store.insertSpend({ kind: "organize", sessionId: session, botId: null, costUsdTicks: Math.round(usd * 1e10) });
}

function capHolds(h: Scenario) {
  return h.store.listHolds({ inForce: true }).filter((hold) => hold.source === "spend_cap");
}

describe("the day's spend cap", () => {
  test("no cap, nothing stops however much today cost", async () => {
    const h = await scenario();
    const [writer] = h.createBots("写手");
    const dm = h.direct(writer!);
    spend(h, dm, 50);
    h.tick();
    expect(h.store.listHolds({ inForce: true })).toEqual([]);
    expect(h.store.settingsCached().spend_cap_usd).toBeNull();
  });

  test("reaching the cap ends the live turn under one stop of the app's that waits for your Lift", async () => {
    const h = await scenario();
    const [writer] = h.createBots("写手");
    const dm = h.direct(writer!);
    let mid = false;
    h.script(writer!, dm).reply(() => {
      mid = true;
      return new Promise<CompletionResult>(() => {});
    });
    h.postUser(dm, "把第一章写完");
    await h.waitFor(() => mid, { what: "the turn to be mid-hop" });
    const turn = h.store.listLiveTurns({ sessionId: dm, botId: writer!.id })[0]!;

    h.store.patchSettingsSync({ spend_cap_usd: 1 });
    spend(h, dm, 0.6);
    h.tick();
    expect(capHolds(h)).toEqual([]);

    spend(h, dm, 0.6);
    h.tick();
    const [hold] = capHolds(h);
    expect(hold).toMatchObject({ scope: "global", scope_id: null, lift_on_next_user_message: false, effect: { spend_cap: { cap_usd: 1, spent_usd: 1.2 } } });
    expect(h.store.getTurn(turn.id).status).not.toBe("running");
    expect(h.store.listLiveTurns({ sessionId: dm, botId: writer!.id })).toEqual([]);

    // Later ticks the same day make no second stop.
    spend(h, dm, 1);
    h.tick();
    expect(capHolds(h)).toHaveLength(1);
  });

  test("a line of yours does not lift it; your Lift does, and it stays lifted for the day at that cap", async () => {
    const h = await scenario();
    const [writer] = h.createBots("写手");
    const dm = h.direct(writer!);
    h.store.patchSettingsSync({ spend_cap_usd: 2 });
    spend(h, dm, 2);
    h.tick();
    const [hold] = capHolds(h);
    expect(hold).toBeDefined();

    h.script(writer!, dm).reply(say("今天的额度到了，等你解除再接着写。"), call(endTurn()));
    h.postUser(dm, "继续写");
    await h.waitIdle();
    expect(capHolds(h).map((row) => row.id)).toEqual([hold!.id]);

    h.engine.liftHold(hold!.id);
    spend(h, dm, 1);
    h.tick();
    expect(capHolds(h)).toEqual([]);

    // A new cap arms it again.
    h.store.patchSettingsSync({ spend_cap_usd: 3 });
    h.tick();
    expect(capHolds(h)).toHaveLength(1);
    expect(capHolds(h)[0]!.effect.spend_cap).toEqual({ cap_usd: 3, spent_usd: 3 });
  });

  test("the cap is a positive number of USD or null", async () => {
    const h = await scenario();
    for (const bad of [0, -1, "5", Number.NaN]) {
      expect(() => h.store.patchSettingsSync({ spend_cap_usd: bad })).toThrow(/spend_cap_usd/);
    }
    expect(h.store.patchSettingsSync({ spend_cap_usd: 4.567 }).spend_cap_usd).toBe(4.57);
    expect(h.store.patchSettingsSync({ spend_cap_usd: null }).spend_cap_usd).toBeNull();
  });
});

describe("what counts toward today", () => {
  test("calls since local midnight, reported or estimated; yesterday's do not, and tomorrow starts afresh", () => {
    const store = new Store({ filename: ":memory:" });
    try {
      const session = "s-ledger";
      store.db.run(`INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'group', '账', ?, ?, ?)`, [session, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
      const now = new Date(2026, 9, 12, 15, 0, 0);
      const yesterday = new Date(2026, 9, 11, 23, 30, 0).toISOString();
      const insert = (at: string, cost: number | null, estimated: number | null) => {
        const row = store.insertSpend({ kind: "organize", sessionId: session, botId: null, costUsdTicks: cost, estimatedCostUsdTicks: estimated });
        store.db.run(`UPDATE spend SET created_at = ? WHERE id = ?`, [at, row.id]);
      };
      store.patchSettingsSync({ spend_cap_usd: 1 });
      insert(yesterday, 5e10, null);
      insert(localDayStart(now), 4e9, null);
      insert(new Date(2026, 9, 12, 9, 0, 0).toISOString(), null, 4e9);
      expect(store.spendCapDue(now)).toBeNull();
      insert(new Date(2026, 9, 12, 10, 0, 0).toISOString(), null, null);
      insert(new Date(2026, 9, 12, 11, 0, 0).toISOString(), 2e9, null);
      expect(store.spendCapDue(now)).toEqual({ capUsd: 1, spentUsd: 1, day: "2026-10-12" });

      store.noteSpendCapTrip({ day: "2026-10-12", capUsd: 1, spentUsd: 1, holdId: null });
      expect(store.spendCapDue(now)).toBeNull();
      const tomorrow = new Date(2026, 9, 13, 8, 0, 0);
      insert(new Date(2026, 9, 13, 7, 0, 0).toISOString(), 1e10, null);
      expect(store.spendCapDue(tomorrow)).toEqual({ capUsd: 1, spentUsd: 1, day: "2026-10-13" });
    } finally {
      store.close();
    }
  });
});
