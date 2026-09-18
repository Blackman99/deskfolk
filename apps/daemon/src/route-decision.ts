import {
  THINKING_LEVELS,
  thinkingLevelRank,
  type EndpointModel,
  type ThinkingLevel,
} from "@real-bot/protocol";

export type CatalogEntry = EndpointModel & {
  providerId: string;
};

/**
 * One Bot's experience with one (message kind, model, thinking level) choice: how much evidence
 * says "this pick was wrong" (`negative`) and how many turns finished fine on it (`positive`).
 * Experience belongs to a Bot; a Reviewer's complaint never re-routes a Writer.
 */
export type RouteExperience = {
  signature: string;
  model: string;
  /** A concrete level, or `*` for "every level of this model". */
  thinkingLevel: string;
  negative: number;
  positive: number;
};

export type RouteLearnedState = {
  entries: RouteExperience[];
};

/** A user critique of the model choice itself. */
export const CRITIQUE_WEIGHT = 1;
/** A completion the model itself botched (refused the request, incomplete reply). */
export const FAILURE_WEIGHT = 0.5;
/** Each turn that finishes cleanly on the same pick pays this much of the penalty back. */
export const POSITIVE_RELIEF = 0.25;
/** No pick sinks further than this, so it can climb back once alternatives also disappoint. */
export const PENALTY_CAP = 3;
/** Score points taken per unit of penalty; one critique outweighs a matched strength tag (+4). */
export const PENALTY_WEIGHT = 10;

export type RouteSignal = { negative?: number; positive?: number };

export type RouteDecision = {
  model: string;
  thinkingLevel: ThinkingLevel;
  providerId: string;
  signature: string;
};

export type MessageKind = "coding" | "writing" | "reasoning" | "simple" | "general";

const STRENGTH_TAGS: Record<MessageKind, string[]> = {
  coding: ["code", "coding", "debug", "bug", "program", "代码", "编程", "调试"],
  writing: ["write", "writing", "docs", "copy", "文案", "写作", "翻译", "translate"],
  reasoning: ["reason", "reasoning", "analysis", "math", "plan", "推理", "分析", "规划"],
  simple: ["chat", "fast", "cheap", "闲聊"],
  general: ["general", "通用"],
};

export function emptyLearnedState(): RouteLearnedState {
  return { entries: [] };
}

/** Penalty a single experience row contributes: negatives net of relief, floored at 0, capped. */
export function effectivePenalty(row: Pick<RouteExperience, "negative" | "positive">): number {
  const raw = row.negative - POSITIVE_RELIEF * row.positive;
  return Math.max(0, Math.min(PENALTY_CAP, raw));
}

