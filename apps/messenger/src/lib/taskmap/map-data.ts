import type {
  AgentReplay,
  AgentReplayDecision,
  AgentShellAction,
  AgentToolPlace,
  PlanReplay,
  ProjectAgent,
  SessionReplay,
  SessionReplayCall,
  SessionReplayLine,
} from "@real-bot/protocol";

/**
 * What the task map draws, whoever's work it is. A project session's replay (ADR 0095), a plan's
 * across its conversations and a Bot conversation's (ADR 0097) are read into it here, and the calls
 * seen live are merged on top; the scene and the timeline only read this.
 */
export type MapCall = {
  /** The tool call's id; a live call and the same call in a later replay share it. */
  id: string;
  /** Epoch milliseconds. */
  at: number;
  /** Index into `MapData.characters`: 0 is the agent itself, or the first Bot to work. */
  who: number;
  tool: string;
  place: AgentToolPlace;
  action?: AgentShellAction;
  file: string | null;
  ok: boolean;
  durationMs: number;
  model: string | null;
  decision: AgentReplayDecision | null;
  /** Seen on the event stream and still going: no result yet. */
  running?: boolean;
  /** The conversation it was made in, on a plan's map: a plan's work can be in several. */
  sessionId?: string;
};

export type MapCharacter = {
  /** The subagent's id, "main" for the agent itself, or a Bot's id. */
  key: string;
  /**
   * On the map from the start, full size: the agent, and every Bot of a conversation. A subagent is
   * not: it comes out for its work and goes back.
   */
  lead: boolean;
  /** What the replay says the subagent was sent to do; null for the agent and for one seen only live. */
  description: string | null;
  agentType: string | null;
  firstAt: number | null;
  lastAt: number | null;
  calls: number;
};

/** A call seen on the event stream before any replay holds it. */
export type LiveCall = {
  id: string;
  sessionId: string;
  /** The subagent (null for the agent itself) or the Bot that made it. */
  actor: string | null;
  /** Its turn, to tell which plan it is in now; the plan it said at its start, for a turn no longer known. */
  turnId: string;
  taskId: string | null;
  tool: string;
  info: { place: AgentToolPlace; action?: AgentShellAction; model: string | null; at: string; ok?: boolean };
  startedAt: number;
  running: boolean;
  ok: boolean | null;
  durationMs: number | null;
};

export type MapData = {
  sessionId: string;
  /** A project session's agent (for its logo), a plan's Bots wherever they worked, or a conversation of Bots. */
  source: { kind: "project"; agent: ProjectAgent } | { kind: "plan"; taskId: string; title: string; dir: string; sessions: string[] } | { kind: "bots" };
  calls: MapCall[];
  characters: MapCharacter[];
  /** What you said; a plan's lines also say where. */
  said: (SessionReplayLine & { session_id?: string })[];
};

const MAIN = "main";

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The characters in the order they first worked: the agent, then each subagent as it came out. A
 * subagent the replay lists but that made no call is left out; it would stand on the map doing nothing.
 */
