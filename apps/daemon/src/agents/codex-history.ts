/**
 * Carrying a Codex thread to another of your Codex accounts (ADR 0099 addendum 2026-11-17): each
 * account (`CODEX_HOME`) keeps its own threads, and Codex finds a thread only in its own home —
 * neither `thread/fork` nor `thread/resume` by the old thread's file works across homes (measured,
 * Codex 0.153.4: "no rollout found"). What does: `thread/resume` with the conversation as
 * `history`, which opens a new thread under the account that carries the context and is kept once
 * it has had a turn. The history is read through the old account's own app-server (`thread/read`),
 * never from Codex's files: what you said and what it answered; tool calls do not come along.
 */
import type { RpcPeer } from "../engine/agent/jsonrpc";
import type { CodexThread } from "./codex-sessions";
import { userText } from "./codex-sessions";

/** A message as Codex's `ResponseItem` takes it. */
export type CodexHistoryItem = { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }>; phase?: string };

/** A thread's conversation as `thread/resume`'s `history`: your lines and its answers, in order; tool calls left out. */
export function historyOf(thread: CodexThread): CodexHistoryItem[] {
  const out: CodexHistoryItem[] = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text) out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: item.text }], ...(typeof item.phase === "string" ? { phase: item.phase } : {}) });
      }
    }
  }
  return out;
}

/** How many tool calls a thread made, which a carried thread no longer holds one by one. */
export function toolCallsOf(thread: CodexThread): number {
  return (thread.turns ?? []).reduce((sum, turn) => sum + (turn.items ?? []).filter((item) => item.type !== "userMessage" && item.type !== "agentMessage" && item.type !== "reasoning").length, 0);
}

/**
 * Opens, on the app-server of the account the session moved to, a new thread carrying `history`;
 * its id, or null when Codex opened none. The thread is Codex's to keep once its first turn ran.
 */
export async function rebuildThread(rpc: RpcPeer, history: CodexHistoryItem[], asks: Record<string, unknown>, timeoutMs: number): Promise<{ id: string; model: string | null } | null> {
  const opened = await rpc.request<{ thread?: { id?: string }; model?: string }>("thread/resume", { threadId: crypto.randomUUID(), history, ...asks, excludeTurns: true }, timeoutMs);
  const id = opened?.thread?.id;
  return id ? { id, model: opened?.model ?? null } : null;
}
