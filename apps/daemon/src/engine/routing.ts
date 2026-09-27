/**
 * Where a call runs. `credentials()` reads the configured endpoints once per turn; `agentRoute`
 * asks a model what a Bot's message should run on, billed as its own spend kind; `targetFor` picks
 * the endpoint, model and thinking level for a turn, falling back to the roster's own rules when
 * there is no routing agent to ask or nothing for it to read. Everything downstream that needs a
 * target for a call — a turn, a judgement, the organizer, a chain review — goes through here.
 */
import type { ThinkingLevel } from "@real-bot/protocol";
import type { CompletionsClient } from "../completions";
import { classifyMessage, messageSignature } from "../route-decision";
import { parseRoutePick, type RoutePick } from "../route-agent";
import { ROUTE_PICK_SYSTEM, routePickPayload } from "../prompts/routing";
import { resolveCompletionTarget } from "../models";
import type { Store } from "../store";
import type { SpendTracker } from "./spend";
import type { CallTarget, Creds, Routed, SpendOwner } from "./types";

export type RoutingDeps = {
  store: Store;
  completions: CompletionsClient;
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  spendOwner: SpendTracker["spendOwner"];
};

export type Routing = {
  credentials: () => Promise<Creds | null>;
  /**
   * The routing agent cannot route itself, so it always runs on the default endpoint's default
   * model. That is the one job the roster-wide default model still has.
   */
  routingTarget: (creds: Creds) => (CallTarget & { baseUrl: string; apiKey: string }) | null;
  /** The message a reviewed turn was opened by, trimmed to what the picker needs to recognise it. */
  triggerOf: (turnId: string) => string;
  agentRoute: (
    turnId: string,
    botId: string,
    creds: Creds,
    text: string,
    signal: AbortSignal,
  ) => Promise<{ routed: Routed; pick: RoutePick } | null>;
  /**
   * Picks the endpoint, model and thinking level for one turn. The Bot's own experience shapes the
   * pick; the decision is returned alongside so the caller records exactly what ran.
   */
  targetFor: (botId: string, creds: Creds, text: string) => Routed | null;
};

