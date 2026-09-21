import type { TurnEngine } from "./turn-engine";
import type { Store } from "./store";

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
};

export function startScheduler(options: SchedulerOptions): Scheduler {
  const intervalMs = options.intervalMs ?? TICK_MS;
  const now = options.now ?? (() => new Date());

  let paused = false;
  function tick(at: Date = now()): void {
    if (paused) return;
    try {
      options.engine.sweepStalledTurns(at);
    } catch {
      // a closed store must not stall the routines below
    }
    for (const routine of options.store.listRoutines()) {
      try {
        options.engine.fireRoutine(routine.id, at);
      } catch {
        // a deleted Bot or a closed store must not stall the rest
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
