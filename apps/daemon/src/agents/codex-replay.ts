/**
 * A Codex project session's work for the task map's replay (ADR 0111 addendum 2026-11-17), asked of
 * Codex's own app-server, never read from its files: the session's thread and the threads its
 * `spawnAgent` calls started, each with its turns and items. Codex records no permission decisions,
 * so `decision` is always null; an item carries its duration but not its start, so a call starts
 * where the one before it ended, from the start of its turn.
 */
import { homedir } from "node:os";
import type { AgentReplay, AgentReplayCall, AgentReplayLine, AgentReplaySubagent } from "@real-bot/protocol";
import { absoluteFrom, unwrapShell } from "../engine/agent/policy";
import { fileOfCall, placeOfCall } from "../claude-code/tool-place";
import { withCodexAppServer } from "./codex-app-server";
import { readThread, userText, type CodexItem, type CodexThread } from "./codex-sessions";
import type { ResolvedAgent } from "./runtime";

const CALL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView"]);
const SUBAGENT_DESCRIPTION_MAX = 120;

export type CodexReplayContext = { sessionId: string; agentSession: string | null; projectDir: string; home: string; configDirs?: string[] };

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** A call as the Codex runner's live frames name it (`callOf` in `project-runner-codex.ts`): its name, and the input `placeOfCall` reads it by. */
function callOf(item: CodexItem, cwd: string): { name: string; tool: string; input: Record<string, unknown> } | null {
  const itemCwd = str(item.cwd) ?? cwd;
  if (item.type === "commandExecution" && typeof item.command === "string") return { name: "shell", tool: "Bash", input: { command: unwrapShell(item.command) } };
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const paths = (item.changes as Array<{ path?: unknown }>).flatMap((change) => (typeof change.path === "string" ? [absoluteFrom(itemCwd, change.path)] : []));
    return { name: "write_file", tool: "Write", input: { file_path: paths[0] ?? itemCwd } };
  }
  if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
    const name = `mcp__${item.server}__${item.tool}`;
    return { name, tool: name, input: {} };
  }
  if (item.type === "webSearch") return { name: "WebSearch", tool: "WebSearch", input: {} };
  if (item.type === "dynamicToolCall") {
    const name = str(item.tool) ?? "dynamic_tool";
    return { name, tool: name, input: {} };
  }
  if (item.type === "imageView") return { name: "view_image", tool: "Read", input: { file_path: absoluteFrom(itemCwd, str(item.path) ?? ".") } };
  return null;
}

/** A thread's calls and the lines you said in it, each turn's times made from its start and its items' durations. */
function walk(thread: CodexThread, agentId: string | null, ctx: CodexReplayContext): { calls: AgentReplayCall[]; said: AgentReplayLine[] } {
  const calls: AgentReplayCall[] = [];
  const said: AgentReplayLine[] = [];
  const fallback = typeof thread.createdAt === "number" && thread.createdAt > 0 ? thread.createdAt : null;
  for (const turn of thread.turns ?? []) {
    const startSeconds = typeof turn.startedAt === "number" && turn.startedAt > 0 ? turn.startedAt : fallback;
    if (startSeconds === null) continue;
    const start = startSeconds * 1000;
    const end = typeof turn.completedAt === "number" && turn.completedAt * 1000 >= start ? turn.completedAt * 1000 : null;
    let cursor = start;
    for (const item of turn.items ?? []) {
      const duration = typeof item.durationMs === "number" && item.durationMs > 0 ? item.durationMs : 0;
      const call = CALL_ITEMS.has(item.type) ? callOf(item, ctx.projectDir) : null;
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text && agentId === null) said.push({ kind: "say", at: new Date(start).toISOString(), text });
      } else if (call) {
        const cwd = str(item.cwd) ?? ctx.projectDir;
        const { place, action } = placeOfCall(call.tool, call.input, { projectDir: ctx.projectDir, cwd, home: ctx.home, configDirs: ctx.configDirs });
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        const shown = end === null ? cursor : Math.min(cursor, end);
        calls.push({
          id: str(item.id) ?? `${thread.id}:${turn.id}:${calls.length}`, at: new Date(shown).toISOString(), agent_id: agentId, tool: call.name, place, ...(action ? { action } : {}),
          model: thread.model ?? null, file: fileOfCall(call.tool, call.input), ok: item.status === "completed" && (exitCode === null || exitCode === 0),
          duration_ms: end === null ? duration : Math.max(0, Math.min(duration, end - shown)), decision: null,
        });
      }
      cursor += duration;
      if (end !== null && cursor > end) cursor = end;
    }
  }
  return { calls, said };
}