function charactersOf(calls: readonly { agentId: string | null; at: number }[], subagents: AgentReplay["subagents"]): MapCharacter[] {
  const first = new Map<string, number>();
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  for (const call of calls) {
    const key = call.agentId ?? MAIN;
    if (!first.has(key)) first.set(key, call.at);
    last.set(key, Math.max(last.get(key) ?? call.at, call.at));
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const named = new Map(subagents.map((s) => [s.id, s]));
  const keys = [...first.keys()].filter((k) => k !== MAIN).sort((a, b) => first.get(a)! - first.get(b)! || a.localeCompare(b));
  return [MAIN, ...keys].map((key) => {
    const sub = named.get(key);
    return {
      key,
      lead: key === MAIN,
      description: sub?.description ?? null,
      agentType: sub?.agent_type ?? null,
      firstAt: first.get(key) ?? null,
      lastAt: key === MAIN ? (last.get(key) ?? null) : (ms(sub?.last_at) ?? last.get(key) ?? null),
      calls: count.get(key) ?? 0,
    };
  });
}

/** A project session's replay as map data: calls oldest first, each tied to its character. */
export function fromAgentReplay(replay: AgentReplay, agent: ProjectAgent): MapData {
  const raw = replay.calls
    .map((c) => ({ c, at: ms(c.at) }))
    .filter((x): x is { c: AgentReplay["calls"][number]; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at || a.c.id.localeCompare(b.c.id));
  const characters = charactersOf(raw.map((x) => ({ agentId: x.c.agent_id, at: x.at })), replay.subagents);
  const index = new Map(characters.map((c, i) => [c.key, i]));
  const calls: MapCall[] = raw.map(({ c, at }) => ({
    id: c.id,
    at,
    who: index.get(c.agent_id ?? MAIN) ?? 0,
    tool: c.tool,
    place: c.place,
    ...(c.action ? { action: c.action } : {}),
    file: c.file,
    ok: c.ok,
    durationMs: c.duration_ms,
    model: c.model,
    decision: c.decision,
  }));
  return { sessionId: replay.session_id, source: { kind: "project", agent }, calls, characters, said: replay.said };
}

/** Bots' calls as map data: every Bot a lead, in the order they first worked. */
function fromBotCalls(
  sessionId: string,
  replay: { calls: (SessionReplayCall & { session_id?: string })[]; bots: string[] },
  source: MapData["source"],
  said: MapData["said"],
): MapData {
  const raw = replay.calls
    .map((c) => ({ c, at: ms(c.at) }))
    .filter((x): x is { c: SessionReplayCall & { session_id?: string }; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at || a.c.id.localeCompare(b.c.id));
  const order = [...replay.bots, ...raw.map((x) => x.c.bot_id).filter((id) => !replay.bots.includes(id))];
  const keys = [...new Set(order)];
  const index = new Map(keys.map((key, i) => [key, i]));
  const characters: MapCharacter[] = keys.map((key) => ({ key, lead: true, description: null, agentType: null, firstAt: null, lastAt: null, calls: 0 }));
  const calls: MapCall[] = raw.map(({ c, at }) => {
    const who = index.get(c.bot_id)!;
    const ch = characters[who]!;
    ch.calls += 1;
    ch.firstAt ??= at;
    ch.lastAt = Math.max(ch.lastAt ?? at, at + c.duration_ms);
    return {
      id: c.id,
      at,
      who,
      tool: c.tool,
      place: c.place,
      ...(c.action ? { action: c.action } : {}),
      file: c.file,
      ok: c.ok,
      durationMs: c.duration_ms,
      model: c.model,
      decision: c.decision,
      ...(c.session_id ? { sessionId: c.session_id } : {}),
    };
  });
  return { sessionId, source, calls, characters, said };
}

/** A Bot conversation's replay as map data. */
export function fromSessionReplay(replay: SessionReplay): MapData {
  return fromBotCalls(replay.session_id, replay, { kind: "bots" }, replay.said);
}

/** A plan's replay as map data: its Bots wherever they worked, each call with its conversation. */
export function fromPlanReplay(replay: PlanReplay): MapData {
  return fromBotCalls(`plan:${replay.task_id}`, replay, { kind: "plan", taskId: replay.task_id, title: replay.title, dir: replay.dir, sessions: replay.sessions }, replay.said);
}

/**
 * The replay with what has happened since: live calls it does not hold yet are added (a subagent
 * first seen live gets a character with no description until the next replay names it), and a call
 * both hold takes the live result only while the replay has none. `belongs` says which live calls
 * are this map's: by default the ones in its conversation; a plan's map asks of each call's turn.
 */
export function mergeLive(data: MapData, live: readonly LiveCall[], belongs: (call: LiveCall) => boolean = (call) => call.sessionId === data.sessionId): MapData {
  if (live.length === 0) return data;
  const known = new Set(data.calls.map((c) => c.id));
  const fresh = live.filter((c) => !known.has(c.id) && belongs(c));
  if (fresh.length === 0) return data;
  const characters = data.characters.map((c) => ({ ...c }));
  const index = new Map(characters.map((c, i) => [c.key, i]));
  const calls = [...data.calls];
  const bots = data.source.kind !== "project";
  for (const call of [...fresh].sort((a, b) => a.startedAt - b.startedAt)) {
    const key = call.actor ?? MAIN;
    let who = index.get(key);
    if (who === undefined) {
      who = characters.length;
      characters.push({ key, lead: bots, description: null, agentType: null, firstAt: call.startedAt, lastAt: call.startedAt, calls: 0 });
      index.set(key, who);
    }
    const character = characters[who]!;
    character.calls += 1;
    character.firstAt ??= call.startedAt;
    character.lastAt = Math.max(character.lastAt ?? call.startedAt, call.startedAt + (call.durationMs ?? 0));
    calls.push({
      id: call.id,
      at: call.startedAt,
      who,
      tool: call.tool,
      place: call.info.place,
      ...(call.info.action ? { action: call.info.action } : {}),
      file: null,
      ok: call.ok ?? true,
      durationMs: call.durationMs ?? 0,
      model: call.info.model,
      decision: null,
      ...(call.running ? { running: true } : {}),
      ...(data.source.kind === "plan" ? { sessionId: call.sessionId } : {}),
    });
  }
  calls.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { ...data, calls, characters };
}
