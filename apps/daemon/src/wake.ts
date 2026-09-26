/**
 * What the runtime can tell about macOS sleep. Every clock Bun offers keeps counting while the Mac
 * sleeps, so a process that was frozen wakes to find each of its timers overdue at once: the stall
 * sweep, the stream watchdogs and the shell timeout all fire in the same instant, often inside a
 * few-second maintenance wake with the lid still shut and the network not back yet. The only sign
 * is a heartbeat that arrives late, so that is what this watches.
 */

const BEAT_MS = 5_000;
/** How long after a wake the network is given to come back before work that needs it goes out. */
export const WAKE_SETTLE_MS = 60_000;
/** Sleeps older than this no longer matter to anything still running. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

export type WakeWatch = {
  /** Wall-clock ms the Mac spent asleep between two instants, as far as the heartbeat saw. */
  sleptBetween: (from: number, to?: number) => number;
  /** False until {@link WAKE_SETTLE_MS} after the latest wake. */
  settled: (at?: number) => boolean;
  /** Resolves true once settled, however many more sleeps that takes; false when aborted first. */
  untilSettled: (signal?: AbortSignal) => Promise<boolean>;
  /** A `setTimeout` that only counts the time the Mac was awake. Returns its cancel. */
  awakeTimeout: (ms: number, fn: () => void) => () => void;
  stop: () => void;
};

export type WakeWatchOptions = {
  now?: () => number;
  /** Heartbeat period; a beat more than three periods late means the process was frozen. */
  beatMs?: number;
  settleMs?: number;
  /**
   * Off only in tests that move `now` by hand: every query is then the heartbeat, and any quiet
   * stretch in real time would read as sleep.
   */
  heartbeat?: boolean;
};

export function createWakeWatch(options: WakeWatchOptions = {}): WakeWatch {
  const now = options.now ?? Date.now;
  const gapMs = (options.beatMs ?? BEAT_MS) * 3;
  const settleMs = options.settleMs ?? WAKE_SETTLE_MS;
  const sleeps: Array<{ from: number; to: number }> = [];
  let last = now();
  let settledAt = -Infinity;

  // Queries observe too: an overdue timer can fire before the heartbeat does, right after a wake.
  function observe(): void {
    const at = now();
    if (at - last > gapMs) {
      sleeps.push({ from: last, to: at });
      settledAt = at + settleMs;
      while (sleeps.length > 0 && sleeps[0]!.to < at - KEEP_MS) sleeps.shift();
    }
    last = at;
  }

  function sleptBetween(from: number, to: number = now()): number {
    observe();
    let total = 0;
    for (const sleep of sleeps) {
      total += Math.max(0, Math.min(sleep.to, to) - Math.max(sleep.from, from));
    }
    return total;
  }

  function settled(at: number = now()): boolean {
    observe();
    return at >= settledAt;
  }

  const beat = options.heartbeat === false ? null : setInterval(observe, options.beatMs ?? BEAT_MS);
  (beat as { unref?: () => void } | null)?.unref?.();

  return {
    sleptBetween,
    settled,
    async untilSettled(signal) {
      while (!signal?.aborted) {
        if (settled()) return true;
        // A sleep during this wait moves the settle point on, so look again rather than trust it.
        await pause(settledAt - now(), signal);
      }
      return false;
    },
    awakeTimeout(ms, fn) {
      const startedAt = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (delay: number) => {
        timer = setTimeout(() => {
          const at = now();
          const left = ms - (at - startedAt - sleptBetween(startedAt, at));
          if (left > 0) arm(left);
          else fn();
        }, delay);
      };
      arm(ms);
      return () => clearTimeout(timer);
    },
    stop() {
      if (beat) clearInterval(beat);
    },
  };
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

let shared: WakeWatch | null = null;

/** The daemon's one watch: sleep is a fact about the whole process. */
export function processWake(): WakeWatch {
  shared ??= createWakeWatch();
  return shared;
}
