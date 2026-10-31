/**
 * What a project session's Claude Code runs beside its reply (ADR 0095, 25), kept from its own
 * messages: `task_started`, `task_progress`, `task_updated` and `task_notification` say what one is
 * and how it goes; `background_tasks_changed` is the whole set still going in the background, what
 * decides whether the run can end.
 *
 * Measured on Claude Code 2.1.312 with SDK 0.3.289, none of it in the SDK's types:
 * - a Monitor is a `local_bash` like any command, so what a task is comes from the call that started it;
 * - a foreground command that takes a moment reports `task_started` too (`is_backgrounded: false`):
 *   it is the working bubble's until it really goes to the background;
 * - a foreground subagent is in no `background_tasks_changed`, and nothing else shows what it does.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTask, AgentTaskKind, AgentTaskStatus } from "@real-bot/protocol";
import { isoNow } from "../ids";

/** The call that started a task, as the hook saw it. */
export type TaskCall = { tool: string; input: Record<string, unknown> };

const TEXT_MAX = 2000;
const LINE_MAX = 300;
/** One long run's list stays small enough to travel with every change of the run. */
const KEPT = 100;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function kindOf(call: TaskCall | undefined, taskType: string | null): AgentTaskKind {
  if (call?.tool === "Monitor") return "monitor";
  if (call?.tool === "Bash" || taskType === "local_bash") return "shell";
  if (call?.tool === "Agent" || call?.tool === "Task" || taskType === "local_agent") return "subagent";
  return "other";
}

function commandOf(call: TaskCall | undefined): string | null {
  const command = str(call?.input.command) ?? str((call?.input.ws as { url?: unknown } | undefined)?.url);
  return command ? clip(command, TEXT_MAX) : null;
}

function statusOf(status: unknown): AgentTaskStatus | null {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "killed") return "stopped";
  return null;
}

export type TaskBoard = {
  /** One of Claude Code's messages; true when what the windows show changed. */
  apply(message: SDKMessage): boolean;
  /** A tool's result as it came back: a backgrounded command's says where its output goes. */
  noteResult(message: SDKMessage): boolean;
  /** The tasks to show, oldest first. */
  list(): AgentTask[];
  /** How many keep the run open: going in the background, as Claude Code last said. */
  going(): number;
  /** Whether this run has started any task at all. */
  any(): boolean;
  /** The call a task came from, when this message says it has ended: that call's frame ends with it. */
  endedCall(message: SDKMessage): string | null;
};

