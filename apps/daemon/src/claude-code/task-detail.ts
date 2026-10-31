/**
 * What opening a project session's task shows (ADR 0095, 25), read from Claude Code's own files
 * each time: the end of what a command printed, or what a subagent was asked and did so far. The app
 * keeps none of it, so with the files gone there is nothing to show, as with the replay.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { AgentTaskStep } from "@real-bot/protocol";
import { activityOf } from "../project-runner";
import { modelOf, readEntries, resultsOf, resultText } from "./replay";

/** More than the 8 KiB Claude Code itself reads back, while the file is there to read. */
const OUTPUT_TAIL = 64 * 1024;
const STEP_OUTPUT_MAX = 4000;
const STEPS_KEPT = 300;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The end of a command's output: its whole size, and the last of it from a line's start. */
export function readOutputTail(file: string | null, max = OUTPUT_TAIL): { output: string; bytes: number } | null {
  if (!file) return null;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // Cut mid-line, and maybe mid-character: it starts at the next whole line.
    const start = size > length ? text.indexOf("\n") + 1 : 0;
    return { output: text.slice(start), bytes: size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What a user entry says as words; a tool's result is not words. */
function wordsOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = (content as Array<{ type?: unknown; text?: unknown }>).flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
  return text.trim() || null;
}

/** A subagent's session file: what it was asked, the model it ran on, and each thing it said and did. */
export function readSubagentTrail(file: string | null): { prompt: string | null; model: string | null; steps: AgentTaskStep[] } {
  if (!file || !existsSync(file)) return { prompt: null, model: null, steps: [] };
  const entries = readEntries(file);
  const results = resultsOf(entries);
  let prompt: string | null = null;
  let model: string | null = null;
  const steps: AgentTaskStep[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const message = entry.message as { content?: unknown } | undefined;
    if (entry.type === "user" && prompt === null) prompt = wordsOf(message?.content);
    if (entry.type !== "assistant" || !at) continue;
    model ??= modelOf(message);
    for (const part of Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        steps.push({ kind: "say", at, text: part.text });
      } else if (part?.type === "tool_use" && typeof part.id === "string" && !seen.has(part.id)) {
        seen.add(part.id);
        const tool = String(part.name ?? "");
        const result = results.get(part.id);
        const done = result?.at ? Date.parse(result.at) : NaN;
        const output = result ? resultText(result.content).trim() : "";
        steps.push({
          kind: "call", id: part.id, at, tool, label: activityOf(tool, (part.input ?? {}) as Record<string, unknown>), ok: result ? result.ok : null,
          duration_ms: Number.isFinite(done) ? Math.max(0, done - Date.parse(at)) : 0, output: output ? clip(output, STEP_OUTPUT_MAX) : null,
        });
      }
    }
  }
  return { prompt, model, steps: steps.slice(-STEPS_KEPT) };
}
