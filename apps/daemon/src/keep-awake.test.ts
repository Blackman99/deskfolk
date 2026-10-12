import { afterEach, describe, expect, test } from "bun:test";
import type { CompletionResult } from "./completions";
import { keepAwake } from "./keep-awake";
import { startScheduler } from "./scheduler";
import type { Store } from "./store";
import { call, createScenario, endTurn, say, type Scenario } from "./test-kit/scenario";
import type { TurnEngine } from "./turn-engine";
import type { WakeWatch } from "./wake";

function fakeSpawn() {
  const started: Array<{ cmd: string[]; killed: boolean; exit: () => void }> = [];
  const spawn = (cmd: string[]) => {
    let exit = () => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const entry = { cmd, killed: false, exit };
    started.push(entry);
    return {
      kill: () => {
        entry.killed = true;
        exit();
      },
      exited,
    };
  };
  return { started, spawn };
}

describe("keeping the Mac awake while work is under way", () => {
  test("one caffeinate for as long as work is under way, tied to the daemon, and gone when it ends", () => {
    const { started, spawn } = fakeSpawn();
    const awake = keepAwake({ platform: "darwin", pid: 4242, spawn });
    awake.update(false);
    expect(started).toEqual([]);
    awake.update(true);
    awake.update(true);
    expect(started.map((entry) => entry.cmd)).toEqual([["/usr/bin/caffeinate", "-s", "-w", "4242"]]);
    awake.update(false);
    expect(started[0]!.killed).toBe(true);
    awake.update(true);
    expect(started).toHaveLength(2);
    awake.stop();
    expect(started[1]!.killed).toBe(true);
  });

  test("a caffeinate that went away by itself is started again at the next busy tick", async () => {
    const { started, spawn } = fakeSpawn();
    const awake = keepAwake({ platform: "darwin", pid: 1, spawn });
    awake.update(true);
    started[0]!.exit();
    await Promise.resolve();
    awake.update(true);
    expect(started).toHaveLength(2);
    awake.stop();
  });

  test("off the Mac nothing is started", () => {
    const { started, spawn } = fakeSpawn();
    const awake = keepAwake({ platform: "win32", spawn });
    awake.update(true);
    expect(started).toEqual([]);
  });
});

describe("the scheduler's tick", () => {
  test("tells keep-awake whether work is under way, and stopping the scheduler lets go", () => {
    let busy = true;
    const seen: boolean[] = [];
    let stopped = 0;
    const scheduler = startScheduler({
      store: { workUnderWay: () => busy, listRoutines: () => [], dueCheckBacks: () => [] } as unknown as Store,
      engine: { sweepStalledTurns() {}, capSpend() {}, supervise() {}, pollJobs() {}, reflect() {}, retrospect() {} } as unknown as TurnEngine,
      intervalMs: 3_600_000,
      wake: { settled: () => true } as WakeWatch,
      keepAwake: { update: (value) => void seen.push(value), stop: () => void (stopped += 1) },
    });
    busy = false;
    scheduler.tick();
    scheduler.stop();
    expect(seen).toEqual([true, false]);
    expect(stopped).toBe(1);
  });
});

describe("work under way", () => {
  const open: Scenario[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!.close();
  });

  test("a running turn is; one waiting on nothing but you, or none at all, is not", async () => {
    const h = await createScenario();
    open.push(h);
    const [writer] = h.createBots("写手");
    const dm = h.direct(writer!);
    expect(h.store.workUnderWay()).toBe(false);
    let mid = false;
    let answer: (result: CompletionResult) => void = () => {};
    h.script(writer!, dm).reply(() => {
      mid = true;
      return new Promise<CompletionResult>((resolve) => (answer = resolve));
    }, call(endTurn()));
    h.postUser(dm, "把第一章写完");
    await h.waitFor(() => mid, { what: "the turn to be mid-hop" });
    expect(h.store.workUnderWay()).toBe(true);
    answer(say("写完了"));
    await h.waitIdle();
    expect(h.store.workUnderWay()).toBe(false);
  });
});