export function createTaskBoard(callOf: (toolUseId: string | null) => TaskCall | undefined): TaskBoard {
  const tasks = new Map<string, AgentTask>();
  /** A foreground command's, kept in case it goes to the background. */
  const hidden = new Set<string>();
  let going = new Set<string>();

  const shown = (id: string) => tasks.has(id) && !hidden.has(id);

  function started(raw: Record<string, unknown>): boolean {
    const id = str(raw.task_id);
    // What Claude Code does for itself is no activity of the agent's.
    if (!id || raw.ambient === true || raw.skip_transcript === true) return false;
    const call = callOf(str(raw.tool_use_id));
    const kind = kindOf(call, str(raw.task_type));
    if (kind === "shell" && raw.is_backgrounded === false) hidden.add(id);
    tasks.set(id, {
      id, tool_use_id: str(raw.tool_use_id), kind, status: "running", description: clip(str(raw.description) ?? "", LINE_MAX), command: commandOf(call), agent_type: str(raw.subagent_type),
      activity: null, summary: null, tool_uses: null, tokens: null, started_at: isoNow(), ended_at: null, output_file: null,
    });
    for (const old of [...tasks.keys()].slice(0, Math.max(0, tasks.size - KEPT))) tasks.delete(old);
    return shown(id);
  }

  function progress(raw: Record<string, unknown>): boolean {
    const task = tasks.get(str(raw.task_id) ?? "");
    if (!task) return false;
    const usage = raw.usage as { total_tokens?: number; tool_uses?: number } | undefined;
    task.activity = clip(str(raw.summary) ?? str(raw.description) ?? "", LINE_MAX) || null;
    task.tool_uses = usage?.tool_uses ?? task.tool_uses;
    task.tokens = usage?.total_tokens ?? task.tokens;
    return shown(task.id);
  }

  function updated(raw: Record<string, unknown>): boolean {
    const task = tasks.get(str(raw.task_id) ?? "");
    if (!task) return false;
    const patch = (raw.patch ?? {}) as { status?: unknown; description?: unknown; end_time?: unknown; error?: unknown; is_backgrounded?: unknown };
    if (patch.is_backgrounded === true) hidden.delete(task.id);
    const status = statusOf(patch.status);
    if (status) task.status = status;
    const description = str(patch.description);
    if (description) task.description = clip(description, LINE_MAX);
    if (typeof patch.end_time === "number") task.ended_at = new Date(patch.end_time).toISOString();
    const error = str(patch.error);
    if (error) task.summary = clip(error, TEXT_MAX);
    return shown(task.id);
  }

  function ended(raw: Record<string, unknown>): boolean {
    const task = tasks.get(str(raw.task_id) ?? "");
    if (!task) return false;
    task.status = statusOf(raw.status) ?? "completed";
    task.activity = null;
    task.ended_at ??= isoNow();
    const summary = str(raw.summary);
    if (summary) task.summary = clip(summary, TEXT_MAX);
    const usage = raw.usage as { total_tokens?: number; tool_uses?: number } | undefined;
    task.tool_uses = usage?.tool_uses ?? task.tool_uses;
    task.tokens = usage?.total_tokens ?? task.tokens;
    task.output_file = str(raw.output_file) ?? task.output_file;
    return shown(task.id);
  }

  /** The whole set going now: anything in it is in the background, however it started. */
  function level(raw: Record<string, unknown>): boolean {
    const rows = Array.isArray(raw.tasks) ? (raw.tasks as Array<{ task_id?: unknown; ambient?: unknown }>) : [];
    going = new Set(rows.flatMap((row) => (row.ambient === true ? [] : (str(row.task_id) ?? []))));
    let changed = false;
    for (const id of going) if (hidden.delete(id) && tasks.has(id)) changed = true;
    return changed;
  }

  return {
    apply(message) {
      if (message.type !== "system") return false;
      const raw = message as unknown as Record<string, unknown>;
      switch (raw.subtype) {
        case "task_started": return started(raw);
        case "task_progress": return progress(raw);
        case "task_updated": return updated(raw);
        case "task_notification": return ended(raw);
        case "background_tasks_changed": return level(raw);
        default: return false;
      }
    },
    noteResult(message) {
      if (message.type !== "user") return false;
      const raw = message as unknown as { tool_use_result?: { backgroundTaskId?: unknown }; message?: { content?: unknown } };
      const task = tasks.get(str(raw.tool_use_result?.backgroundTaskId) ?? "");
      if (!task || task.output_file) return false;
      const file = /written to: (\S+\.output)/.exec(JSON.stringify(raw.message?.content ?? ""))?.[1] ?? null;
      task.output_file = file;
      return file !== null && shown(task.id);
    },
    list: () => [...tasks.values()].filter((task) => !hidden.has(task.id)),
    going: () => going.size,
    any: () => tasks.size > 0,
    endedCall(message) {
      const raw = message as unknown as Record<string, unknown>;
      return message.type === "system" && raw.subtype === "task_notification" ? str(raw.tool_use_id) : null;
    },
  };
}

/**
 * The task a tool's response says it left running: the call itself is over, the work is not.
 * Bash says `backgroundTaskId`, Monitor `taskId`, a subagent `isAsync` and `agentId`.
 */
export function backgroundTaskOf(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const raw = response as { backgroundTaskId?: unknown; taskId?: unknown; isAsync?: unknown; agentId?: unknown };
  return str(raw.backgroundTaskId) ?? str(raw.taskId) ?? (raw.isAsync === true ? str(raw.agentId) : null);
}
