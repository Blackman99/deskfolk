/**
 * Whether a later model choice followed a review, and whether the work got cleaner afterwards.
 *
 * These are counts over rows the store already has. Nothing here calls a model, and nothing here
 * writes a score back onto a candidate: a conclusion that was followed twice without the work
 * getting cleaner simply leaves the window the picker reads.
 */
import { thinkingLevelRank, type RouteOutcome } from "@real-bot/protocol";
import type { ReviewDirection } from "./route-agent";

/** What one closed chain did, summed across its turns. A null count stays unknown. */
export type ChainWork = {
  chainId: string;
  signature: string;
  model: string;
  thinkingLevel: string;
  /** Sum of recorded hops. Null when any turn in the chain was never counted. */
  hops: number | null;
  /** Sum of recorded tool errors. Null when any turn in the chain was never counted. */
  toolErrors: number | null;
  /** User follow-ups kept against the chain. */
  rounds: number;
  /** True when the chain ended on a completion the endpoint refused or left incomplete. */
  hardFailed: boolean;
};

export type ReviewSubject = {
  chainId: string;
  signature: string;
  model: string;
  thinkingLevel: string;
  direction: ReviewDirection;
  /** User follow-ups the reviewed chain drew. */
  rounds: number;
  /** Tool errors on the reviewed chain. Null when that chain was never counted. */
  toolErrors: number | null;
};

export type FollowedChoice = {
  model: string;
  thinkingLevel: string;
  /** Price of the chosen model on its endpoint. Null when the catalog has no price. */
  price: number | null;
  /** Price of the model the review named, on the same terms. */
  reviewedPrice: number | null;
};

export type FollowVerdict = "followed" | "not_followed" | "unknown";

const HARD_FAILS = new Set(["refused", "incomplete"]);

/** A completion failure the review is worth paying for even when the user never wrote back. */
export function isModelSideFailure(outcome: RouteOutcome | null, failKind: string | null): boolean {
  return outcome === "failed" && failKind !== null && HARD_FAILS.has(failKind);
}

/**
 * A chain with no follow-up is reviewed only when the model side failed outright, or the tools
 * failed at least twice. Zero recorded errors, and errors that were never counted, are not.
 */
export function chainWarrantsReview(input: {
  followUps: number;
  outcome: RouteOutcome | null;
  failKind: string | null;
  toolErrors: number | null;
}): boolean {
  if (input.followUps > 0) return true;
  if (isModelSideFailure(input.outcome, input.failKind)) return true;
  return input.toolErrors !== null && input.toolErrors >= 2;
}

/**
 * Did this choice leave the reviewed model and level, and move the way the review asked?
 *
 * Stronger and lighter compare thinking-level rank. Faster and cheaper compare catalog price, and
 * a missing price on either model is unknown rather than a guess. Same is never a move.
 */
export function choiceFollowed(review: ReviewSubject, choice: FollowedChoice): FollowVerdict {
  const samePair =
    choice.model === review.model &&
    choice.thinkingLevel.toLowerCase() === review.thinkingLevel.toLowerCase();
  if (samePair) return "not_followed";
  if (review.direction === "stronger" || review.direction === "lighter") {
    const next = thinkingLevelRank(choice.thinkingLevel);
    const prior = thinkingLevelRank(review.thinkingLevel);
    if (next === prior) return "not_followed";
    const heavier = next > prior;
    return (review.direction === "stronger") === heavier ? "followed" : "not_followed";
  }
  if (review.direction === "faster" || review.direction === "cheaper") {
    if (choice.price === null || choice.reviewedPrice === null) return "unknown";
    return choice.price < choice.reviewedPrice ? "followed" : "not_followed";
  }
  return "unknown";
}

/**
 * Cleaner means fewer user follow-ups and no more tool errors than the reviewed chain. A chain
 * whose errors were never counted cannot be called cleaner.
 */
export function chainIsCleaner(review: ReviewSubject, later: ChainWork): boolean {
  if (later.toolErrors === null || review.toolErrors === null) return false;
  return later.rounds < review.rounds && later.toolErrors <= review.toolErrors;
}

/**
 * A conclusion leaves the picker after it was followed twice and neither time got cleaner.
 * An unknown follow does not count, so a missing price never retires anything.
 */
/**
 * A later task of the same kind got shorter when it took fewer hops and made no more tool errors.
 * A task that was never counted cannot be called shorter.
 */
export function taskIsShorter(
  prior: { hops: number | null; toolErrors: number | null },
  later: { hops: number | null; toolErrors: number | null },
): boolean {
  if (prior.hops === null || prior.toolErrors === null) return false;
  if (later.hops === null || later.toolErrors === null) return false;
  return later.hops < prior.hops && later.toolErrors <= prior.toolErrors;
}

export function shouldRetire(followed: readonly { followed: FollowVerdict; cleaner: boolean }[]): boolean {
  const kept = followed.filter((row) => row.followed === "followed");
  return kept.length >= 2 && kept.slice(0, 2).every((row) => !row.cleaner);
}
