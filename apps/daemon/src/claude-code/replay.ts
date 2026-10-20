/**
 * A project session's work read back from Claude Code's own session files (ADR 0095), for the task
 * map's replay: every tool call with where it worked, whether it went through, how long it took and
 * what Claude Code wrote down about letting it run; the subagents it sent out; what you said and
 * how you answered its questions. Commands, file contents and results are not carried on.
 *
 * Only `assistant` entries count, each call once by its id: other entries (`api-request-blob`)
 * carry copies of old messages with no time, and counting them adds calls that never happened.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentReplay, AgentReplayCall, AgentReplayDecision, AgentReplayLine, AgentReplaySubagent } from "@real-bot/protocol";
import { promptText } from "./sessions";
import { fileOfCall, placeOfCall, type PlaceContext } from "./tool-place";

type Entry = Record<string, unknown>;
type Result = { at: string | null; ok: boolean; decision: AgentReplayDecision | null; content: unknown };

function readEntries(path: string): Entry[] {
  const out: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object") out.push(value as Entry);
    } catch {
      // a line being written
    }
  }
  return out;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function decisionOf(value: unknown): AgentReplayDecision | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const decision = str(raw.decision);
  return decision ? { decision, source: str(raw.source), reason_type: str(raw.reasonType) } : null;
}

/** Each tool result by its call's id: when it was written, whether it failed, the decision beside it. */
function resultsOf(entries: Entry[]): Map<string, Result> {
  const results = new Map<string, Result>();
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      results.set(part.tool_use_id, { at: str(entry.timestamp), ok: part.is_error !== true, decision: decisionOf(entry.permissionDecision), content: part.content });
    }
  }
  return results;
}

type Call = AgentReplayCall & { input: Record<string, unknown>; result: unknown };

function callsOf(entries: Entry[], agentId: string | null, ctx: Omit<PlaceContext, "cwd">, seen: Set<string>): Call[] {
  const results = resultsOf(entries);
  const out: Call[] = [];
  for (const entry of entries) {
    const at = str(entry.timestamp);
    if (entry.type !== "assistant" || !at) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.type !== "tool_use" || typeof part.id !== "string" || seen.has(part.id)) continue;
      seen.add(part.id);
      const tool = String(part.name ?? "");
      const input = (part.input && typeof part.input === "object" ? part.input : {}) as Record<string, unknown>;
      const { place, action } = placeOfCall(tool, input, { ...ctx, cwd: str(entry.cwd) ?? ctx.projectDir });
      const result = results.get(part.id);
      const done = result?.at ? Date.parse(result.at) : NaN;
      out.push({
        id: part.id, at, agent_id: agentId ?? str(entry.agentId), tool, place, ...(action ? { action } : {}),
        file: fileOfCall(tool, input), ok: result?.ok ?? true,
        duration_ms: Number.isFinite(done) ? Math.max(0, done - Date.parse(at)) : 0,
        decision: result?.decision ?? null, input, result: result?.content,
      });
    }
  }
  return out;
}

/** The text of a tool result, whether a string or text parts. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join(" ");
}

/**
 * Reads one Claude Code session and its subagents; `sourceFile`, for a session carried on from the
 * terminal, is read first when the branch does not hold the source's own calls (a call is counted
 * once, by its id, whichever file has it).
 */
export function readAgentReplay(
  input: { sessionId: string; agentFile: string | null; sourceFile: string | null; agentSession: string | null; sourceSession: string | null },
  ctx: Omit<PlaceContext, "cwd">,
): AgentReplay {
  const seen = new Set<string>();
  const calls: Call[] = [];
  const said: AgentReplayLine[] = [];
  const subagents: AgentReplaySubagent[] = [];
  const files = [input.sourceFile, input.agentFile].filter((file): file is string => Boolean(file && existsSync(file)));
  const saidSeen = new Set<string>();
  for (const file of files) {
    const entries = readEntries(file);
    calls.push(...callsOf(entries.filter((entry) => entry.isSidechain !== true), null, ctx, seen));
    for (const entry of entries) {
      const at = str(entry.timestamp);
      const text = at ? promptText(entry) : null;
      // A branch copies its source's lines: one line said once, by when and what.
      if (at && text && !saidSeen.has(`${at}\u0000${text}`)) {
        saidSeen.add(`${at}\u0000${text}`);
        said.push({ kind: "say", at, text });
      }
    }
    const dir = join(file.slice(0, -".jsonl".length), "subagents");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      names = [];
    }
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length).replace(/^agent-/, "");
      if (subagents.some((row) => row.id === id)) continue;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, `${name.slice(0, -".jsonl".length)}.meta.json`), "utf8")) as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const own = callsOf(readEntries(join(dir, name)), id, ctx, seen);
      calls.push(...own);
      const ends = own.map((call) => Date.parse(call.at) + call.duration_ms).filter(Number.isFinite);
      subagents.push({
        id, description: str(meta.description) ?? "", agent_type: str(meta.agentType), model: str(meta.model), spawned_by: str(meta.toolUseId),
        first_at: own[0]?.at ?? null, last_at: ends.length ? new Date(Math.max(...ends)).toISOString() : null, calls: own.length,
      });
    }
  }
  // Your answers to its questions, from the question's own result.
  for (const call of calls) {
    if (call.tool !== "AskUserQuestion" || call.agent_id !== null) continue;
    const questions = Array.isArray(call.input.questions)
      ? (call.input.questions as Array<{ question?: unknown }>).map((row) => (typeof row?.question === "string" ? row.question : "")).filter(Boolean)
      : [];
    const answers = [...resultText(call.result).matchAll(/"[^"]+"="([^"]+)"/g)].map((match) => match[1]!.replace(/\s*\((Recommended|推荐)\)\s*$/, ""));
    said.push({ kind: "answer", at: new Date(Date.parse(call.at) + call.duration_ms).toISOString(), asked_at: call.at, questions, answers });
  }
  calls.sort((a, b) => a.at.localeCompare(b.at));
  said.sort((a, b) => a.at.localeCompare(b.at));
  subagents.sort((a, b) => (a.first_at ?? "").localeCompare(b.first_at ?? ""));
  return {
    session_id: input.sessionId,
    agent_session: input.agentFile && existsSync(input.agentFile) ? input.agentSession : null,
    source_session: input.sourceFile && existsSync(input.sourceFile) ? input.sourceSession : null,
    calls: calls.map(({ input: _input, result: _result, ...call }) => call),
    subagents,
    said,
  };
}
