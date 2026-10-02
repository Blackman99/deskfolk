/**
 * A "chain" is one Bot's run of turns in one session on the same footing, from whatever opened it
 * to whichever turn last touched it before the user (or the other Bot) went quiet. When it closes,
 * it is reviewed once — was the model at fault, the request, or the job itself? — and a confident
 * verdict may be turned into a memory or a skill revision. The quiet clock that decides when a
 * chain is done living here too. It runs only while no turn of the chain does: a turn starting
 * holds it, a turn ending starts it again, and every new word about the same thing pushes it back.
 */
import type { ClientEvent, RouteOutcome } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import { runCollabTool } from "../collab-tools";
import { type ChatMessage, type CompletionsClient } from "../completions";
import { parseRouteReview, verdictIsClarification, verdictIsExperience } from "../route-agent";
import { chainWarrantsReview } from "../route-learning";
import {
  ROUTE_LEARN_SYSTEM,
  ROUTE_REVIEW_SYSTEM,
  routeLearnPayload,
  routeReviewPayload,
} from "../prompts/routing";
import { toChatTools } from "../prompts/tool-schema";
import { FORGET, REMEMBER } from "../prompts/tools/memory";
import { UPDATE_SKILL } from "../prompts/tools/profile";
import type { TurnAdmission } from "../quiesce";
import type { Store } from "../store";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { CallTarget } from "./types";

export type ChainsDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  occurred: () => string;
  completions: CompletionsClient;
  admission: TurnAdmission | undefined;
  track: <T>(promise: Promise<T>) => Promise<T>;
  credentials: Routing["credentials"];
  routingTarget: Routing["routingTarget"];
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  spendOwner: SpendTracker["spendOwner"];
  /**
   * Benchmark switches (see `ablation.ts`): `review` records every chain as not worth a review
   * (so it still closes), `learning` skips the learning hop after a review.
   */
  ablation?: Ablation;
  /** How long a chain stays quiet after its last turn ended before it closes. Tests shorten it. */
  quietMs?: number;
};

export type Chains = {
  reviewChain: (chainId: string) => Promise<void>;
  closeChain: (sessionId: string, botId: string) => void;
  sweepStaleChains: () => void;
  touchChain: (sessionId: string, botId: string) => void;
  holdChain: (sessionId: string, botId: string) => void;
  turnEnded: (turnId: string) => void;
  clearTimers: () => void;
};

