/**
 * The spend ledger: what one call to a model is billed as, and who it is billed to. Every
 * completion, judge or short call in the engine ends here — a row inserted and published so the
 * UI's running totals move with it. Usage that came back empty is still recorded when the
 * endpoint answered, so a silent provider shows up as spend with no digits rather than nothing at
 * all; a call that never answered and brought no usage is not recorded, since there is nothing to
 * bill and no reply to account for.
 */
import type { MappedUsage } from "../completions";
import type { Spend, SpendKind, SpendPurpose } from "@real-bot/protocol";
import type { Store } from "../store";
import type { CallTarget, SpendOwner } from "./types";

export type SpendDeps = {
  store: Store;
  publishSpend: (row: Spend) => void;
};

export type SpendTracker = {
  callOf: (target: CallTarget) => CallTarget;
  spendOwner: (sessionId: string, botId: string | null) => SpendOwner;
  usageHasDigits: (usage: MappedUsage | null) => boolean;
  recordResponseSpend: (input: {
    kind: SpendKind;
    /** What the call was for, where its kind is shared (ADR 0042). */
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    turnId?: string | null;
    judgementId?: string | null;
    chainId?: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    responded: boolean;
  }) => Spend | null;
  /** A call run by the user's own Claude Code: no endpoint, and a price that is an estimate, as a Claude Agent turn's is (ADR 0061). */
  recordClaudeSpend: (input: {
    kind: SpendKind;
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    /** The turn a compaction summary is billed to, the judgement a verdict is (ADR 0077). */
    turnId?: string | null;
    judgementId?: string | null;
    model: string;
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
  }) => Spend | null;
  recordSpend: (
    kind: "turn",
    turnId: string,
    usage: MappedUsage | null,
    missing: Spend["missing_reason"],
    target: CallTarget,
    owner: SpendOwner,
  ) => void;
  writeSpend: (input: {
    kind: SpendKind;
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    turnId: string | null;
    judgementId: string | null;
    chainId: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    missing: Spend["missing_reason"];
  }) => Spend;
};

export function createSpend(deps: SpendDeps): SpendTracker {
  const { store, publishSpend } = deps;

  function callOf(target: CallTarget): CallTarget {
    return {
      providerId: target.providerId,
      providerName: target.providerName,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
    };
  }

  /**
   * The title the messenger shows: a group's name, the other side of a you↔Bot direct, or
   * `A ↔ B` for a Bot↔Bot direct. Frozen with the Bot's name before the call leaves.
   */
  function spendOwner(sessionId: string, botId: string | null): SpendOwner {
    let sessionName: string | null = null;
    try {
      const session = store.getSession(sessionId);
      if (session.kind === "group") {
        sessionName = session.name;
      } else {
        const names = store
          .presentBotIds(sessionId)
          .map((id) => {
            try {
              return store.getBot(id).name;
            } catch {
              return null;
            }
          })
          .filter((name): name is string => Boolean(name));
        sessionName = names.length <= 1 ? (names[0] ?? null) : names.join(" ↔ ");
      }
    } catch {
      sessionName = null;
    }
    let botName: string | null = null;
    if (botId) {
      try {
        botName = store.getBot(botId).name;
      } catch {
        botName = null;
      }
    }
    return { sessionId, sessionName, botId, botName };
  }

  function usageHasDigits(usage: MappedUsage | null): boolean {
    return Boolean(
      usage &&
        (usage.input_tokens != null ||
          usage.output_tokens != null ||
          usage.total_tokens != null ||
          usage.cached_tokens != null ||
          usage.reasoning_tokens != null ||
          usage.cost_usd_ticks != null),
    );
  }

  /**
   * A short call that returned a body. Success and `incomplete` with no usage are `endpoint_omitted`;
   * an endpoint error is recorded only when it brought usage. A throw never reaches here.
   */
  function recordResponseSpend(input: {
    kind: SpendKind;
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    turnId?: string | null;
    judgementId?: string | null;
    chainId?: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    responded: boolean;
  }): Spend | null {
    const hasDigits = usageHasDigits(input.usage);
    if (!hasDigits && !input.responded) return null;
    return writeSpend({
      kind: input.kind,
      purpose: input.purpose ?? null,
      owner: input.owner,
      turnId: input.turnId ?? null,
      judgementId: input.judgementId ?? null,
      chainId: input.chainId ?? null,
      target: input.target,
      usage: hasDigits ? input.usage : null,
      missing: hasDigits ? null : "endpoint_omitted",
    });
  }

  function recordSpend(
    kind: "turn",
    turnId: string,
    usage: MappedUsage | null,
    missing: Spend["missing_reason"],
    target: CallTarget,
    owner: SpendOwner,
  ): void {
    const hasDigits = usageHasDigits(usage);
    if (!hasDigits && !missing) return;
    writeSpend({
      kind,
      owner,
      turnId,
      judgementId: null,
      chainId: null,
      target,
      usage: hasDigits ? usage : null,
      missing: hasDigits ? null : missing,
    });
  }

  function writeSpend(input: {
    kind: SpendKind;
    purpose?: SpendPurpose | null;
    owner: SpendOwner;
    turnId: string | null;
    judgementId: string | null;
    chainId: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    missing: Spend["missing_reason"];
  }): Spend {
    const row = store.insertSpend({
      kind: input.kind,
      purpose: input.purpose ?? null,
      sessionId: input.owner.sessionId,
      sessionName: input.owner.sessionName,
      botId: input.owner.botId,
      botName: input.owner.botName,
      turnId: input.turnId,
      judgementId: input.judgementId,
      chainId: input.chainId,
      providerId: input.target.providerId,
      providerName: input.target.providerName,
      model: input.target.model,
      thinkingLevel: input.target.thinkingLevel,
      inputTokens: input.usage?.input_tokens ?? null,
      outputTokens: input.usage?.output_tokens ?? null,
      totalTokens: input.usage?.total_tokens ?? null,
      cachedTokens: input.usage?.cached_tokens ?? null,
      reasoningTokens: input.usage?.reasoning_tokens ?? null,
      costUsdTicks: input.usage?.cost_usd_ticks ?? null,
      missingReason: input.missing,
    });
    publishSpend(row);
    return row;
  }

  function recordClaudeSpend(input: Parameters<SpendTracker["recordClaudeSpend"]>[0]): Spend | null {
    const { usage } = input;
    if (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.costUsd <= 0) return null;
    const row = store.insertSpend({
      kind: input.kind, purpose: input.purpose ?? null, sessionId: input.owner.sessionId, sessionName: input.owner.sessionName,
      botId: input.owner.botId, botName: input.owner.botName, turnId: input.turnId ?? null, judgementId: input.judgementId ?? null, chainId: null,
      providerId: "", providerName: "Claude Agent", model: input.model, thinkingLevel: null,
      inputTokens: Math.max(0, usage.inputTokens), outputTokens: Math.max(0, usage.outputTokens),
      totalTokens: Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens), cachedTokens: Math.max(0, usage.cachedTokens),
      reasoningTokens: null, costUsdTicks: null, estimatedCostUsdTicks: Math.max(0, Math.round(usage.costUsd * 1e10)), missingReason: null,
    });
    publishSpend(row);
    return row;
  }

  return { callOf, spendOwner, usageHasDigits, recordResponseSpend, recordClaudeSpend, recordSpend, writeSpend };
}
