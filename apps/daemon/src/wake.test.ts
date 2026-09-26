import { describe, expect, test } from "bun:test";
import { createWakeWatch } from "./wake";

describe("wake watch", () => {
  /** A watch on a hand-moved clock; `awake` walks it forward in heartbeat steps, `sleep` jumps. */
  function manual() {
    let clock = 1_000_000;
    const wake = createWakeWatch({ now: () => clock, beatMs: 5_000, settleMs: 60_000, heartbeat: false });
    return {
      wake,
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

  test("a late heartbeat is sleep, and the network gets a minute before the watch is settled", () => {
    const m = manual();
    m.awake(10_000);
    expect(m.wake.settled()).toBe(true);

    // Thirty minutes without a beat: the lid was shut.
    m.sleep(30 * 60_000);

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
  });
});
