import { describe, expect, test } from "bun:test";
import { USER_MEMBER } from "@real-bot/protocol";
import { memoryKeyStore } from "../../src/secrets";
import { Store } from "../../src/store";
import { dueSteps, resolveBotDirects, scriptClock, scriptDueBeforeDeadline } from "./script";
import type { ScriptStep } from "./tasks";

function step(id: string, overrides: Partial<ScriptStep> = {}): ScriptStep {
  return { id, after: { kind: "seconds", after_s: 60 }, target: { kind: "group" }, body: `body ${id}`, expect_bot: null, expect_plan: null, ...overrides };
}

describe("dueSteps", () => {
  test("a seconds step is due once elapsed reaches it, not a moment before", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 60 } })];
    expect(dueSteps(steps, new Set(), 59_999, false)).toEqual([]);
    expect(dueSteps(steps, new Set(), 60_000, false)).toEqual(steps);
  });

  test("a first_delivery step waits for the flag, not the clock", () => {
    const steps = [step("a", { after: { kind: "first_delivery" } })];
    expect(dueSteps(steps, new Set(), 10 * 60_000, false)).toEqual([]);
    expect(dueSteps(steps, new Set(), 0, true)).toEqual(steps);
  });

  test("a step already fired never comes back, whatever the clock says", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 0 } })];
    expect(dueSteps(steps, new Set(["a"]), 999_999, true)).toEqual([]);
  });

  test("several due steps come back in the task's script order", () => {
    const steps = [
      step("late", { after: { kind: "seconds", after_s: 120 } }),
      step("early", { after: { kind: "seconds", after_s: 0 } }),
    ];
    expect(dueSteps(steps, new Set(), 200_000, false).map((s) => s.id)).toEqual(["late", "early"]);
  });
});

describe("scriptDueBeforeDeadline", () => {
  const taskPostedAtMs = 1_000_000;

  test("nothing pending: null", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 10 } })];
    expect(scriptDueBeforeDeadline(steps, new Set(["a"]), taskPostedAtMs, taskPostedAtMs + 999_999)).toBeNull();
  });

  test("a seconds step still due before the deadline is pending, however far away its own time is", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 150 } })];
    // Due at taskPostedAtMs + 150_000, well before a deadline an hour out.
    expect(scriptDueBeforeDeadline(steps, new Set(), taskPostedAtMs, taskPostedAtMs + 3_600_000)?.id).toBe("a");
  });

  test("a seconds step due only after the deadline is not pending: it will never get to fire", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 150 } })];
    expect(scriptDueBeforeDeadline(steps, new Set(), taskPostedAtMs, taskPostedAtMs + 60_000)).toBeNull();
  });

  test("an unfired first_delivery step never counts as pending here: it might never come, and waiting on it would just run the run out to timeout", () => {
    const steps = [step("a", { after: { kind: "first_delivery" } })];
    expect(scriptDueBeforeDeadline(steps, new Set(), taskPostedAtMs, taskPostedAtMs + 1)).toBeNull();
    expect(scriptDueBeforeDeadline(steps, new Set(["a"]), taskPostedAtMs, taskPostedAtMs + 1)).toBeNull();
  });

  test("a fired step is never pending again", () => {
    const steps = [step("a", { after: { kind: "seconds", after_s: 10 } })];
    expect(scriptDueBeforeDeadline(steps, new Set(["a"]), taskPostedAtMs, taskPostedAtMs + 3_600_000)).toBeNull();
  });

  test("a first_delivery step never masks a seconds step that is genuinely still due", () => {
    const steps = [
      step("delivery", { after: { kind: "first_delivery" } }),
      step("reminder", { after: { kind: "seconds", after_s: 150 } }),
    ];
    expect(scriptDueBeforeDeadline(steps, new Set(), taskPostedAtMs, taskPostedAtMs + 3_600_000)?.id).toBe("reminder");
  });
});

describe("scriptClock", () => {
  test("elapsedMs measures off taskPostedAtMs — under coordinator that clock zero starts well after the run itself did", () => {
    const clock = scriptClock({ taskPostedAtMs: 1_000_000, nowMs: 1_090_000, seeded: new Set(), listing: [], needsFirstDelivery: false });
    expect(clock.elapsedMs).toBe(90_000);
  });

  test("firstDeliverySeen is false when nothing still needs it, whatever the listing says", () => {
    const clock = scriptClock({ taskPostedAtMs: 0, nowMs: 0, seeded: new Set(), listing: ["out.md"], needsFirstDelivery: false });
    expect(clock.firstDeliverySeen).toBe(false);
  });

  test("a workspace with only a map.md (the plan mirror) is not a first delivery", () => {
    const clock = scriptClock({
      taskPostedAtMs: 0,
      nowMs: 0,
      seeded: new Set(),
      listing: ["work/写作-ab12/map.md", "work/写作-ab12/ticket.md"],
      needsFirstDelivery: true,
    });
    expect(clock.firstDeliverySeen).toBe(false);
  });

  test("a genuine new file counts, even alongside seeded and app files", () => {
    const clock = scriptClock({
      taskPostedAtMs: 0,
      nowMs: 0,
      seeded: new Set(["brief.md"]),
      listing: ["brief.md", "work/写作-ab12/map.md", "out.md"],
      needsFirstDelivery: true,
    });
    expect(clock.firstDeliverySeen).toBe(true);
  });
});

describe("resolveBotDirects", () => {
  test("a Bot the Coordinator created mid-run gets its direct with you resolved by name; a name nobody created is left out", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const coordinator = store.createBot({ name: "Coordinator", duties: "hire", boundaries: "stay" });
      // What the Coordinator's own create_bot call does: the runner never sees this Bot being made.
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }, coordinator.bot.id);
      store.createGroup({ name: "发布清单", members: [coordinator.bot.id, writer.bot.id] });
      const directs = resolveBotDirects(store, ["Writer", "Reviewer"]);
      expect(directs).toEqual({ Writer: writer.direct_session.id });
      expect(store.findDirectSession(USER_MEMBER, writer.bot.id)?.id).toBe(directs.Writer);
    } finally {
      store.close();
    }
  });
});
