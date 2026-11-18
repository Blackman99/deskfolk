/**
 * A Grok project session's work, read back (ADR 0115): for the task map's replay and a subagent's
 * popup, asked of Grok itself (`_x.ai/session/updates`, the stored updates of the session and of
 * each subagent's session), never read from its files. Each record carries the time Grok wrote it,
 * so a call starts when Grok reported it and lasts until its result. Grok records no permission
 * decisions, so `decision` is null; the model is the one the turn's own updates name.
 */
import { homedir } from "node:os";
import type { AgentReplay, AgentReplayCall, AgentReplayLine, AgentReplaySubagent, AgentTaskStep } from "@real-bot/protocol";
import { fileOfCall, placeOfCall } from "../claude-code/tool-place";
import { frameOf } from "../project-acp";
import { grokActionOf, grokToolName, isOwnTool } from "./grok-calls";
import { grokUpdates, recordMs, withGrokAcp, type GrokRecord } from "./grok-acp";
import type { ResolvedAgent } from "./runtime";

export type GrokReplayContext = { sessionId: string; agentSession: string | null; projectDir: string; home?: string; configDirs?: string[] };

const SUBAGENT_DESCRIPTION_MAX = 120;

type Call = { id: string; at: number; end: number | null; name: string; input: Record<string, unknown>; ok: boolean; model: string | null };

/** Each call in a session's records, with when it started and ended and whether it went through; Grok's own doors left out. */
function callsOf(records: GrokRecord[]): Call[] {
  const calls = new Map<string, Call>();
  let model: string | null = null;
  for (const record of records) {
    const update = record.params?.update;
    if (!update) continue;
    const meta = update._meta as { modelId?: unknown } | undefined;
    if (typeof meta?.modelId === "string") model = meta.modelId;
    if (update.sessionUpdate === "turn_completed") {
      const used = (update.usage as { modelUsage?: Record<string, unknown> } | undefined)?.modelUsage;
      const first = used ? Object.keys(used)[0] : undefined;
      if (first) model = first;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
    const at = recordMs(record);
    if (!id || at === null) continue;
    let call = calls.get(id);
    if (!call) {
      call = { id, at, end: null, name: grokToolName(update), input: {}, ok: false, model };
      calls.set(id, call);
    }
    const raw = update.rawInput;
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0 && Object.keys(call.input).length === 0) call.input = { ...(raw as Record<string, unknown>) };
    if (update.status === "completed" || update.status === "failed") {
      call.end = at;
      call.ok = update.status === "completed";
    }
  }
  return [...calls.values()].filter((call) => !isOwnTool(call.name));
}

/** What you said, at the time Grok wrote each line. */
function saidOf(records: GrokRecord[]): AgentReplayLine[] {
  const said: AgentReplayLine[] = [];
  let lastPrompt: unknown = undefined;
  for (const record of records) {
    const update = record.params?.update;
    if (update?.sessionUpdate !== "user_message_chunk") {
      if (update?.sessionUpdate === "agent_message_chunk" || update?.sessionUpdate === "tool_call") lastPrompt = undefined;
      continue;
    }
    const content = update.content as { type?: string; text?: string } | undefined;
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    const prompt = (update._meta as { promptIndex?: unknown } | undefined)?.promptIndex;
    const at = recordMs(record) ?? 0;
    const last = said.at(-1);
    if (last && last.kind === "say" && lastPrompt !== undefined && prompt === lastPrompt) last.text += content.text;
    else said.push({ kind: "say", at: new Date(at).toISOString(), text: content.text });
    lastPrompt = prompt;
  }
  return said.map((line) => (line.kind === "say" ? { ...line, text: line.text.trim() } : line)).filter((line) => line.kind !== "say" || line.text.length > 0);
}

/** The subagents a session started, from Grok's own notes of them. */
export function grokSubagentsOf(records: GrokRecord[]): Array<{ id: string; description: string; type: string | null; model: string | null }> {
  const out = new Map<string, { id: string; description: string; type: string | null; model: string | null }>();
  for (const record of records) {
    const update = record.params?.update;
    if (update?.sessionUpdate !== "subagent_spawned") continue;
    const id = typeof update.child_session_id === "string" ? update.child_session_id : typeof update.subagent_id === "string" ? update.subagent_id : null;
    if (!id || out.has(id)) continue;
    out.set(id, {
      id, description: typeof update.description === "string" ? update.description : "", type: typeof update.subagent_type === "string" ? update.subagent_type : null,
      model: typeof update.effective_model === "string" ? update.effective_model : typeof update.model === "string" ? update.model : null,
    });
  }
  return [...out.values()];
}

