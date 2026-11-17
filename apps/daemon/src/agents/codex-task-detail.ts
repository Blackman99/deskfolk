/**
 * A Codex subagent opened (ADR 0095, 25; Codex, ADR 0099 addendum 2026-11-17): what it was asked,
 * the model it ran on and what it did, read from its own thread through Codex's app-server
 * (`thread/read`), as a Claude Code subagent's is read from its session file.
 */
import type { AgentTaskStep } from "@real-bot/protocol";
import { unwrapShell } from "../engine/agent/policy";
import { userText, type CodexItem, type CodexThread } from "./codex-sessions";

const OUTPUT_MAX = 2000;

/** One of the thread's tool items as a step: the tool as the chat names it, and what it names. */
function callStep(item: CodexItem, at: string): AgentTaskStep | null {
  const id = typeof item.id === "string" ? item.id : `${item.type}-${at}`;
  const ok = item.status === "completed" && (typeof item.exitCode !== "number" || item.exitCode === 0);
  const duration = typeof item.durationMs === "number" ? item.durationMs : 0;
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-OUTPUT_MAX) : null;
  if (item.type === "commandExecution" && typeof item.command === "string") {
    const command = unwrapShell(item.command);
    return { kind: "call", id, at, tool: "shell", label: `shell ${command}`, ok, duration_ms: duration, output };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const paths = (item.changes as Array<{ path?: unknown }>).flatMap((change) => (typeof change.path === "string" ? [change.path] : []));
    return { kind: "call", id, at, tool: "write_file", label: `write_file ${paths.join(", ")}`.trim(), ok, duration_ms: duration, output: null };
  }
  if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
    return { kind: "call", id, at, tool: `mcp__${item.server}__${item.tool}`, label: `${item.server} · ${item.tool}`, ok, duration_ms: duration, output: null };
  }
  if (item.type === "webSearch") {
    return { kind: "call", id, at, tool: "WebSearch", label: `WebSearch ${typeof item.query === "string" ? item.query : ""}`.trim(), ok: true, duration_ms: duration, output: null };
  }
  return null;
}

/** A subagent's thread as the task popup reads it: its prompt (the first thing it was told), its model, its steps in order. */
export function codexSubagentTrail(thread: CodexThread): { prompt: string | null; model: string | null; steps: AgentTaskStep[] } {
  let prompt: string | null = null;
  const steps: AgentTaskStep[] = [];
  for (const turn of thread.turns ?? []) {
    const at = new Date((turn.startedAt ?? 0) * 1000 || Date.now()).toISOString();
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        prompt ??= userText(item) || null;
        continue;
      }
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        steps.push({ kind: "say", at, text: item.text.trim() });
        continue;
      }
      const step = callStep(item, at);
      if (step) steps.push(step);
    }
  }
  return { prompt, model: thread.model ?? null, steps };
}
