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

export type WakeWatch = {
  /** False until {@link WAKE_SETTLE_MS} after the latest wake. */
  settled: (at?: number) => boolean;
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
  let last = now();
  let settledAt = -Infinity;

  // Queries observe too: an overdue timer can fire before the heartbeat does, right after a wake.
  function observe(): void {
    const at = now();
    if (at - last > gapMs) {
      settledAt = at + settleMs;
    }
    last = at;
  }

  function settled(at: number = now()): boolean {
    observe();
    return at >= settledAt;
  }

  const beat = options.heartbeat === false ? null : setInterval(observe, options.beatMs ?? BEAT_MS);
  (beat as { unref?: () => void } | null)?.unref?.();

  return {
    settled,
    stop() {
      if (beat) clearInterval(beat);
    },
  };
}

let shared: WakeWatch | null = null;

/** The daemon's one watch: sleep is a fact about the whole process. */
export function processWake(): WakeWatch {
  shared ??= createWakeWatch();
  return shared;
}
