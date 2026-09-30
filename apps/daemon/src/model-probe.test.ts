import { describe, expect, test } from "bun:test";
import {
  catalogPatch,
  formatReport,
  hopsReliable,
  percentile10,
  reasoningEffectiveVerdict,
  reasoningShareFromHop3,
  scoreModel,
  type HopSample,
} from "./model-probe";

describe("percentile10", () => {
  test("empty input is null, not NaN or 0", () => {
    expect(percentile10([])).toBeNull();
  });

  test("a single sample is its own p10", () => {
    expect(percentile10([42])).toBe(42);
  });

  test("interpolates between the two closest ranks", () => {
    // 10 sorted values 1..10: rank = 0.1 * 9 = 0.9, between index 0 (1) and 1 (2), weight 0.9.
    expect(percentile10([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(1.9, 5);
  });

  test("unsorted input sorts first", () => {
    expect(percentile10([10, 1, 2])).toBe(percentile10([1, 2, 10]));
  });
});

function hop(n: number, reasoningTokens: number | null): HopSample {
  return { hop: n, reasoningTokens };
}

describe("reasoningShareFromHop3", () => {
  test("only hop 3 and later count; hops 1–2 never move the share", () => {
    const samples = [hop(1, 500), hop(2, 500), hop(3, null), hop(4, null)];
    expect(reasoningShareFromHop3(samples)).toBe(0);
  });

  test("share is hits over hops from 3 on", () => {
    const samples = [hop(1, 100), hop(2, 100), hop(3, 50), hop(4, null), hop(5, 20)];
    expect(reasoningShareFromHop3(samples)).toBeCloseTo(2 / 3, 5);
  });

  test("a loop too short to reach hop 3 reads as 0, not NaN", () => {
    expect(reasoningShareFromHop3([hop(1, 500), hop(2, 500)])).toBe(0);
  });

  test("a null or zero reasoning-token count does not count as reasoning", () => {
    expect(reasoningShareFromHop3([hop(3, 0), hop(4, null)])).toBe(0);
  });
});

describe("reasoningEffectiveVerdict", () => {
  test("a model whose hops 1-2 reasoned on both levels but only 6.7% from hop 3 on at high: under the 20% floor even though it beat none's near-zero — judged false", () => {
    expect(reasoningEffectiveVerdict(0, 0.067)).toBe(false);
  });

  test("high clears the floor but the none/high gap is under 10 points — still false", () => {
    expect(reasoningEffectiveVerdict(0.15, 0.22)).toBe(false);
  });

  test("both thresholds cleared — true", () => {
    expect(reasoningEffectiveVerdict(0.05, 0.9)).toBe(true);
  });

  test("exactly at the gap and floor boundary counts as clearing them (>= not >)", () => {
    expect(reasoningEffectiveVerdict(0.1, 0.2)).toBe(true);
  });

  test("a gap that lands one float tick under the threshold (0.3 - 0.2) still counts as clearing it", () => {
    // 0.3 - 0.2 === 0.09999999999999998 in float, one tick under EFFECTIVE_GAP: this is what
    // --hops 12 (hop 3..12 is 10 of them, so shares land in tenths) produces at an exact 10-point gap.
    expect(0.3 - 0.2 < 0.1).toBe(true);
    expect(reasoningEffectiveVerdict(0.2, 0.3)).toBe(true);
  });
});

describe("hopsReliable", () => {
  test("the full hop budget with no failure is reliable", () => {
    expect(hopsReliable([hop(1, 0), hop(2, 0), hop(3, 50)], 3)).toBe(true);
  });

  test("a loop that broke off short of the budget is not reliable, whether or not it failed outright", () => {
    expect(hopsReliable([hop(1, 0), hop(2, 0)], 3)).toBe(false);
  });

  test("a failed hop is not reliable even if the sample count matches (the loop still stopped there)", () => {
    expect(hopsReliable([hop(1, 0), hop(2, 0), { hop: 3, reasoningTokens: null, failed: true }], 3)).toBe(false);
  });
});

describe("scoreModel", () => {
  test("combines the two thinking levels' shares and the streaming samples' p10", () => {
    const none = [hop(1, 500), hop(2, 500), hop(3, null)];
    const high = [hop(1, 500), hop(2, 500), hop(3, 50), hop(4, 60)];
    const result = scoreModel("grk-4.7-build-fast", none, high, [10, 20, 30]);
    expect(result.model).toBe("grk-4.7-build-fast");
    expect(result.share_none).toBe(0);
    expect(result.share_high).toBe(1);
    expect(result.reasoning_effective).toBe(true);
    expect(result.stream_tps_p10).not.toBeNull();
  });

  test("no streaming samples: stream_tps_p10 is null, and catalogPatch leaves it out rather than sending null", () => {
    const result = scoreModel("m", [], [], []);
    const patch = catalogPatch(result);
    expect(result.stream_tps_p10).toBeNull();
    expect(patch).not.toHaveProperty("stream_tps_p10");
    expect(patch).toMatchObject({ name: "m", reasoning_effective: false });
  });

  test("catalogPatch always states reasoning_effective, even false, so a stale true is not left behind unmerged", () => {
    const result = scoreModel("m", [hop(3, 100)], [hop(3, 100)], [5]);
    expect(catalogPatch(result).reasoning_effective).toBe(false);
  });

  test("a caller that says how many hops it asked for gets null, not a false verdict, when a level broke off early", () => {
    const none = [hop(1, 0), hop(2, 0), hop(3, 0), hop(4, 0), hop(5, 0)];
    const highBrokeOff = [hop(1, 40), { hop: 2, reasoningTokens: null, failed: true }]; // failed before hop 3
    const result = scoreModel("m", none, highBrokeOff, [], 5);
    expect(result.reasoning_effective).toBeNull();
    expect(catalogPatch(result)).not.toHaveProperty("reasoning_effective");
  });

  test("a caller that says how many hops it asked for still gets a real verdict when both levels ran the full budget", () => {
    const none = [hop(1, 0), hop(2, 0), hop(3, 0), hop(4, 0), hop(5, 0)];
    const high = [hop(1, 40), hop(2, 40), hop(3, 40), hop(4, 40), hop(5, 40)];
    const result = scoreModel("m", none, high, [], 5);
    expect(result.reasoning_effective).toBe(true);
  });
});

describe("formatReport", () => {
  test("names the model, the verdict, both shares and the measured speed", () => {
    const report = formatReport([scoreModel("m", [hop(3, null)], [hop(3, 100)], [7])]);
    expect(report).toContain("m");
    expect(report).toContain("true");
    expect(report).toContain("7.0");
  });

  test("an unmeasured speed prints as a dash, not null or NaN", () => {
    expect(formatReport([scoreModel("m", [], [], [])])).toContain("—");
  });

  test("an unreliable run's reasoning_effective prints as a dash, not true or false", () => {
    const result = scoreModel("m", [hop(1, 0), { hop: 2, reasoningTokens: null, failed: true }], [hop(1, 0)], [], 5);
    expect(result.reasoning_effective).toBeNull();
    expect(formatReport([result])).toContain("| m | — |");
  });
});
