import type { TurnEngine } from "./turn-engine";
import type { Store } from "./store";
import { processWake, type WakeWatch } from "./wake";

const TICK_MS = 15_000;

export type Scheduler = {
  tick: (now?: Date) => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
};

export type SchedulerOptions = {
  store: Store;
  engine: TurnEngine;
  intervalMs?: number;
  now?: () => Date;
  wake?: WakeWatch;
};

export function startScheduler(options: SchedulerOptions): Scheduler {
  const intervalMs = options.intervalMs ?? TICK_MS;
  const now = options.now ?? (() => new Date());
  const wake = options.wake ?? processWake();

  let paused = false;
  function tick(at: Date = now()): void {
    if (paused) return;
    try {
      options.engine.sweepStalledTurns(at);
    } catch {
      // a closed store must not stall the routines below
    }
    // The supervisor (ADR 0045) before the appointments below: its state is all in the database,
    // so a tick it misses is made up by the next.
    try {
      options.engine.supervise(at);
    } catch (error) {
      console.error("[supervisor] tick failed", error);
    }
    // With the lid shut macOS wakes itself for a few seconds at a time, often before Wi-Fi is back;
    // a routine fired then fails as unreachable in three seconds and its catch-up is spent.
    if (!wake.settled(at.getTime())) return;
    // External jobs (ADR 0047): the daemon asks the media server itself, once for every waiter.
    try {
      options.engine.pollJobs(at);
    } catch (error) {
      console.error("[jobs] poll failed", error);
    }
    // The narrowed reflection (ADR 0051): one due review miss or ceiling at a time, from level 8.
    try {
      options.engine.reflect(at);
    } catch (error) {
      console.error("[reflection] failed", error);
    }
    for (const routine of options.store.listRoutines()) {
      try {
        options.engine.fireRoutine(routine.id, at);
      } catch {
        // a deleted Bot or a closed store must not stall the rest
      }
    }
    let due: { id: string }[] = [];
    try {
      due = options.store.dueCheckBacks(at);
    } catch {
      due = [];
    }
    for (const row of due) {
      try {
        options.engine.fireCheckBack(row.id, at);
      } catch {
        // a session that is gone, or an engine that is draining, must not stall the rest
      }
    }
  }

  const timer = setInterval(() => tick(), intervalMs);
  tick();

  return {
    tick,
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      clearInterval(timer);
    },
  };
}