export function createChains(deps: ChainsDeps): Chains {
  const { store, publish, occurred, completions, admission, track, credentials, routingTarget, recordResponseSpend, spendOwner } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  /**
   * A chain closes when the user goes quiet after the Bot stopped, even if they never say so. Long
   * enough to read what was handed over and come back about it: in real use one reply in five
   * about a turn came 3–15 minutes after it ended, past the old three-minute window.
   */
  const CHAIN_QUIET_MS = deps.quietMs ?? 15 * 60_000;
  /** Past this, a chain is cold: not joined by a new turn, and not worth a review call. */
  const CHAIN_MAX_AGE_MS = 24 * 60 * 60_000;
  /** How many chains one restart is willing to pay to catch up on. */
  const CHAIN_SWEEP_LIMIT = 20;
  const chainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function reviewsRetired(): boolean {
    try {
      return store.learningOn();
    } catch {
      return false;
    }
  }

  function chainFloor(): string {
    return new Date(Date.now() - CHAIN_MAX_AGE_MS).toISOString();
  }

  /**
   * Has one closed chain judged: was the model the thing at fault, or was it the request, or the
   * job itself? The verdict is recorded either way, because recording it is what closes the chain;
   * only a confident `model` verdict is read back when picking later.
   */
  async function reviewChain(chainId: string): Promise<void> {
    // From level 8 nothing reviews a chain after the fact (ADR 0050): what went wrong is a quality
    // event filed by its type, and what the app learns is a lesson it checks itself.
    if (admission?.draining || reviewsRetired()) return;
    let chain;
    try {
      chain = store.chainForReview(chainId);
    } catch {
      return;
    }
    if (!chain) return;
    // A turn of it is still running: nothing to read yet, and the user has not answered it. Its end
    // starts the clock again (`turnEnded`), or reviews it if a newer chain took its place meanwhile.
    if (chain.live) return;
    // A quiet chain is only worth a review when the model side failed, or the tools failed twice.
    // A clean finish is recorded locally so the chain closes, without paying for a call.
    if (
      ablation.has("review") ||
      !chainWarrantsReview({
        followUps: chain.followUps.length,
        outcome: chain.outcome === "running" ? null : (chain.outcome as RouteOutcome),
        failKind: chain.execution.failKind,
        toolErrors: chain.execution.toolErrors,
      })
    ) {
      try {
        store.recordRouteReview({
          botId: chain.botId,
          chainId,
          turnId: chain.turnId,
          sessionId: chain.sessionId,
          signature: chain.signature,
          model: chain.model,
          thinkingLevel: chain.thinkingLevel,
          verdict: { fault: "none", direction: "same", rounds: 0, confidence: 1, reason: "" },
        });
      } catch {
        // best effort
      }
      return;
    }
    const creds = await credentials().catch(() => null);
    const routing = creds ? routingTarget(creds) : null;
    if (!creds || !routing || admission?.draining) return;
    let bot;
    try {
      bot = store.getBot(chain.botId);
    } catch {
      return;
    }
    const owned = spendOwner(chain.sessionId, chain.botId);
    const payload = routeReviewPayload({
      bot: { name: bot.name, duties: bot.duties },
      message: chain.triggerMessage,
      model: chain.model,
      thinkingLevel: chain.thinkingLevel,
      reply: chain.reply,
      outcome: chain.outcome,
      followUps: chain.followUps,
      execution: {
        hops: chain.execution.hops,
        tool_calls: chain.execution.toolCalls,
        tool_errors: chain.execution.toolErrors,
        repeated_failures: chain.execution.repeatedFailures,
        files_written: chain.execution.filesWritten,
        fail_kind: chain.execution.failKind,
        cost_usd_ticks: chain.execution.costUsdTicks,
      },
    });
    let result;
    try {
      result = await completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: ROUTE_REVIEW_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: new AbortController().signal,
      });
    } catch {
      return;
    }
    recordResponseSpend({
      kind: "route_review",
      owner: owned,
      turnId: chain.turnId,
      chainId,
      target: routing,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (admission?.draining || (result.failKind && result.failKind !== "incomplete")) return;
    const verdict = parseRouteReview(result.content ?? "");
    // An unreadable verdict leaves the chain open: better a late review than a wrong conclusion.
    if (!verdict) return;
    try {
      store.recordRouteReview({
        botId: chain.botId,
        chainId,
        turnId: chain.turnId,
        sessionId: chain.sessionId,
        signature: chain.signature,
        model: chain.model,
        thinkingLevel: chain.thinkingLevel,
        verdict,
      });
    } catch {
      return;
    }
    if (admission?.draining) return;
    const stumbledAndFinished =
      chain.outcome === "completed" &&
      chain.execution.toolErrors !== null &&
      chain.execution.toolErrors > 0;
    // A request the user had to spell out twice is worth remembering for what they meant; that
    // hop may write a memory but not touch a skill, since nothing about the procedure was wrong.
    const clarification = verdictIsClarification(verdict);
    if (!verdictIsExperience(verdict) && !stumbledAndFinished && !clarification) return;
    if (ablation.has("learning")) return;
    await learnFromChain(chain, routing, verdict, clarification ? "clarification" : "experience");
  }

  /**
   * One short call, on the default model, that may write a memory or revise an existing skill.
   * Two tool hops at most. A call that uses no tool writes nothing, and nothing is posted to the
   * transcript either way. After a clarification the skill tool is withheld.
   */
  async function learnFromChain(
    chain: NonNullable<ReturnType<Store["chainForReview"]>>,
    routing: CallTarget & { baseUrl: string; apiKey: string },
    verdict: { fault: string; direction: string; reason: string },
    mode: "experience" | "clarification" = "experience",
  ): Promise<void> {
    const written: { kind: "memory" | "skill"; label: string }[] = [];
    const tools = toChatTools(
      mode === "clarification" ? [REMEMBER, FORGET] : [REMEMBER, FORGET, UPDATE_SKILL],
      "zh",
    );
    const allowed = new Set(tools.map((tool) => tool.function.name));
    let skills: { name: string; description: string }[] = [];
    try {
      skills = store.listSkills(chain.botId).map((skill) => ({
        name: skill.name,
        description: skill.description,
      }));
    } catch {
      skills = [];
    }
    const owned = spendOwner(chain.sessionId, chain.botId);
    const messages: ChatMessage[] = [
      { role: "system", content: ROUTE_LEARN_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          routeLearnPayload({
            message: chain.triggerMessage,
            model: chain.model,
            thinkingLevel: chain.thinkingLevel,
            reply: chain.reply,
            outcome: chain.outcome,
            followUps: chain.followUps,
            execution: {
              hops: chain.execution.hops,
              tool_calls: chain.execution.toolCalls,
              tool_errors: chain.execution.toolErrors,
              repeated_failures: chain.execution.repeatedFailures,
              files_written: chain.execution.filesWritten,
              fail_kind: chain.execution.failKind,
              cost_usd_ticks: chain.execution.costUsdTicks,
            },
            verdict,
            skills,
            failures: chain.failures,
          }),
        ),
      },
    ];
    for (let hop = 0; hop < 2; hop += 1) {
      if (admission?.draining) return;
      let result;
      try {
        result = await completions.judge({
          baseUrl: routing.baseUrl,
          apiKey: routing.apiKey,
          model: routing.model,
          messages,
          tools,
          signal: new AbortController().signal,
        });
      } catch {
        return;
      }
      recordResponseSpend({
        kind: "route_learn",
        owner: owned,
        chainId: chain.chainId,
        target: routing,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
      if (result.failKind && result.failKind !== "incomplete") break;
      const calls = result.toolCalls.filter((call) => allowed.has(call.name));
      if (calls.length === 0) break;
      messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: calls,
      });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
        const ran = await runCollabTool(
          {
            store,
            botId: chain.botId,
            sessionId: chain.sessionId,
            turnId: chain.turnId,
            parentId: null,
            learnedChainId: chain.chainId,
          },
          call.name,
          args,
        );
        for (const item of ran.emitted) {
          if (item.kind === "memory") {
            written.push({ kind: "memory", label: item.memory.subject });
            publish({
              event: "memory.upsert",
              occurred_at: occurred(),
              ...store.memoryWithLearning(item.memory),
            });
          } else if (item.kind === "memory_removed") {
            publish({ event: "memory.removed", occurred_at: occurred(), id: item.id });
          } else if (item.kind === "skill") {
            written.push({ kind: "skill", label: item.skill.name });
            publish({
              event: "skill.upsert",
              occurred_at: occurred(),
              ...store.skillWithLearning(item.skill),
            });
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(ran.ok ? { ok: true, data: ran.data } : { ok: false, error: ran.error }),
        });
      }
    }
    const kept = written.find((item) => item.kind === "memory") ?? written[0] ?? null;
    try {
      store.recordRouteLearning({
        chainId: chain.chainId,
        botId: chain.botId,
        sessionId: chain.sessionId,
        kind: kept?.kind ?? "none",
        label: kept?.label ?? "",
      });
    } catch {
      // the note is for the log; losing it does not undo what was written
    }
  }

  /** Closes whatever chain this Bot has open here, if any. */
  function closeChain(sessionId: string, botId: string): void {
    clearChainTimer(sessionId, botId);
    if (reviewsRetired()) return;
    let chainId: string | null = null;
    try {
      chainId = store.openChain(sessionId, botId, chainFloor());
    } catch {
      return;
    }
    if (chainId) void track(reviewChain(chainId));
  }

  /**
   * The quiet timers live in this process, so a daemon that stopped mid-chain would leave the
   * review undone until the user happened to change the subject. On start, chains that went quiet
   * while nobody was running are reviewed — recent ones only, and a bounded number of them. Chains
   * not quiet yet — a turn this restart interrupted has only just ended — get their clock back.
   */
  function sweepStaleChains(): void {
    if (reviewsRetired()) return;
    const range = {
      quietBefore: new Date(Date.now() - CHAIN_QUIET_MS).toISOString(),
      notBefore: chainFloor(),
      limit: CHAIN_SWEEP_LIMIT,
    };
    let chains: string[] = [];
    let recent: { chainId: string; sessionId: string; botId: string }[] = [];
    try {
      chains = store.staleOpenChains(range);
      recent = store.recentOpenChains(range);
    } catch {
      return;
    }
    for (const chainId of chains) void track(reviewChain(chainId));
    for (const chain of recent) settle(chain);
  }

  function chainKey(sessionId: string, botId: string): string {
    return `${sessionId}:${botId}`;
  }

  function clearChainTimer(sessionId: string, botId: string): void {
    const key = chainKey(sessionId, botId);
    const timer = chainTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    chainTimers.delete(key);
  }

  /** A turn of the chain started: the clock waits for it to end rather than running under it. */
  function holdChain(sessionId: string, botId: string): void {
    clearChainTimer(sessionId, botId);
  }

  /**
   * A turn ended, so its chain's quiet clock starts from now. When a newer chain has taken over
   * here meanwhile — a new subject started while this turn still ran — this chain was already
   * closed and only waited for the turn, so it is reviewed now.
   */
  function turnEnded(turnId: string): void {
    if (admission?.draining || reviewsRetired()) return;
    let chain;
    try {
      chain = store.unreviewedChainOf(turnId);
    } catch {
      return;
    }
    if (chain) settle(chain);
  }

  /** Starts the clock on a chain that is still the open one here, or reviews one a newer chain replaced. */
  function settle(chain: { chainId: string; sessionId: string; botId: string }): void {
    let open: string | null;
    try {
      open = store.openChain(chain.sessionId, chain.botId, chainFloor());
    } catch {
      return;
    }
    if (open === chain.chainId) touchChain(chain.sessionId, chain.botId);
    else void track(reviewChain(chain.chainId));
  }

  /** Restarts the quiet clock: every new word about the same thing pushes the review back. */
  function touchChain(sessionId: string, botId: string): void {
    clearChainTimer(sessionId, botId);
    if (admission?.draining || reviewsRetired()) return;
    const key = chainKey(sessionId, botId);
    const timer = setTimeout(() => {
      chainTimers.delete(key);
      closeChain(sessionId, botId);
    }, CHAIN_QUIET_MS);
    timer.unref?.();
    chainTimers.set(key, timer);
  }

  function clearTimers(): void {
    for (const timer of chainTimers.values()) clearTimeout(timer);
    chainTimers.clear();
  }

  return { reviewChain, closeChain, sweepStaleChains, touchChain, holdChain, turnEnded, clearTimers };
}
