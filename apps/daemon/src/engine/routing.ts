/**
 * Where a call runs. `credentials()` reads the configured endpoints once per turn; `agentRoute`
 * asks a model what a Bot's message should run on, billed as its own spend kind; `targetFor` picks
 * the endpoint, model and thinking level for a turn, falling back to the roster's own rules when
 * there is no routing agent to ask or nothing for it to read. Everything downstream that needs a
 * target for a call — a turn, a judgement, the organizer, a chain review — goes through here.
 */
import { isLadderClaudeRung, isLocalEndpoint, thinkingLevelRank, type ThinkingLevel } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import type { CompletionsClient } from "../completions";
import { classifyMessage, messageSignature, pickThinkingLevel } from "../route-decision";
import { parseRoutePick, type RoutePick } from "../route-agent";
import { ROUTE_PICK_SYSTEM, routePickPayload } from "../prompts/routing";
import { resolveCompletionTarget } from "../models";
import type { Store } from "../store";
import type { SpendTracker } from "./spend";
import type { CallTarget, Creds, EndpointTarget, Routed, SpendOwner } from "./types";

export type RoutingDeps = {
  store: Store;
  completions: CompletionsClient;
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  spendOwner: SpendTracker["spendOwner"];
  /** Benchmark switches (see `ablation.ts`): `route-pick` leaves every pick to the rules. */
  ablation?: Ablation;
};

export type Routing = {
  credentials: () => Promise<Creds | null>;
  /**
   * The routing agent cannot route itself, so it always runs on the default endpoint's default
   * model. That is the one job the roster-wide default model still has.
   */
  routingTarget: (creds: Creds) => (EndpointTarget) | null;
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
  /**
   * From engine level 7 (ADR 0048): what a turn runs on, by fixed rules and with no model call —
   * your pin, else the Bot's default (inferred from what it ran on and put to you on a card), else
   * the endpoint's default — with the reason recorded beside it.
   */
  decideRoute: (botId: string, creds: Creds, text: string, turnId?: string) => Routed | null;
};