export function classifyMessage(text: string): MessageKind {
  const t = text.toLowerCase();
  if (
    /(```|function\b|typescript|javascript|python|refactor|implement|compile|typeerror|代码|重构|实现|编程)/.test(
      t,
    )
  ) {
    return "coding";
  }
  if (/\b(debug|stack trace|exception)\b|调试|报错/.test(t)) return "coding";
  if (/\b(bug|fix)\b/.test(t) && !isCritiqueMessage(text)) return "coding";
  if (/(证明|推理|分析为什么|architecture|架构|complex|复杂|深入|数学|prove|theorem)/.test(t)) {
    return "reasoning";
  }
  if (/(translate|翻译|文案|报告|write a|写一篇|poem|诗)/.test(t)) return "writing";
  if (/(^|\s)(hi|hello|hey|thanks|谢谢|你好|嗨)(\s|[!！。.?？]|$)/.test(t) || t.length < 12) {
    return "simple";
  }
  if (/(仔细|difficult|很难|hard problem|认真)/.test(t)) return "reasoning";
  return "general";
}

export function messageSignature(text: string): string {
  return classifyMessage(text);
}

/**
 * True only when the user is talking about the model choice itself (which model, how hard it
 * thought, speed, cost, hallucination). Generic complaints about the reply's content ("不对",
 * "有问题", "broken") are not route feedback: a wrong @-mention or a bad plan says nothing about
 * which model should have been picked.
 */
export function isCritiqueMessage(text: string): boolean {
  return /(选的模型|换个模型|换模型|换一个模型|模型不对|模型不行|模型太|太慢|太浅|太贵|太笨|不够聪明|想得太少|幻觉|wrong model|(switch|change|use) (to )?(a |the )?(different |another |smarter |better )?model|(the )?model (was|is) (wrong|bad)|too slow|too shallow|too expensive|think(s|ing)? harder|hallucinat)/i.test(
    text,
  );
}

export function pickThinkingLevel(kind: MessageKind, supported: readonly ThinkingLevel[]): ThinkingLevel {
  const levels = supported.length > 0 ? [...supported] : [...THINKING_LEVELS];
  const target =
    kind === "simple" ? 0 : kind === "coding" ? 3 : kind === "reasoning" ? 6 : 2;
  const preferHigher = kind === "coding" || kind === "reasoning";
  let best = levels[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const rank = thinkingLevelRank(level);
    const dist = Math.abs(rank - target);
    const better =
      dist < bestDist ||
      (dist === bestDist &&
        (preferHigher ? rank > thinkingLevelRank(best) : rank < thinkingLevelRank(best)));
    if (!better) continue;
    best = level;
    bestDist = dist;
  }
  return best;
}

/**
 * Which catalog rows a turn may pick from.
 *
 * - A pinned endpoint scopes to that endpoint; a pinned model that is still listed there
 *   constrains the name (a pin listed only elsewhere yields nothing, so the caller falls back).
 * - Without a pinned endpoint the Bot lives on the default endpoint: adding another endpoint in
 *   settings must not make its models eligible for every unpinned Bot. Only a pinned model that
 *   is not on the default endpoint reaches across (preferring the default endpoint's copy when
 *   several endpoints list the same name).
 * - With no default endpoint known (legacy state) the whole catalog stays open.
 */
export function candidateRows(input: {
  catalog: readonly CatalogEntry[];
  botModel: string | null;
  botProviderId: string | null;
  defaultProviderId: string | null;
}): CatalogEntry[] {
  const { catalog, botModel, botProviderId, defaultProviderId } = input;
  const pinListed = botModel !== null && catalog.some((row) => row.name === botModel);
  if (botProviderId) {
    const scoped = catalog.filter((row) => row.providerId === botProviderId);
    return pinListed ? scoped.filter((row) => row.name === botModel) : scoped;
  }
  if (pinListed) {
    const rows = catalog.filter((row) => row.name === botModel);
    const home = rows.filter((row) => row.providerId === defaultProviderId);
    return home.length > 0 ? home : rows;
  }
  if (!defaultProviderId) return [...catalog];
  return catalog.filter((row) => row.providerId === defaultProviderId);
}

export function decideCompletion(input: {
  text: string;
  catalog: readonly CatalogEntry[];
  botModel: string | null;
  botProviderId?: string | null;
  /** The roster's default endpoint; an unpinned Bot only picks from its list. */
  defaultProviderId?: string | null;
  /** A Bot's pinned level wins for any candidate model that supports it; other models keep their own list. */
  botThinkingLevel?: ThinkingLevel | null;
  learned: RouteLearnedState;
}): RouteDecision | null {
  const candidates = candidateRows({
    catalog: input.catalog,
    botModel: input.botModel,
    botProviderId: input.botProviderId ?? null,
    defaultProviderId: input.defaultProviderId ?? null,
  });
  if (candidates.length === 0) return null;

  const kind = classifyMessage(input.text);
  const signature = kind;
  let best: RouteDecision | null = null;
  let bestScore = -Infinity;
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]!;
    const supported =
      model.thinking_levels.length > 0 ? model.thinking_levels : [...THINKING_LEVELS];
    const pinnedLevel = matchThinkingLevel(supported, input.botThinkingLevel);
    const levels: readonly ThinkingLevel[] = pinnedLevel ? [pinnedLevel] : supported;
    const preferred = pickThinkingLevel(kind, levels);
    for (const thinkingLevel of levels) {
      const score =
        scoreCandidate(model, kind, thinkingLevel, signature, input.learned) +
        (thinkingLevel === preferred ? 1 : 0);
      const price = model.price ?? Number.POSITIVE_INFINITY;
      const better =
        score > bestScore ||
        (score === bestScore && price < bestPrice) ||
        (score === bestScore && price === bestPrice && i < bestIndex);
      if (!better) continue;
      bestScore = score;
      bestIndex = i;
      bestPrice = price;
      best = {
        model: model.name,
        thinkingLevel,
        providerId: model.providerId,
        signature,
      };
    }
  }
  return best;
}

/** Returns a new state with `signal` added to the matching experience row (created when absent). */
export function applySignal(
  learned: RouteLearnedState,
  key: { signature: string; model: string; thinkingLevel: string },
  signal: RouteSignal,
): RouteLearnedState {
  const entries = learned.entries.map((row) => ({ ...row }));
  const existing = entries.find(
    (row) => row.signature === key.signature && row.model === key.model && row.thinkingLevel === key.thinkingLevel,
  );
  const target = existing ?? { ...key, negative: 0, positive: 0 };
  if (!existing) entries.push(target);
  target.negative += signal.negative ?? 0;
  target.positive += signal.positive ?? 0;
  return { entries };
}

function matchThinkingLevel(
  supported: readonly ThinkingLevel[],
  wanted: ThinkingLevel | null | undefined,
): ThinkingLevel | null {
  if (!wanted) return null;
  const key = wanted.toLowerCase();
  return supported.find((level) => level.toLowerCase() === key) ?? null;
}

function scoreCandidate(
  model: CatalogEntry,
  kind: MessageKind,
  thinkingLevel: ThinkingLevel,
  signature: string,
  learned: RouteLearnedState,
): number {
  let score = 0;
  const strengths = model.strengths.map((item) => item.toLowerCase());
  const tags = STRENGTH_TAGS[kind];
  for (const tag of tags) {
    if (strengths.some((item) => item.includes(tag) || tag.includes(item))) score += 4;
  }
  if (strengths.length === 0) score += 1;
  if (kind === "simple" && model.price != null) score -= model.price;
  if (kind === "reasoning" && model.price != null) score += Math.min(model.price, 20) * 0.01;
  score -= PENALTY_WEIGHT * penaltyFor(learned, signature, model.name, thinkingLevel);
  return score;
}

export function penaltyFor(
  learned: RouteLearnedState,
  signature: string,
  model: string,
  thinkingLevel: string,
): number {
  let total = 0;
  for (const row of learned.entries) {
    if (row.signature !== signature || row.model !== model) continue;
    if (row.thinkingLevel === thinkingLevel || row.thinkingLevel === "*") total += effectivePenalty(row);
  }
  return total;
}
