import { AGENT_KINDS, generateBoringAvatar, USER_MEMBER, type Bot, type Provider, type SessionSummary } from "@real-bot/protocol";
import { isFolkAvatar } from "../avatar.ts";
import type { Copy } from "../copy.ts";
import { activeMembers, classifySession } from "../sidebar/session-groups.ts";
import { agentSource, endpointSource, runnerSource, type ModelSource } from "../model-source.ts";
import type { MapData } from "./map-data.ts";

/** How each character of a map looks: its name, its folk figure, and whose model it works on. */
export type CharacterLook = { name: string; avatar: string; source: ModelSource };

/**
 * Whose model a Bot works on: its local agent's (Claude Agent, Codex…), or its endpoint's vendor,
 * the app's default endpoint when the Bot names none.
 */
export function botSource(bot: Pick<Bot, "runner" | "provider_id" | "name">, providers: readonly Provider[], defaultProviderId: string | null, t: Copy): ModelSource {
  if (bot.runner) return runnerSource(bot.runner, bot.runner === "custom" ? bot.name : AGENT_KINDS[bot.runner].label, t);
  const provider = providers.find((p) => p.id === (bot.provider_id ?? defaultProviderId)) ?? providers[0];
  return provider ? endpointSource(provider, t) : { kind: "custom", name: t.connectors.customMark };
}

/** A figure for a name: a stored folk avatar as it is, anything else (a photo, none) as the folk the name gives. */
function figureOf(avatar: string | null | undefined, name: string): string {
  return isFolkAvatar(avatar) ? avatar! : generateBoringAvatar({ name });
}

/**
 * The characters' looks. A project session's agent and subagents wear its agent's logo, the
 * subagents named for what they were sent to do; a Bot conversation's characters are its Bots as
 * the sidebar shows them, a Bot since deleted by its id.
 */
export function characterLooks(
  data: MapData,
  input: { agentName: string; bots: readonly Bot[]; providers: readonly Provider[]; defaultProviderId: string | null; t: Copy },
): CharacterLook[] {
  if (data.source.kind === "project") {
    const source = agentSource(data.source.agent, input.agentName);
    return data.characters.map((c, i) => {
      const name = i === 0 ? input.agentName : (c.description ?? c.key);
      return { name, avatar: generateBoringAvatar({ name }), source };
    });
  }
  return data.characters.map((c) => {
    const bot = input.bots.find((b) => b.id === c.key);
    if (!bot) return { name: c.key.slice(0, 8), avatar: generateBoringAvatar({ name: c.key }), source: { kind: "custom", name: input.t.connectors.customMark } };
    return { name: bot.name, avatar: figureOf(bot.avatar, bot.name), source: botSource(bot, input.providers, input.defaultProviderId, input.t) };
  });
}

/**
 * A conversation as a plan's map names it: a group by its name, your direct by its Bot (or, said of
 * that Bot itself, as its direct with you), the Bots' own direct by both. One the window does not
 * hold (deleted, or not listed) is just another one.
 */
export function conversationLabel(sessionId: string, sessions: readonly SessionSummary[], bots: readonly Bot[], t: Copy, of?: string): string {
  const c = t.taskmap.plan.conv;
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return c.gone;
  if (session.kind === "group") return c.group(session.name ?? "");
  const members = activeMembers(session.participants).filter((member) => member !== USER_MEMBER);
  const names = members.map((id) => bots.find((b) => b.id === id)?.name ?? id.slice(0, 8));
  if (classifySession(session) !== "you-bot") return c.bots(names.join(" ↔ "));
  return of && members[0] === of ? c.yours : c.direct(names[0] ?? "");
}
