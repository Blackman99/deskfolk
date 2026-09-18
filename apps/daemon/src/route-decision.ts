/**
 * The rules that pick a model when the routing agent cannot: no endpoint configured for the
 * routing call, the call timed out, or its answer named something that does not exist. They score
 * a candidate on what it says it is good at, what it costs and how heavy its levels are — a
 * cold start, not experience. Nothing here is penalised or rewarded; what a Bot has learned lives
 * in its reviews and is read by the agent.
 */
import {
  THINKING_LEVELS,
  thinkingLevelRank,
  type EndpointModel,
  type ThinkingLevel,
} from "@real-bot/protocol";

export type CatalogEntry = EndpointModel & {
  providerId: string;
};

/** What a turn ended up running on. The agent picks it; these rules are the fallback. */
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
  if (/\b(bug|fix)\b/.test(t)) return "coding";
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
      const score = scoreCandidate(model, kind) + (thinkingLevel === preferred ? 1 : 0);
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

function matchThinkingLevel(
  supported: readonly ThinkingLevel[],
  wanted: ThinkingLevel | null | undefined,
): ThinkingLevel | null {
  if (!wanted) return null;
  const key = wanted.toLowerCase();
  return supported.find((level) => level.toLowerCase() === key) ?? null;
}

function scoreCandidate(model: CatalogEntry, kind: MessageKind): number {
  let score = 0;
  const strengths = model.strengths.map((item) => item.toLowerCase());
  const tags = STRENGTH_TAGS[kind];
  for (const tag of tags) {
    if (strengths.some((item) => item.includes(tag) || tag.includes(item))) score += 4;
  }
  if (strengths.length === 0) score += 1;
  if (kind === "simple" && model.price != null) score -= model.price;
  if (kind === "reasoning" && model.price != null) score += Math.min(model.price, 20) * 0.01;
  return score;
}
