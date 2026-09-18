import type { Bot, Provider, RouteFeedback, RouteRecord } from "@real-bot/protocol";

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
  /** Keyed by message kind (coding / writing / reasoning / simple / general). */
  signature: Record<string, string>;
  /** Keyed by the daemon's `fail_kind`; the same wording the transcript uses. */
  failReason: Record<string, string>;
  thinking: Record<string, string>;
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
  thinkingLabel: string;
  signatureLabel: string;
  outcome: RouteOutcomeKind;
  outcomeLabel: string;
  failReason: string | null;
  feedback: RouteFeedback[];
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type RouteLogInput = {
  bots: readonly Bot[];
  providers: readonly Provider[];
  labels: RouteLogLabels;
};

/**
 * One row per turn, newest first. The daemon lists records oldest-first; the panel reads the other
 * way round, because the choice you want to check is the one that just ran.
 */
export function routeLogRows(
  records: readonly RouteRecord[],
  { bots, providers, labels }: RouteLogInput,
): RouteLogRow[] {
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
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
      thinkingLabel: labels.thinking[record.thinking_level] ?? record.thinking_level,
      signatureLabel: labels.signature[record.signature] ?? record.signature,
      outcome,
      outcomeLabel: labels.outcome[outcome],
      failReason: outcome === "failed" ? failReasonOf(record.fail_kind, labels) : null,
      feedback: record.feedback,
      createdAt: record.created_at,
      finishedAt: record.finished_at,
      durationMs: durationOf(record.created_at, record.finished_at),
    };
  });
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
