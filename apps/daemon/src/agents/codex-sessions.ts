/**
 * Your Codex threads to carry on as project sessions (ADR 0099 addendum 2026-11-17), asked of
 * Codex's own app-server, never read from its files: `thread/list` for the threads you started in
 * Codex's terminal, its editor extension or `codex exec`, `thread/read` for what was said. The
 * session's first run forks the thread (`project-runner-codex.ts`), so yours stays as it was.
 */
import type { AgentSessionListing } from "@real-bot/protocol";
import { homedir } from "node:os";
import type { RpcPeer } from "../engine/agent/jsonrpc";
import type { ImportedLine, ImportedSession } from "./agent-sessions";
import { CODEX_ASK_TIMEOUT_MS, withCodexAppServer } from "./codex-app-server";
import type { ResolvedAgent } from "./runtime";

/** Where a thread you started yourself comes from. The app's own come from its app-server, though Codex may list those as `vscode` too: the app's own ids are left out besides. */
export const CODEX_TERMINAL_SOURCES = ["cli", "vscode", "exec"] as const;

/** How long a listing is kept before the next ask starts Codex again. */
export const CODEX_SESSIONS_MAX_AGE_MS = 60_000;

export type CodexItem = Record<string, unknown> & { type: string; id?: string };
export type CodexTurn = { id: string; status?: string; startedAt?: number | null; completedAt?: number | null; durationMs?: number | null; items: CodexItem[] };
export type CodexThread = {
  id: string;
  preview?: string | null;
  name?: string | null;
  cwd?: string | null;
  path?: string | null;
  model?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  gitInfo?: { branch?: string | null } | null;
  turns?: CodexTurn[];
};

/** The tool items Codex records, counted on import and drawn by the replay. */
export const CODEX_TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageView"]);

const iso = (seconds: number | null | undefined, fallback = Date.now()): string => new Date(typeof seconds === "number" && seconds > 0 ? seconds * 1000 : fallback).toISOString();

/** A thread as the import list shows it: its name, or else your first line, cut to one line. */
export function codexListing(thread: CodexThread, configDir: string | null): AgentSessionListing {
  const first = (thread.name?.trim() || thread.preview?.trim() || "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return {
    agent: "codex", session_id: thread.id, config_dir: configDir, title: first.slice(0, 200) || thread.id, cwd: thread.cwd ?? null,
    git_branch: thread.gitInfo?.branch ?? null, modified_at: iso(thread.updatedAt ?? thread.createdAt), size: 0,
  };
}

/** What you said in an item: its text parts, joined. */
export function userText(item: CodexItem): string {
  const content = Array.isArray(item.content) ? (item.content as Array<{ type?: unknown; text?: unknown }>) : [];
  return content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n").trim();
}

/**
 * A thread's conversation as lines: each of your lines at its turn's start, and each turn's answer
 * (its final answer, else the last thing it said) at the turn's end; tool calls only counted.
 */
export function readCodexThread(thread: CodexThread): ImportedSession {
  const lines: ImportedLine[] = [];
  let toolCalls = 0;
  for (const turn of thread.turns ?? []) {
    const start = iso(turn.startedAt);
    let answer: string | null = null;
    let last: string | null = null;
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text) lines.push({ role: "user", text, at: start });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        last = item.text.trim();
        if (item.phase === "final_answer") answer = last;
      } else if (CODEX_TOOL_ITEMS.has(item.type)) toolCalls += 1;
    }
    const said = answer ?? last;
    if (said) lines.push({ role: "assistant", text: said, at: iso(turn.completedAt ?? turn.startedAt) });
  }
  return { session_id: thread.id, title: codexListing(thread, null).title, cwd: thread.cwd ?? null, lines, tool_calls: toolCalls };
}

/** Up to `limit` threads you started yourself, newest first, through every page Codex gives. */
export async function listCodexThreads(rpc: RpcPeer, limit: number): Promise<CodexThread[]> {
  const out: CodexThread[] = [];
  let cursor: string | null = null;
  do {
    const page: { data?: CodexThread[]; nextCursor?: string | null } = await rpc.request("thread/list", {
      sourceKinds: [...CODEX_TERMINAL_SOURCES], archived: false, limit: Math.min(100, limit - out.length), sortKey: "updated_at", ...(cursor ? { cursor } : {}),
    }, CODEX_ASK_TIMEOUT_MS);
    for (const thread of page.data ?? []) if (typeof thread?.id === "string" && !thread.parentThreadId) out.push(thread);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

/** One thread with all its turns. */
export async function readThread(rpc: RpcPeer, threadId: string): Promise<CodexThread | null> {
  const answer = await rpc.request<{ thread?: CodexThread }>("thread/read", { threadId, includeTurns: true }, CODEX_ASK_TIMEOUT_MS);
  return answer?.thread?.id ? answer.thread : null;
}

export type CodexSessions = {
  /** Your threads on one account (null: the daemon's own Codex home), the app's own left out; kept a minute. */
  list(configDir: string | null, limit: number, exclude: ReadonlySet<string>): Promise<AgentSessionListing[]>;
  /** One thread read for carrying on; null when Codex does not have it. */
  read(configDir: string | null, sessionId: string): Promise<ImportedSession | null>;
};

export function createCodexSessions(deps: { resolve: (configDir: string | null) => Promise<ResolvedAgent>; now?: () => number }): CodexSessions {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { threads: CodexThread[]; at: number; limit: number }>();
  const ask = async <T>(configDir: string | null, question: (rpc: RpcPeer) => Promise<T>): Promise<T> => {
    const codex = await deps.resolve(configDir);
    if (!codex.ok) throw new Error(codex.error);
    return withCodexAppServer(codex, homedir(), question);
  };
  return {
    async list(configDir, limit, exclude) {
      const key = configDir ?? "";
      const old = kept.get(key);
      const threads = old && old.limit >= limit && now() - old.at < CODEX_SESSIONS_MAX_AGE_MS ? old.threads : await ask(configDir, (rpc) => listCodexThreads(rpc, limit));
      if (threads !== old?.threads) kept.set(key, { threads, at: now(), limit });
      return threads.filter((thread) => !exclude.has(thread.id)).slice(0, limit).map((thread) => codexListing(thread, configDir));
    },
    async read(configDir, sessionId) {
      const thread = await ask(configDir, (rpc) => readThread(rpc, sessionId).catch(() => null));
      return thread ? readCodexThread(thread) : null;
    },
  };
}