/** The threads `spawnAgent` calls of `thread` started, by the item that started each. */
function spawnsOf(thread: CodexThread): Array<{ threadId: string; itemId: string | null; prompt: string }> {
  const out: Array<{ threadId: string; itemId: string | null; prompt: string }> = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent" || !Array.isArray(item.receiverThreadIds)) continue;
      for (const id of item.receiverThreadIds) if (typeof id === "string") out.push({ threadId: id, itemId: str(item.id), prompt: typeof item.prompt === "string" ? item.prompt : "" });
    }
  }
  return out;
}

/** The thread ids a thread spawned: what the second ask reads. */
export function spawnedThreadIds(thread: CodexThread): string[] {
  return spawnsOf(thread).map((spawn) => spawn.threadId);
}

/** The replay from thread objects: `threads` holds the session's own and the subagents' that could be read. */
export function codexReplayOf(threads: CodexThread[], ctx: CodexReplayContext): AgentReplay {
  const main = threads.find((thread) => thread.id === ctx.agentSession) ?? threads[0];
  const empty: AgentReplay = { session_id: ctx.sessionId, agent_session: ctx.agentSession, source_session: null, calls: [], subagents: [], said: [] };
  if (!main) return empty;
  const own = walk(main, null, ctx);
  const calls = [...own.calls];
  const subagents: AgentReplaySubagent[] = [];
  for (const spawn of spawnsOf(main)) {
    const thread = threads.find((one) => one.id === spawn.threadId);
    if (!thread || subagents.some((row) => row.id === spawn.threadId)) continue;
    const sub = walk(thread, spawn.threadId, ctx);
    calls.push(...sub.calls);
    const turns = (thread.turns ?? []).flatMap((turn) => [turn.startedAt, turn.completedAt]).filter((value): value is number => typeof value === "number" && value > 0);
    const first = spawn.prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
    subagents.push({
      id: spawn.threadId, description: first.slice(0, SUBAGENT_DESCRIPTION_MAX), agent_type: thread.agentNickname ?? null, model: thread.model ?? null, spawned_by: spawn.itemId,
      first_at: turns.length ? new Date(Math.min(...turns) * 1000).toISOString() : null, last_at: turns.length ? new Date(Math.max(...turns) * 1000).toISOString() : null, calls: sub.calls.length,
    });
  }
  calls.sort((a, b) => a.at.localeCompare(b.at));
  subagents.sort((a, b) => (a.first_at ?? "").localeCompare(b.first_at ?? ""));
  return { ...empty, calls, subagents, said: own.said };
}

/** Asks Codex for the session's thread and its subagents' threads; a subagent's thread it cannot read is left out. */
export async function readCodexReplay(
  resolve: (configDir: string | null) => Promise<ResolvedAgent>,
  input: { configDir: string | null },
  ctx: Omit<CodexReplayContext, "home"> & { home?: string },
): Promise<AgentReplay> {
  const empty: AgentReplay = { session_id: ctx.sessionId, agent_session: ctx.agentSession, source_session: null, calls: [], subagents: [], said: [] };
  if (!ctx.agentSession) return empty;
  const codex = await resolve(input.configDir);
  if (!codex.ok) throw new Error(codex.error);
  const sessionId = ctx.agentSession;
  const threads = await withCodexAppServer(codex, homedir(), async (rpc) => {
    const main = await readThread(rpc, sessionId);
    if (!main) return [];
    const subs = await Promise.all(spawnedThreadIds(main).map((id) => readThread(rpc, id).catch(() => null)));
    return [main, ...subs.filter((thread): thread is CodexThread => thread !== null)];
  });
  return codexReplayOf(threads, { ...ctx, home: ctx.home ?? homedir() });
}
