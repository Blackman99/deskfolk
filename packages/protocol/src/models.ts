/**
 * Fallback thinking levels when a catalog row does not list any. Endpoints may advertise others
 * (`xhigh`, `max`, `minimal`, …) as `reasoning_effort` values; those names are stored and sent as-is.
 */
export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
/** A completion `reasoning_effort` name: the four fallbacks, or whatever the endpoint advertised. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | string;

const THINKING_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  default: 3,
  high: 4,
  xhigh: 5,
  extra_high: 5,
  max: 6,
  maximum: 6,
};

/** Token the completions API will accept as `reasoning_effort`. */
const THINKING_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function isThinkingLevel(value: string): boolean {
  return THINKING_TOKEN.test(value.trim());
}

export function thinkingLevelRank(level: string): number {
  const key = level.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(THINKING_RANK, key)) return THINKING_RANK[key]!;
  return 3.5;
}

/** Dedupes (case-insensitive, first spelling wins) and orders from lightest to heaviest. */
export function sortThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const out: ThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const raw of levels) {
    const level = raw.trim();
    if (!level) continue;
    const key = level.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(level as ThinkingLevel);
  }
  out.sort((a, b) => {
    const delta = thinkingLevelRank(a) - thinkingLevelRank(b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  return out;
}

/** USD per million tokens, captured when a spend row is written. */
export type ModelPricing = { input: number; output: number; cached_input?: number };

/** A completion name with independent routing reference price and optional billing rates. */
export type EndpointModel = {
  name: string;
  price: number | null;
  pricing?: ModelPricing;
  thinking_levels: ThinkingLevel[];
  strengths: string[];
  /** Output token cap each turn hop sends as `max_tokens`, reasoning included; absent uses the daemon's default. */
  max_output?: number;
  /** Measured streaming speed, 10th percentile, in tokens per second; sizes how long one hop may stream. */
  stream_tps_p10?: number;
  /**
   * Tokens the model reads per request, as its server said (a local one, read when the list was
   * fetched or when a prompt came back cut) or as you set it; absent is not known (ADR 0067). A
   * request to a model server on this computer or network clearly bigger than this is not sent.
   */
  context_window?: number;
  /**
   * Whether raising the thinking level actually buys more reasoning past a tool loop's first two
   * hops (the model-probe's measure: none vs high, hop ≥3 reasoning-token share); absent means
   * unmeasured. Stored only for now — P5's escalation ladder reads it before deciding whether to
   * raise a model's thinking level or skip straight to the next model.
   */
  reasoning_effective?: boolean;
  /**
   * Whether the model takes pictures as input (ADR 0049): true or false as you set it (or a probe
   * read it); absent means not known, and is treated as able. From engine level 7 a turn that needs
   * to see pictures only runs on a model not marked false.
   */
  input_image?: boolean;
};

export type EndpointModelInput = string | {
  name: string;
  price?: number | null;
  pricing?: ModelPricing;
  thinking_levels?: ThinkingLevel[];
  strengths?: string[];
  /** Left out, a saved entry keeps the value it had; null clears it. */
  max_output?: number | null;
  stream_tps_p10?: number | null;
  context_window?: number | null;
  reasoning_effective?: boolean | null;
  input_image?: boolean | null;
};

/** One name from an endpoint `GET /models`, plus thinking levels that object advertised. */
export type ProbedModel = {
  name: string;
  thinking_levels: ThinkingLevel[];
  /**
   * What a model server on this computer or network said about the model besides (ADR 0067):
   * Ollama's `/api/tags` and `/api/ps`, LM Studio's `/api/v0/models`, llama.cpp's `/props`. Each is
   * absent when it did not say. `context_window` is the loaded window when the model is loaded,
   * else the model's own limit.
   */
  context_window?: number;
  input_image?: boolean;
  /** False when the server says the model cannot call tools: a Bot cannot work on it. */
  tools?: boolean;
};

/**
 * `POST /v1/providers/:id/speed-test` (ADR 0067): how fast a model writes and whether it calls a
 * tool when offered one. `recorded_tps` is the speed written into its entry as `stream_tps_p10`
 * (a share of the measured one, which a short prompt overstates); null when nothing was recorded.
 * `failed` names how a request failed, when one did.
 */
export type ModelSpeed = {
  tokens_per_second: number | null;
  first_byte_ms: number | null;
  tool_call: boolean | null;
  recorded_tps: number | null;
  failed: string | null;
};

export type ProbeModelsResponse = {
  models: string[];
  catalog: ProbedModel[];
};

/** An endpoint and one of its models, for reading lines (`Settings.reader_model`). */
export type ReaderEndpointModel = { provider_id: string; model: string };

/**
 * A Claude model run through your own Claude Code (ADR 0061), for reading lines: `config_dir` is
 * one of the Claude accounts listed in Settings, null for the daemon's own environment.
 */
export type ReaderClaudeModel = { runner: "claude_code"; model: string; config_dir: string | null };

/** The model that reads lines (`Settings.reader_model`): an endpoint's, or a Claude model of yours. */
export type ReaderModel = ReaderEndpointModel | ReaderClaudeModel;

export function isReaderClaudeModel(value: ReaderModel | null | undefined): value is ReaderClaudeModel {
  return Boolean(value) && "runner" in value!;
}

/**
 * The calls the app makes on its own whose model you choose (ADR 0077), in the order Settings ›
 * Models › Built-in models shows them: reading your lines (读句), keeping the board in order (the
 * organizer, the scribe and the picture checks), the composer's suggestions, and four calls made as
 * a Bot — its judgement of whether to join, its reflection, its retrospective after a delivery and
 * the summary when its context is compacted.
 */
export const BUILTIN_MODEL_ROLES = [
  "reader",
  "organizer",
  "scribe",
  "judge",
  "composer",
  "judgement",
  "reflection",
  "retrospective",
  "compaction",
] as const;
export type BuiltinModelRole = (typeof BUILTIN_MODEL_ROLES)[number];

/** The calls made as a Bot: with no model chosen they run on the Bot's own, not on the default one. */
export const BOT_BUILTIN_MODEL_ROLES: readonly BuiltinModelRole[] = ["judgement", "reflection", "retrospective", "compaction"];

/** Each built-in call's model; null runs it as before you chose one (the default model, or the Bot's). */
export type BuiltinModels = Record<BuiltinModelRole, ReaderModel | null>;

export function isBuiltinModelRole(value: unknown): value is BuiltinModelRole {
  return typeof value === "string" && (BUILTIN_MODEL_ROLES as readonly string[]).includes(value);
}
