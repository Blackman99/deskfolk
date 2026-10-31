import type { AgentRun, AgentRunTask, AgentTask, AgentTaskStep } from "@real-bot/protocol";
import type { CommandRow } from "./command-activity.ts";
import { formatDuration } from "./command-activity.ts";
import { commandLine } from "./command-line.ts";
import type { StepRow } from "./turn-activity.ts";

/**
 * A project session's background tasks and subagents (ADR 0095, 25) in the shapes a Bot's direct
 * already draws: a command's row in the command card, a step in what the working bubble's last line
 * opens onto, and a subagent as a way in under the line that started it.
 */

/** What reads as a command: it has output to show, where a subagent has a conversation to open. */
export function isCommandTask(task: Pick<AgentTask, "kind">): boolean {
  return task.kind !== "subagent";
}

/** The session's tasks, oldest first: the newest run's as its events bring them, what was read for the rest. */
export function sessionTasks(run: AgentRun | null, read: readonly AgentRunTask[]): AgentRunTask[] {
  const output = new Map(read.map((task) => [task.id, task.output]));
  const current = run ? (run.tasks ?? []).map((task) => ({ ...task, run_id: run.id, output: output.get(task.id) ?? null })) : [];
  const earlier = read.filter((task) => task.run_id !== run?.id);
  return [...earlier, ...current].sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export type TaskPlaces = {
  /** By line: the agent's line each hangs under. */
  byLine: Map<string, AgentRunTask[]>;
  /** The live run's that no line says anything about yet: the working bubble's. */
  bubble: AgentRunTask[];
  /** A finished run's with no line of the agent's at all. */
  end: AgentRunTask[];
};

/**
 * Where each task hangs: under the reply of the turn that started it, the first line of the agent's
 * from its start on, as a Bot↔Bot direct hangs under the line that opened it. With that line yet to
 * come, a live run's waits in the working bubble, and a finished run's takes the agent's last line.
 * One started before the first line loaded waits for that line (`loadedFrom`: while there are older
 * lines to load, where the loaded ones start).
 */
export function placeTasks(
  tasks: readonly AgentRunTask[],
  agentLines: ReadonlyArray<{ id: string; created_at: string }>,
  liveRunId: string | null,
  loadedFrom: string | null,
): TaskPlaces {
  const places: TaskPlaces = { byLine: new Map(), bubble: [], end: [] };
  for (const task of tasks) {
    if (loadedFrom && task.started_at < loadedFrom) continue;
    const line = agentLines.find((row) => row.created_at >= task.started_at) ?? (task.run_id === liveRunId ? null : agentLines.at(-1));
    if (line) places.byLine.set(line.id, [...(places.byLine.get(line.id) ?? []), task]);
    else if (task.run_id === liveRunId) places.bubble.push(task);
    else places.end.push(task);
  }
  return places;
}

const exitCodeIn = (summary: string | null): number | null => {
  const code = summary ? /exit code (\d+)/.exec(summary)?.[1] : undefined;
  return code === undefined ? null : Number(code);
};

function spanMs(task: Pick<AgentTask, "started_at" | "ended_at">): number | null {
  const ms = task.ended_at ? Date.parse(task.ended_at) - Date.parse(task.started_at) : NaN;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** A finished command or Monitor as a row of the command card, its output opening under it. */
export function taskCommandRow(task: AgentRunTask, stoppedWord: string): CommandRow {
  const what = task.command ?? task.description;
  return {
    id: `${task.run_id}:${task.id}`,
    turnId: task.run_id,
    name: "shell",
    // Claude Code's own name leads a Monitor's row, as a subagent's calls are named.
    command: task.kind === "monitor" ? `Monitor ${what}` : what,
    running: task.status === "running",
    exitCode: exitCodeIn(task.summary),
    ok: task.status === "completed",
    ...(task.status === "stopped" ? { endedAs: stoppedWord } : {}),
    durationMs: spanMs(task),
    text: task.output ?? "",
  };
}

/** A task going on now, as a row of what the working bubble's last line opens onto. */
export function taskStepRow(task: AgentTask, doing: string, nowMs: number, open?: () => void): StepRow {
  const what = isCommandTask(task)
    ? commandLine(task.command ?? task.description)
    : [task.description, task.activity].filter(Boolean).join(" · ");
  const started = Date.parse(task.started_at);
  return {
    id: task.id,
    text: what ? `${doing} ${what}` : doing,
    time: Number.isFinite(started) && nowMs - started >= 1000 ? formatDuration(Math.round((nowMs - started) / 1000) * 1000) : null,
    shell: isCommandTask(task),
    ...(open ? { open } : {}),
  };
}

/** What the composer's stop menu offers while tasks go on: everything, or one of them. */
export type TaskStopItem = { key: string; label: string; task: AgentRunTask | null };

/** A subagent's record as a conversation reads: what it said, its calls between folded together. */
export type TrailBlock =
  | { kind: "say"; key: string; text: string }
  | { kind: "calls"; key: string; rows: CommandRow[] };

export function trailBlocks(steps: readonly AgentTaskStep[]): TrailBlock[] {
  const blocks: TrailBlock[] = [];
  steps.forEach((step, index) => {
    if (step.kind === "say") {
      blocks.push({ kind: "say", key: `say-${index}`, text: step.text });
      return;
    }
    const row: CommandRow = {
      id: step.id, turnId: "", name: step.tool, command: step.label, running: step.ok === null, exitCode: null, ...(step.ok === null ? {} : { ok: step.ok }),
      durationMs: step.duration_ms > 0 ? step.duration_ms : null, text: step.output ?? "",
    };
    const last = blocks.at(-1);
    if (last?.kind === "calls") last.rows.push(row);
    else blocks.push({ kind: "calls", key: `calls-${step.id}`, rows: [row] });
  });
  return blocks;
}

/** The call it is on, while it is on one: the bottom line of its popup. */
export function runningCall(steps: readonly AgentTaskStep[]): string | null {
  const last = steps.at(-1);
  return last?.kind === "call" && last.ok === null ? last.label : null;
}