export function createRouting(deps: RoutingDeps): Routing {
  const { store, completions, recordResponseSpend, spendOwner } = deps;

  async function credentials(): Promise<Creds | null> {
    const settings = await store.settings();
    const providers = await store.listProviders();
    const ready: Creds["providers"] = [];
    for (const provider of providers) {
      if (!provider.base_url) continue;
      const apiKey = await store.endpointKey(provider.id);
      if (!apiKey) continue;
      ready.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.base_url,
        apiKey,
        models: provider.models,
        defaultModel: provider.default_model,
      });
    }
    if (ready.length === 0) return null;
    return {
      locale: settings.locale,
      defaultProviderId: settings.default_provider_id,
      providers: ready,
    };
  }

  function routingTarget(creds: Creds): (CallTarget & { baseUrl: string; apiKey: string }) | null {
    const provider =
      creds.providers.find((row) => row.id === creds.defaultProviderId) ?? creds.providers[0];
    const model = provider?.defaultModel ?? provider?.models[0] ?? null;
    if (!provider || !model) return null;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      providerId: provider.id,
      providerName: provider.name,
      model,
      thinkingLevel: null,
    };
  }

  function triggerOf(turnId: string): string {
    try {
      const route = store.getTurnRoute(turnId);
      if (!route) return "";
      return store.getMessage(route.trigger_message_id).body;
    } catch {
      return "";
    }
  }

  /**
   * Asks a model what this message should run on. Everything that could go wrong — no endpoint, a
   * timeout, an answer naming something that does not exist — returns null and the rules take over.
   * The user is waiting; nothing here retries.
   */
  async function agentRoute(
    turnId: string,
    botId: string,
    creds: Creds,
    text: string,
    signal: AbortSignal,
  ): Promise<{ routed: Routed; pick: RoutePick } | null> {
    if (!text.trim()) return null;
    const routing = routingTarget(creds);
    if (!routing) return null;
    let bot;
    try {
      bot = store.getBot(botId);
    } catch {
      return null;
    }
    // A Bot that pinned both has already answered the question.
    if (bot.model && bot.thinking_level) return null;
    const providerIds = creds.providers.map((row) => row.id);
    const candidates = store.routeCandidates({
      botModel: bot.model,
      botProviderId: bot.provider_id,
      providerIds,
    });
    if (candidates.length === 0) return null;

    let previous: { message: string; model: string; thinkingLevel: string } | null = null;
    let payload;
    try {
      previous = store.previousDecisionFor(botId);
      payload = routePickPayload({
        message: text,
        bot: { name: bot.name, duties: bot.duties, boundaries: bot.boundaries },
        candidates,
        previous,
        pastReviews: store.recentRouteReviews(botId).map((row) => ({
          message: triggerOf(row.turn_id),
          signature: row.signature,
          model: row.model,
          thinkingLevel: row.thinking_level,
          direction: row.direction,
          rounds: row.rounds,
          reason: row.reason,
        })),
        cleanCompletions: store.cleanCompletions(botId),
      });
    } catch {
      return null;
    }

    let owned: SpendOwner;
    try {
      owned = spendOwner(store.getTurn(turnId).session_id, botId);
    } catch {
      owned = { sessionId: "", sessionName: null, botId, botName: null };
    }
    let result;
    try {
      result = await completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: ROUTE_PICK_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal,
      });
    } catch {
      return null;
    }
    recordResponseSpend({
      kind: "route_pick",
      owner: owned,
      turnId,
      target: routing,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (result.failKind && result.failKind !== "incomplete") return null;
    const pick = parseRoutePick(result.content ?? "", candidates);
    if (!pick) return null;
    const provider = creds.providers.find((row) => row.id === pick.providerId);
    if (!provider) return null;
    return {
      pick,
      routed: {
        target: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          providerId: provider.id,
          providerName: provider.name,
          model: pick.model,
          thinkingLevel: pick.thinkingLevel,
          locale: creds.locale,
        },
        decision: {
          model: pick.model,
          thinkingLevel: pick.thinkingLevel,
          providerId: pick.providerId,
          signature: messageSignature(text),
        },
      },
    };
  }

  function targetFor(botId: string, creds: Creds, text: string): Routed | null {
    let botModel: string | null = null;
    let botProviderId: string | null = null;
    let botThinkingLevel: ThinkingLevel | null = null;
    try {
      const bot = store.getBot(botId);
      botModel = bot.model;
      botProviderId = bot.provider_id;
      botThinkingLevel = bot.thinking_level;
    } catch {
      botModel = null;
      botProviderId = null;
      botThinkingLevel = null;
    }
    const providerIds = creds.providers.map((row) => row.id);
    const routed = store.decideTurnRoute({ botId, text, botModel, botProviderId, botThinkingLevel, providerIds });
    if (routed) {
      const provider = creds.providers.find((row) => row.id === routed.providerId);
      if (provider) {
        return {
          target: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            providerId: provider.id,
            providerName: provider.name,
            model: routed.model,
            thinkingLevel: routed.thinkingLevel,
            locale: creds.locale,
          },
          decision: routed,
        };
      }
    }
    const resolved = resolveCompletionTarget(creds.providers, {
      botModel,
      botProviderId,
      defaultProviderId: creds.defaultProviderId,
    });
    if (!resolved) return null;
    const provider = creds.providers.find((row) => row.id === resolved.providerId);
    if (!provider) return null;
    const fallback = store.decideTurnRoute({
      botId,
      text,
      botModel: resolved.model,
      botProviderId: resolved.providerId,
      botThinkingLevel,
      providerIds,
    });
    const thinkingLevel = fallback?.thinkingLevel ?? "low";
    return {
      target: {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        providerId: provider.id,
        providerName: provider.name,
        model: resolved.model,
        thinkingLevel,
        locale: creds.locale,
      },
      decision: {
        model: resolved.model,
        thinkingLevel,
        providerId: resolved.providerId,
        signature: fallback?.signature ?? classifyMessage(text),
      },
    };
  }

  return { credentials, routingTarget, triggerOf, agentRoute, targetFor };
}
