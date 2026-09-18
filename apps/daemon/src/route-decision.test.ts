import { describe, expect, test } from "bun:test";
import {
  CRITIQUE_WEIGHT,
  FAILURE_WEIGHT,
  PENALTY_CAP,
  POSITIVE_RELIEF,
  applySignal,
  effectivePenalty,
  emptyLearnedState,
  penaltyFor,
} from "./route-decision";

describe("route experience", () => {
  const key = { signature: "coding", model: "code-pro", thinkingLevel: "medium" };

  test("negatives accumulate per key and positives pay them back at the relief rate", () => {
    let learned = applySignal(emptyLearnedState(), key, { negative: CRITIQUE_WEIGHT });
    learned = applySignal(learned, key, { negative: FAILURE_WEIGHT });
    expect(learned.entries).toEqual([{ ...key, negative: 1.5, positive: 0 }]);
    expect(penaltyFor(learned, "coding", "code-pro", "medium")).toBe(1.5);
    for (let i = 0; i < 6; i++) learned = applySignal(learned, key, { positive: 1 });
    expect(penaltyFor(learned, "coding", "code-pro", "medium")).toBeCloseTo(1.5 - 6 * POSITIVE_RELIEF);
    for (let i = 0; i < 10; i++) learned = applySignal(learned, key, { positive: 1 });
    expect(penaltyFor(learned, "coding", "code-pro", "medium")).toBe(0);
  });

  test("a penalty never exceeds the cap, so a pick can climb back", () => {
    expect(effectivePenalty({ negative: 40, positive: 0 })).toBe(PENALTY_CAP);
    expect(effectivePenalty({ negative: 40, positive: 200 })).toBe(0);
  });

  test("a wildcard level counts against every level of that model; other keys stay untouched", () => {
    const learned = applySignal(emptyLearnedState(), { ...key, thinkingLevel: "*" }, { negative: 1 });
    expect(penaltyFor(learned, "coding", "code-pro", "high")).toBe(1);
    expect(penaltyFor(learned, "coding", "code-pro", "medium")).toBe(1);
    expect(penaltyFor(learned, "writing", "code-pro", "medium")).toBe(0);
    expect(penaltyFor(learned, "coding", "cheap-chat", "medium")).toBe(0);
  });

  test("applySignal does not mutate the state it was given", () => {
    const before = applySignal(emptyLearnedState(), key, { negative: 1 });
    const after = applySignal(before, key, { positive: 1 });
    expect(before.entries[0]).toEqual({ ...key, negative: 1, positive: 0 });
    expect(after.entries[0]).toEqual({ ...key, negative: 1, positive: 1 });
  });
});