/** A session's records and its subagents' as the task map replays them. */
export function grokReplayOf(main: GrokRecord[], subagents: Map<string, GrokRecord[]>, ctx: GrokReplayContext): AgentReplay {
  const home = ctx.home ?? homedir();
  const configDirs = ctx.configDirs ?? [];
  const toReplay = (call: Call, agentId: string | null): AgentReplayCall => {
    const action = grokActionOf(call.name, call.input, ctx.projectDir);
    const frame = frameOf(action);
    const { place, action: shellAction } = placeOfCall(frame.place.tool, frame.place.input, { projectDir: ctx.projectDir, cwd: action.cwd, home, configDirs });
    return {
      id: call.id, at: new Date(call.at).toISOString(), agent_id: agentId, tool: frame.name, place, ...(shellAction ? { action: shellAction } : {}),
      model: call.model, file: fileOfCall(frame.place.tool, frame.place.input), ok: call.ok, duration_ms: call.end !== null ? Math.max(0, call.end - call.at) : 0, decision: null,
    };
  };
  const calls = callsOf(main).map((call) => toReplay(call, null));
  const rows: AgentReplaySubagent[] = [];
  for (const sub of grokSubagentsOf(main)) {
    const own = callsOf(subagents.get(sub.id) ?? []).map((call) => toReplay(call, sub.id));
    calls.push(...own);
    const times = (subagents.get(sub.id) ?? []).flatMap((record) => { const at = recordMs(record); return at === null ? [] : [at]; });
    rows.push({
      id: sub.id, description: [...sub.description].slice(0, SUBAGENT_DESCRIPTION_MAX).join(""), agent_type: sub.type, model: sub.model ?? own[0]?.model ?? null,
      spawned_by: null, first_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null, last_at: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null, calls: own.length,
    });
  }
  calls.sort((a, b) => a.at.localeCompare(b.at));
  return { session_id: ctx.sessionId, agent_session: ctx.agentSession, source_session: null, calls, subagents: rows, said: saidOf(main) };
}

/** Asks the session's Grok for its records and its subagents' and maps them; throws when Grok cannot be asked. */
export async function readGrokReplay(resolve: (configDir: string | null) => Promise<ResolvedAgent>, configDir: string | null, ctx: GrokReplayContext): Promise<AgentReplay> {
  const empty: AgentReplay = { session_id: ctx.sessionId, agent_session: ctx.agentSession, source_session: null, calls: [], subagents: [], said: [] };
  if (!ctx.agentSession) return empty;
  const grok = await resolve(configDir);
  if (!grok.ok) return empty;
  return withGrokAcp(grok, ctx.projectDir, async (rpc) => {
    const main = await grokUpdates(rpc, ctx.agentSession!, ctx.projectDir);
    const subagents = new Map<string, GrokRecord[]>();
    for (const sub of grokSubagentsOf(main)) subagents.set(sub.id, await grokUpdates(rpc, sub.id, ctx.projectDir).catch(() => []));
    return grokReplayOf(main, subagents, ctx);
  });
}

/** A subagent's session as the task popup reads it: what it was asked, its model, and its steps in order. */
export function grokSubagentTrail(records: GrokRecord[]): { prompt: string | null; model: string | null; steps: AgentTaskStep[] } {
  let prompt: string | null = null;
  let model: string | null = null;
  const steps: AgentTaskStep[] = [];
  const calls = new Map<string, Extract<AgentTaskStep, { kind: "call" }>>();
  for (const record of records) {
    const update = record.params?.update;
    if (!update) continue;
    const at = new Date(recordMs(record) ?? Date.now()).toISOString();
    const meta = update._meta as { modelId?: unknown } | undefined;
    if (typeof meta?.modelId === "string") model ??= meta.modelId;
    const content = update.content as { type?: string; text?: string } | undefined;
    if (update.sessionUpdate === "user_message_chunk" && content?.type === "text" && typeof content.text === "string") {
      prompt = (prompt ?? "") + content.text;
      continue;
    }
    if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
      const last = steps.at(-1);
      if (last?.kind === "say") last.text += content.text;
      else steps.push({ kind: "say", at, text: content.text });
      continue;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
    if (!id) continue;
    let step = calls.get(id);
    if (!step) {
      const name = grokToolName(update);
      step = { kind: "call", id, at, tool: name, label: name, ok: null, duration_ms: 0, output: null };
      calls.set(id, step);
      steps.push(step);
    }
    if (typeof update.title === "string" && update.title && update.sessionUpdate === "tool_call_update") step.label = update.title;
    if (update.status === "completed" || update.status === "failed") {
      step.ok = update.status === "completed";
      step.duration_ms = Math.max(0, Date.parse(at) - Date.parse(step.at));
    }
  }
  return { prompt: prompt?.trim() || null, model, steps: steps.map((step) => (step.kind === "say" ? { ...step, text: step.text.trim() } : step)) };
}