export function createRouting(deps: RoutingDeps): Routing {
  const { store, completions, recordResponseSpend, spendOwner } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  async function credentials(): Promise<Creds | null> {
    const settings = await store.settings();
    const providers = await store.listProviders();
    const ready: Creds["providers"] = [];
    for (const provider of providers) {
      if (!provider.base_url) continue;
      // A model server on this computer or network takes no key (ADR 0067); any other endpoint needs one.
      const apiKey = (await store.endpointKey(provider.id)) ?? "";
      if (!apiKey && !isLocalEndpoint(provider.base_url)) continue;
      ready.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.base_url,
        apiKey,
        apiFormat: provider.api_format ?? "openai",
        workspaceId: provider.workspace_id ?? null,
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

  function routingTarget(creds: Creds): (EndpointTarget) | null {
    const provider =
      creds.providers.find((row) => row.id === creds.defaultProviderId) ?? creds.providers[0];
    const model = provider?.defaultModel ?? provider?.models[0] ?? null;
    if (!provider || !model) return null;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      workspaceId: provider.workspaceId,
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
    if (ablation.has("route-pick")) return null;
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
        apiFormat: routing.apiFormat,
        workspaceId: routing.workspaceId,
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
          apiFormat: provider.apiFormat,
          workspaceId: provider.workspaceId,
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
            apiFormat: provider.apiFormat,
            workspaceId: provider.workspaceId,
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
        apiFormat: provider.apiFormat,
        workspaceId: provider.workspaceId,
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

  function decideRoute(botId: string, creds: Creds, text: string, turnId?: string): Routed | null {
    const base = baseRoute(botId, creds, text, turnId);
    const routed = decideFrom(base, botId, creds, text, turnId);
    // Stepped up or moved for pictures: why the model was chosen in the first place is kept beside it.
    if (!base || !routed || routed.decision.reasonCode === base.decision.reasonCode) return routed;
    return { ...routed, decision: { ...routed.decision, baseReasonCode: base.decision.reasonCode } };
  }

  function decideFrom(base: Routed | null, botId: string, creds: Creds, text: string, turnId?: string): Routed | null {
    const pictures = Boolean(base && turnId && store.turnNeedsPictures(turnId));
    const routed = base && turnId ? escalate(base, botId, turnId, creds, text, pictures) : base;
    // A Claude rung sees pictures.
    if (!base || !routed || !turnId || !pictures || routed.claude) return routed;
    // Its work needs pictures seen (ADR 0049): a model marked as taking none gives way to one that can.
    const catalog = store.catalogEntries();
    const sees = (providerId: string, model: string) => catalog.find((entry) => entry.providerId === providerId && entry.name === model)?.input_image;
    if (sees(routed.target.providerId, routed.target.model) !== false) return routed;
    // Your pin, or the model you set on the ticket, stays, stepped up or not (the base decision says whether it was one).
    if (base.decision.reasonCode === "pin" || base.decision.reasonCode === "ticket_override") {
      store.noteModelOnce(botId, base.decision.reasonCode === "pin" ? "pin_no_pictures" : "ticket_override_no_pictures", routed.target.model);
      return routed;
    }
    // Within the endpoint you pinned it to, if any: past it is yours to say.
    const listed = scopedProviders(botId, creds).flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, model })));
    const able = listed.find((entry) => sees(entry.providerId, entry.model) === true) ?? listed.find((entry) => sees(entry.providerId, entry.model) !== false);
    if (!able) {
      store.noteModelOnce(botId, "no_picture_model", routed.target.model);
      return routed;
    }
    const provider = creds.providers.find((row) => row.id === able.providerId)!;
    const supported = catalog.find((entry) => entry.providerId === able.providerId && entry.name === able.model)?.thinking_levels ?? [];
    const thinkingLevel = supported.length === 0 ? routed.target.thinkingLevel
      : supported.find((level) => level.toLowerCase() === String(routed.target.thinkingLevel).toLowerCase()) ?? pickThinkingLevel(classifyMessage(text), supported);
    return {
      target: { ...routed.target, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat, workspaceId: provider.workspaceId, providerId: provider.id, providerName: provider.name, model: able.model, thinkingLevel },
      decision: { ...routed.decision, model: able.model, providerId: provider.id, thinkingLevel, reasonCode: "capability_filter" },
    };
  }

  /**
   * A job that failed twice in a row runs a thinking level higher per step (ADR 0049), up to the top
   * its model offers — not past a level you pinned, nor on a model measured to gain nothing from it.
   * Past the top, each step failed hand-overs made is one rung up the model ladder you ordered (ADR
   * 0054), when its model is on it and it was not your pin or the ticket's model; with no rung left
   * you are told once that switching models is yours.
   */
  function escalate(routed: Routed, botId: string, turnId: string, creds: Creds, text: string, pictures: boolean): Routed {
    let workItemId: string | null = null;
    let pinnedLevel = false;
    try {
      workItemId = store.getTurn(turnId).work_item_id ?? null;
      pinnedLevel = Boolean(store.getBot(botId).thinking_level);
    } catch {
      return routed;
    }
    const steps = workItemId ? store.workEscalation(workItemId) : 0;
    if (steps === 0 || pinnedLevel) return routed;
    const catalog = store.catalogEntries();
    const entry = catalog.find((row) => row.providerId === routed.target.providerId && row.name === routed.target.model);
    const levels = [...(entry?.thinking_levels ?? [])].sort((a, b) => thinkingLevelRank(a) - thinkingLevelRank(b));
    const current = levels.findIndex((level) => level.toLowerCase() === String(routed.target.thinkingLevel).toLowerCase());
    const top = levels.length - 1;
    // The thinking levels this model has left to give: none when thinking is measured to change nothing.
    const room = entry?.reasoning_effective === false || current === -1 ? 0 : Math.max(0, top - current);
    if (steps <= room) {
      const thinkingLevel = levels[current + steps]!;
      return { target: { ...routed.target, thinkingLevel }, decision: { ...routed.decision, thinkingLevel, reasonCode: "escalation" } };
    }
    const atTop: Routed = room === 0 ? routed
      : { target: { ...routed.target, thinkingLevel: levels[top]! }, decision: { ...routed.decision, thinkingLevel: levels[top]!, reasonCode: "escalation" } };
    // Only failed hand-overs go past the top: a step trouble inside a turn made raises the level, never the model.
    const wanted = Math.min(steps - room, steps - store.workTroubleSteps(workItemId!));
    if (wanted <= 0) return atTop;
    // Your pin and the ticket's model stay: the ladder only moves what the app chose.
    const climbs = routed.decision.reasonCode === "default" || routed.decision.reasonCode === "endpoint_default";
    const climbed = climbs ? climb(routed, wanted, creds, text, pictures) : null;
    if (climbed) {
      // On the last rung and failing still: what next is yours.
      if (climbed.short) store.noteModelOnce(botId, "escalation_top", climbed.routed.decision.model);
      return climbed.routed;
    }
    store.noteModelOnce(botId, "escalation_top", atTop.target.model);
    return atTop;
  }

  /**
   * `rungs` up the model ladder from the model a turn would run on, past rungs no endpoint lists any
   * more or, for work that needs pictures seen, marked as taking none. A Claude rung (ADR 0076) is
   * always there to climb to: whether Claude Code runs and is signed in is the turn's to find out.
   * At the last rung there is, when the climb asks for more (`short`). Null when its model is not on
   * the ladder or nothing is above it.
   */
  function climb(routed: Routed, rungs: number, creds: Creds, text: string, pictures: boolean): { routed: Routed; short: boolean } | null {
    const ladder = store.modelLadder();
    const at = ladder.findIndex((rung) => !isLadderClaudeRung(rung) && rung.provider_id === routed.target.providerId && rung.model === routed.target.model);
    if (at === -1) return null;
    const catalog = store.catalogEntries();
    const above = ladder.slice(at + 1).filter((rung) => isLadderClaudeRung(rung)
      || (creds.providers.some((provider) => provider.id === rung.provider_id && provider.models.includes(rung.model))
        && (!pictures || catalog.find((entry) => entry.providerId === rung.provider_id && entry.name === rung.model)?.input_image !== false)));
    const rung = above[Math.min(rungs, above.length) - 1];
    if (!rung) return null;
    const short = rungs > above.length;
    if (isLadderClaudeRung(rung)) {
      return { short, routed: { ...routed, claude: rung,
        decision: { ...routed.decision, model: rung.model, providerId: "", thinkingLevel: rung.effort ?? "default", reasonCode: "escalation_model" } } };
    }
    const provider = creds.providers.find((row) => row.id === rung.provider_id)!;
    const supported = catalog.find((entry) => entry.providerId === rung.provider_id && entry.name === rung.model)?.thinking_levels ?? [];
    const thinkingLevel = supported.length === 0 ? routed.target.thinkingLevel : pickThinkingLevel(classifyMessage(text), supported);
    return { short, routed: {
      target: { ...routed.target, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat, workspaceId: provider.workspaceId, providerId: provider.id, providerName: provider.name, model: rung.model, thinkingLevel },
      decision: { ...routed.decision, model: rung.model, providerId: provider.id, thinkingLevel, reasonCode: "escalation_model" },
    } };
  }

  /** A Bot pinned to an endpoint only (no model) stays on that endpoint: its default, the fallback and a picture-taking stand-in are from its list. */
  function scopedProviders(botId: string, creds: Creds): Creds["providers"] {
    let bot;
    try {
      bot = store.getBot(botId);
    } catch {
      return creds.providers;
    }
    const scoped = bot.provider_id && !bot.model ? creds.providers.filter((provider) => provider.id === bot.provider_id) : creds.providers;
    return scoped.length > 0 ? scoped : creds.providers;
  }

  function baseRoute(botId: string, creds: Creds, text: string, turnId?: string): Routed | null {
    let bot;
    try {
      bot = store.getBot(botId);
    } catch {
      return null;
    }
    const providers = scopedProviders(botId, creds);
    const listed = providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, model })));
    const catalog = store.catalogEntries();
    // The level the model offers: the one wanted when it has it, else the one nearest this kind of message.
    const levelFor = (providerId: string, model: string, wanted: ThinkingLevel | null): ThinkingLevel => {
      const supported = catalog.find((entry) => entry.providerId === providerId && entry.name === model)?.thinking_levels ?? [];
      if (supported.length === 0) return wanted ?? "low";
      const match = wanted ? supported.find((level) => level.toLowerCase() === wanted.toLowerCase()) : undefined;
      return match ?? pickThinkingLevel(classifyMessage(text), supported);
    };
    const build = (providerId: string, model: string, wanted: ThinkingLevel | null, reasonCode: string): Routed | null => {
      const provider = creds.providers.find((row) => row.id === providerId);
      if (!provider) return null;
      const thinkingLevel = levelFor(providerId, model, wanted);
      return {
        target: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat, workspaceId: provider.workspaceId, providerId, providerName: provider.name, model, thinkingLevel, locale: creds.locale },
        decision: { model, thinkingLevel, providerId, signature: classifyMessage(text), reasonCode },
      };
    };
    const endpointDefault = (reasonCode: string): Routed | null => {
      const fallback = resolveCompletionTarget(providers, { botModel: null, botProviderId: providers === creds.providers ? null : providers[0]!.id,
        defaultProviderId: creds.defaultProviderId });
      return fallback ? build(fallback.providerId, fallback.model, bot.thinking_level, reasonCode) : null;
    };
    // The model you set on this turn's ticket comes first (ADR 0049): it is about the work, not the Bot.
    const override = turnId ? store.turnTicketModel(turnId) : null;
    if (override) {
      const provider = creds.providers.find((row) => row.id === override.provider_id && row.models.includes(override.model));
      if (provider) return build(provider.id, override.model, bot.thinking_level, "ticket_override");
      // No endpoint lists it any more: the Bot's own model meanwhile, and you are told once.
      store.noteModelOnce(botId, "ticket_override_unlisted", override.model);
    }
    // Your pin decides, whatever the Bot ran on before — while an endpoint still lists it.
    if (bot.model) {
      const pinned = creds.providers.find((provider) => provider.models.includes(bot.model!) && (!bot.provider_id || provider.id === bot.provider_id))
        ?? creds.providers.find((provider) => provider.models.includes(bot.model!));
      if (pinned) return build(pinned.id, bot.model, bot.thinking_level, "pin");
      // Pinned to a model no endpoint lists any more: the endpoint's default meanwhile, never a default
      // inferred behind your pin; you are told once.
      store.noteModelOnce(botId, "pin_unlisted", bot.model);
      return endpointDefault("pin_unlisted");
    }
    const fallback = store.ensureBotDefault(botId, listed);
    if (fallback.model && fallback.providerId && listed.some((entry) => entry.providerId === fallback.providerId && entry.model === fallback.model)) {
      return build(fallback.providerId, fallback.model, bot.thinking_level ?? fallback.thinkingLevel, "default");
    }
    return endpointDefault("endpoint_default");
  }

  return { credentials, routingTarget, triggerOf, agentRoute, targetFor, decideRoute };
}
