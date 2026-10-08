/** One endpoint call the ledger records. */
export type SpendKind =
  | "turn"
  | "judgement"
  | "route_pick"
  | "route_review"
  | "route_learn"
  | "composer_suggest"
  | "organize"
  | "acceptance_check";

/**
 * What a call was for, where its kind is shared (ADR 0042): the scribe bills as `organize`, a
 * judgement of pictures (a `continuity` check looking at frames) as `acceptance_check`, and a
 * reflection, once there is one, as `organize`, and so does reading a line for what the app acts
 * on (`reader`, ADR 0055) and a Bot's retrospective of a delivered plan (`retrospect`, ADR 0062).
 * The kind stays the nearest old value, so an older build still reads the row; every other row has
 * no purpose.
 */
export type SpendPurpose = "scribe" | "vision" | "reflect" | "reader" | "retrospect";

export const SPEND_PURPOSE_KIND: Record<SpendPurpose, SpendKind> = {
  scribe: "organize",
  vision: "acceptance_check",
  reflect: "organize",
  reader: "organize",
  retrospect: "organize",
};

/** One line of the view's breakdown: a kind, or a purpose split out of the kind it bills as. */
export type SpendLine = SpendKind | SpendPurpose;

export function spendLineOf(row: { kind: SpendKind; purpose?: SpendPurpose | null }): SpendLine {
  return row.purpose ?? row.kind;
}

/**
 * How the view groups lines. Decision is the pick before a turn and the organizer's filing of
 * a message; feedback is the review, the learning hop, a reflection and a retrospective; a composer suggestion,
 * the scribe and an acceptance check's calls belong to neither and are "other".
 */
export type SpendCategory = "turn" | "judgement" | "decision" | "feedback" | "other";

export const SPEND_CATEGORY_OF: Record<SpendLine, SpendCategory> = {
  turn: "turn",
  judgement: "judgement",
  route_pick: "decision",
  route_review: "feedback",
  route_learn: "feedback",
  composer_suggest: "other",
  organize: "decision",
  acceptance_check: "other",
  scribe: "other",
  vision: "other",
  reflect: "feedback",
  reader: "other",
  retrospect: "feedback",
};

/**
 * Filters for the ledger. An absent field means "any". `bot_id` and `model` use `null` for the
 * unassigned / unrecorded group. `to` is exclusive. A `kind` entry is a line: a purpose names
 * the rows of that purpose, a kind the rows of that kind that have none (`organize` is the
 * organizer's own calls, not the scribe's).
 */
export type SpendFilter = {
  from?: string;
  to?: string;
  kind?: SpendLine[];
  bot_id?: string | null;
  session_id?: string;
  model?: string | null;
  provider_id?: string;
  turn_id?: string;
};

export type SpendSummaryQuery = SpendFilter & {
  group_by?: "model" | "session" | "bot" | "kind" | "day";
  /** IANA zone. Day buckets are cut in this zone, not SQLite's. */
  tz?: string;
};

/**
 * Sums ignore null. A field that no row reported stays null — it is not zero. An empty set is
 * all null. `missing_calls` had neither a reported nor an estimated amount; `missing_usage_calls`
 * had no usage token fields.
 */
export type SpendTotals = {
  calls: number;
  input_tokens: number | null;
  cached_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  reported_usd_ticks: number | null;
  estimated_usd_ticks: number | null;
  reported_calls: number;
  estimated_calls: number;
  missing_calls: number;
  missing_usage_calls: number;
};

/** One line's totals; `kind` is the line (a purpose where the row has one). */
export type SpendKindSummary = SpendTotals & { kind: SpendLine };

export type SpendCategorySummary = SpendTotals & {
  category: SpendCategory;
  kinds: SpendKindSummary[];
};

/**
 * One bucket of a summary. `id` is opaque for a model (provider + model), the session or bot id,
 * the kind string, or `YYYY-MM-DD` for a day. A null model is one group. A null bot is
 * unassigned, not deleted. Day groups carry category totals so a trend can stack them; reported
 * and estimated amounts stay separate.
 */
export type SpendGroup = SpendTotals & {
  id: string | null;
  name: string | null;
  deleted: boolean;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  categories: SpendCategorySummary[];
};

export type SpendSummary = {
  totals: SpendTotals;
  groups: SpendGroup[];
  categories: SpendCategorySummary[];
};

export type Spend = {
  id: string;
  session_id: string;
  /** Snapshot of the session name at insertion. */
  session_name: string | null;
  bot_id: string | null;
  /** Snapshot of the bot name at insertion. Null when the call was not a bot's. */
  bot_name: string | null;
  turn_id: string | null;
  judgement_id: string | null;
  kind: SpendKind;
  /** Absent from a daemon older than ADR 0042. */
  purpose?: SpendPurpose | null;
  chain_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  thinking_level: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd_ticks: number | null;
  estimated_cost_usd_ticks: number | null;
  missing_reason: "stream_interrupted" | "endpoint_omitted" | null;
  created_at: string;
};

/** A ledger row plus whether the session or bot it names is gone, and the message that woke it. */
export type SpendDetail = Spend & {
  trigger_message_id: string | null;
  session_deleted: boolean;
  bot_deleted: boolean;
};

export type SpendPage = {
  items: SpendDetail[];
  next: string | null;
};
