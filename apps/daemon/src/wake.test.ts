import { describe, expect, test } from "bun:test";
import { createWakeWatch } from "./wake";

/** Blocks the event loop the way sleep freezes the process: no timer fires until it returns. */
function freeze(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

describe("wake watch", () => {
  /** A watch on a hand-moved clock; `awake` walks it forward in heartbeat steps, `sleep` jumps. */
  function manual() {
    let clock = 1_000_000;
    const wake = createWakeWatch({ now: () => clock, beatMs: 5_000, settleMs: 60_000, heartbeat: false });
    return {
      wake,
      at: () => clock,
      awake(ms: number) {
        for (let left = ms; left > 0; left -= 5_000) {
          clock += Math.min(5_000, left);
          wake.settled();
        }
      },
      sleep(ms: number) {
        clock += ms;
      },
    };
  }

  test("a late heartbeat is sleep, and only the time inside it is credited", () => {
    const m = manual();
    m.awake(10_000);
    expect(m.wake.sleptBetween(0)).toBe(0);
    expect(m.wake.settled()).toBe(true);

    // Thirty minutes without a beat: the lid was shut.
    const before = m.at();
    m.sleep(30 * 60_000);
    expect(m.wake.sleptBetween(before - 60_000)).toBe(30 * 60_000);
    // A turn that last moved halfway through the sleep is only owed the second half.
    expect(m.wake.sleptBetween(before + 15 * 60_000)).toBe(15 * 60_000);
    // Something that started after the wake was never asleep.
    expect(m.wake.sleptBetween(m.at())).toBe(0);

    expect(m.wake.settled()).toBe(false);
    m.awake(55_000);
    expect(m.wake.settled()).toBe(false);
    m.awake(5_000);
    expect(m.wake.settled()).toBe(true);
  });

  test("a second sleep before the network settled starts the wait again", () => {
    const m = manual();
    m.sleep(10 * 60_000);
    expect(m.wake.settled()).toBe(false);
    m.awake(5_000); // a five-second maintenance wake, then asleep again
    m.sleep(17 * 60_000);
    expect(m.wake.settled()).toBe(false);
    m.awake(55_000);
    expect(m.wake.settled()).toBe(false);
    m.awake(5_000);
    expect(m.wake.settled()).toBe(true);
    expect(m.wake.sleptBetween(0)).toBe(27 * 60_000);
  });

  test("untilSettled waits out the settle and gives up on abort", async () => {
    const wake = createWakeWatch({ beatMs: 5, settleMs: 80 });
    try {
      freeze(40);
      expect(wake.settled()).toBe(false);
      const started = Date.now();
      expect(await wake.untilSettled()).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(60);

      freeze(40);
      const abort = new AbortController();
      const waiting = wake.untilSettled(abort.signal);
      abort.abort();
      expect(await waiting).toBe(false);
    } finally {
      wake.stop();
    }
  });

  test("awakeTimeout does not count time the process spent frozen", async () => {
    const wake = createWakeWatch({ beatMs: 10 });
    try {
      let fired = 0;
      wake.awakeTimeout(150, () => {
        fired += 1;
      });
      freeze(400);
      await Bun.sleep(40);
      // A plain setTimeout would have fired as soon as the freeze ended.
      expect(fired).toBe(0);
      await Bun.sleep(250);
      expect(fired).toBe(1);
    } finally {
      wake.stop();
    }
  });

  test("awakeTimeout fires on time when nothing slept, and cancels", async () => {
    const wake = createWakeWatch({ beatMs: 10 });
    try {
      let fired = 0;
      wake.awakeTimeout(30, () => {
        fired += 1;
      });
      const cancel = wake.awakeTimeout(30, () => {
        fired += 10;
      });
      cancel();
      await Bun.sleep(80);
      expect(fired).toBe(1);
    } finally {
      wake.stop();
    }
  });
});
