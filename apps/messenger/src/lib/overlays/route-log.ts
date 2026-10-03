/**
 * A turn's model choice, in the words the flow board shows it: which model and thinking level the
 * turn ran on, how it ended, what you said about it afterwards and what the review made of that.
 * The records ride on the board's cards; this only turns them into labels.
 */
import type { Bot, Provider, RouteFeedback, RouteLearning, RouteRecord, RouteReview, TaskTraceRoute } from "@real-bot/protocol";

/** How a turn's model choice ended. `live` stands in for a record the daemon has not closed yet. */
export type RouteOutcomeKind =
  | "live"
  | "completed"
  | "failed"
  | "stopped"
  | "redirected"
  | "interrupted";

export type RouteLogLabels = {
  outcome: Record<RouteOutcomeKind, string>;
  /** Who the review held responsible; keyed by `fault`. */
  fault: Record<string, string>;
  /** Which way it said the pick should move; keyed by `direction`. */
  direction: Record<string, string>;
  /** Keyed by message kind (coding / writing / reasoning / simple / general). */
  signature: Record<string, string>;
  /** Keyed by the daemon's `fail_kind`; the same wording the transcript uses. */
  failReason: Record<string, string>;
  thinking: Record<string, string>;
  /** Why it ran on this model (`pin`, `default`, …), from engine level 7; keyed by `reason_code`. */
  reasonCode?: Record<string, string>;
  unknownBot: string;
};

export type RouteLogRow = {
  turnId: string;
  botId: string;
  botName: string;
  /** False once the Bot is deleted: the record stays, the profile link goes away. */
  botKnown: boolean;
  triggerMessageId: string;
  model: string;
  providerName: string | null;
  thinkingLevel: string;
  thinkingLabel: string;
  /** Message kind the choice was made for (`coding` / `writing` / …). */
  signature: string;
  signatureLabel: string;
  outcome: RouteOutcomeKind;
  outcomeLabel: string;
  failReason: string | null;
  /** Tool errors this turn recorded. Null when the process never counted them. */
  toolErrors: number | null;
  /** Completion hops this turn recorded. Null when the process never counted them. */
  hops: number | null;
  feedback: RouteFeedback[];
  /** The one line the agent gave for picking this, when an agent picked it. */
  reason: string | null;
  /** Why it ran on this model without a pick (engine level 7): your pin, the Bot's default, … */
  reasonLabel: string | null;
  /** Whether you marked this turn's trouble as the model's; null where marking is not offered (below level 8). */
  markedModel: boolean | null;
  /** The verdict on the correction chain this turn started, once it has been reviewed. */
  review: {
    faultLabel: string;
    directionLabel: string | null;
    rounds: number;
    reason: string;
    blamedModel: boolean;
    /** What the next same-kind choice did with this conclusion. */
    effect: "followed" | "not_followed" | "unknown" | null;
    /** That later choice also drew fewer follow-ups and no more tool errors. */
    cleaner: boolean;
    /** Left the picker after two follows that did not get cleaner. */
    retired: boolean;
  } | null;
  /** What the learning hop kept for the chain this turn started. */
  learning: { kind: "memory" | "skill" | "none"; label: string } | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type RouteLogInput = {
  bots: readonly Bot[];
  providers: readonly Provider[];
  reviews?: readonly RouteReview[];
  learnings?: readonly RouteLearning[];
  labels: RouteLogLabels;
};

/**
 * One card's model choice. The review and the learning note belong to the chain the turn started,
 * so they only ever arrive on that turn's card.
 */
export function routeCardRow(route: TaskTraceRoute, input: Omit<RouteLogInput, "reviews" | "learnings">): RouteLogRow {
  const row = routeLogRows([route.record], {
    ...input,
    reviews: route.review ? [route.review] : [],
    learnings: route.learning ? [route.learning] : [],
  })[0]!;
  return { ...row, markedModel: route.marked_model ?? null };
}

/** One row per turn, newest first: the daemon lists records oldest-first. */
export function routeLogRows(
  records: readonly RouteRecord[],
  { bots, providers, reviews = [], learnings = [], labels }: RouteLogInput,
): RouteLogRow[] {
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  // A verdict is about the whole chain, so it shows on the turn that started it.
  const reviewByTurn = new Map(reviews.map((review) => [review.turn_id, review]));
  const learningByChain = new Map(learnings.map((learning) => [learning.chain_id, learning]));
  return [...records].reverse().map((record) => {
    const outcome: RouteOutcomeKind = record.outcome ?? "live";
    const name = botNames.get(record.bot_id);
    return {
      turnId: record.turn_id,
      botId: record.bot_id,
      botName: name ?? labels.unknownBot,
      botKnown: name !== undefined,
      triggerMessageId: record.trigger_message_id,
      model: record.model,
      providerName: record.provider_id ? (providerNames.get(record.provider_id) ?? null) : null,
      thinkingLevel: record.thinking_level,
      thinkingLabel: labels.thinking[record.thinking_level] ?? record.thinking_level,
      signature: record.signature,
      signatureLabel: labels.signature[record.signature] ?? record.signature,
      outcome,
      outcomeLabel: labels.outcome[outcome],
      failReason: outcome === "failed" ? failReasonOf(record.fail_kind, labels) : null,
      toolErrors: record.tool_errors,
      hops: record.hops,
      feedback: record.feedback,
      reason: record.reason?.trim() || null,
      reasonLabel: reasonLabelOf(record, labels),
      markedModel: null,
      review: reviewFor(reviewByTurn.get(record.turn_id), labels),
      learning: record.turn_id === record.chain_id ? learningFor(record.chain_id, learningByChain) : null,
      createdAt: record.created_at,
      finishedAt: record.finished_at,
      durationMs: durationOf(record.created_at, record.finished_at),
    };
  });
}

function reviewFor(
  review: RouteReview | undefined,
  labels: RouteLogLabels,
): RouteLogRow["review"] {
  if (!review) return null;
  const blamedModel = review.fault === "model";
  return {
    faultLabel: labels.fault[review.fault] ?? review.fault,
    // Which way to move only means anything when the model was the thing at fault.
    directionLabel: blamedModel ? (labels.direction[review.direction] ?? review.direction) : null,
    rounds: review.rounds,
    reason: review.reason.trim(),
    blamedModel,
    effect: review.effect?.followed ?? null,
    cleaner: review.effect?.cleaner ?? false,
    retired: review.retired_at !== null,
  };
}

function learningFor(
  chainId: string | null,
  byChain: ReadonlyMap<string, RouteLearning>,
): RouteLogRow["learning"] {
  if (!chainId) return null;
  const learning = byChain.get(chainId);
  if (!learning) return null;
  return { kind: learning.kind, label: learning.label };
}

/** Why it ran on this model; stepped up or moved, why the model was chosen first comes before it. */
function reasonLabelOf(record: { reason_code?: string | null; base_reason_code?: string | null }, labels: RouteLogLabels): string | null {
  if (!record.reason_code) return null;
  const label = (code: string) => labels.reasonCode?.[code] ?? code;
  return record.base_reason_code && record.base_reason_code !== record.reason_code
    ? `${label(record.base_reason_code)} · ${label(record.reason_code)}` : label(record.reason_code);
}

function failReasonOf(kind: string | null, labels: RouteLogLabels): string | null {
  if (!kind) return null;
  return labels.failReason[kind] ?? kind;
}

function durationOf(createdAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const start = new Date(createdAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  return Math.max(0, end - start);
}
