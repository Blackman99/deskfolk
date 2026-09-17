import type { TurnEngine } from "./turn-engine";
import type { Store } from "./store";

const TICK_MS = 15_000;

export type Scheduler = {
  tick: (now?: Date) => void;
  stop: () => void;
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

  function tick(at: Date = now()): void {
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
    stop() {
      clearInterval(timer);
    },
  };
}
