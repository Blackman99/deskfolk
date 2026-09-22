import { expect, test } from "bun:test";
import {
  chainIsCleaner,
  chainWarrantsReview,
  choiceFollowed,
  shouldRetire,
  taskIsShorter,
  type ChainWork,
  type ReviewSubject,
} from "./route-learning";

function review(over: Partial<ReviewSubject> = {}): ReviewSubject {
  return {
    chainId: "c1",
    signature: "coding",
    model: "code-pro",
    thinkingLevel: "medium",
    direction: "stronger",
    rounds: 2,
    toolErrors: 1,
    ...over,
  };
}

function work(over: Partial<ChainWork> = {}): ChainWork {
  return {
    chainId: "c2",
    signature: "coding",
    model: "code-pro",
    thinkingLevel: "high",
    hops: 2,
    toolErrors: 0,
    rounds: 0,
    hardFailed: false,
    ...over,
  };
}

test("a quiet chain is reviewed only for a model-side failure or two tool errors", () => {
  expect(chainWarrantsReview({ followUps: 1, outcome: "completed", failKind: null, toolErrors: 0 })).toBe(true);
  expect(chainWarrantsReview({ followUps: 0, outcome: "failed", failKind: "incomplete", toolErrors: 0 })).toBe(true);
  expect(chainWarrantsReview({ followUps: 0, outcome: "failed", failKind: "refused", toolErrors: 0 })).toBe(true);
  expect(chainWarrantsReview({ followUps: 0, outcome: "completed", failKind: null, toolErrors: 2 })).toBe(true);
  // Unreachable, busy, and a stall are recorded and not paid for.
  expect(chainWarrantsReview({ followUps: 0, outcome: "failed", failKind: "unreachable", toolErrors: 0 })).toBe(false);
  expect(chainWarrantsReview({ followUps: 0, outcome: "failed", failKind: "busy", toolErrors: 1 })).toBe(false);
  expect(chainWarrantsReview({ followUps: 0, outcome: "completed", failKind: null, toolErrors: 0 })).toBe(false);
  // Never counted is not a clean zero.
  expect(chainWarrantsReview({ followUps: 0, outcome: "completed", failKind: null, toolErrors: null })).toBe(false);
});

test("following a review means leaving the named pair in the direction it asked", () => {
  expect(
    choiceFollowed(review(), { model: "code-pro", thinkingLevel: "high", price: 12, reviewedPrice: 12 }),
  ).toBe("followed");
  expect(
    choiceFollowed(review(), { model: "code-pro", thinkingLevel: "medium", price: 12, reviewedPrice: 12 }),
  ).toBe("not_followed");
  expect(
    choiceFollowed(review({ direction: "lighter" }), {
      model: "cheap-chat",
      thinkingLevel: "low",
      price: 1,
      reviewedPrice: 12,
    }),
  ).toBe("followed");
  expect(
    choiceFollowed(review({ direction: "cheaper" }), {
      model: "cheap-chat",
      thinkingLevel: "low",
      price: 1,
      reviewedPrice: 12,
    }),
  ).toBe("followed");
  // No price on either side is not a guess.
  expect(
    choiceFollowed(review({ direction: "faster" }), {
      model: "other",
      thinkingLevel: "low",
      price: null,
      reviewedPrice: 12,
    }),
  ).toBe("unknown");
});

test("cleaner is fewer follow-ups and no more tool errors, and uncounted is not cleaner", () => {
  expect(chainIsCleaner(review(), work({ rounds: 1, toolErrors: 1 }))).toBe(true);
  expect(chainIsCleaner(review(), work({ rounds: 2, toolErrors: 0 }))).toBe(false);
  expect(chainIsCleaner(review(), work({ rounds: 0, toolErrors: 3 }))).toBe(false);
  expect(chainIsCleaner(review(), work({ toolErrors: null }))).toBe(false);
  expect(chainIsCleaner(review({ toolErrors: null }), work())).toBe(false);
});

test("shorter means fewer hops and no more tool errors", () => {
  expect(taskIsShorter({ hops: 4, toolErrors: 2 }, { hops: 2, toolErrors: 1 })).toBe(true);
  expect(taskIsShorter({ hops: 4, toolErrors: 2 }, { hops: 2, toolErrors: 3 })).toBe(false);
  expect(taskIsShorter({ hops: 4, toolErrors: 2 }, { hops: 4, toolErrors: 0 })).toBe(false);
  expect(taskIsShorter({ hops: null, toolErrors: 2 }, { hops: 1, toolErrors: 0 })).toBe(false);
});

test("a conclusion retires after two follows that were not cleaner", () => {
  expect(
    shouldRetire([
      { followed: "followed", cleaner: false },
      { followed: "followed", cleaner: false },
    ]),
  ).toBe(true);
  expect(
    shouldRetire([
      { followed: "followed", cleaner: true },
      { followed: "followed", cleaner: false },
    ]),
  ).toBe(false);
  // An unknown follow never counts toward retiring.
  expect(
    shouldRetire([
      { followed: "unknown", cleaner: false },
      { followed: "followed", cleaner: false },
      { followed: "not_followed", cleaner: false },
    ]),
  ).toBe(false);
});
