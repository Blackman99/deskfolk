import type { ToolFrame } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { commandLine } from "./command-line.ts";

/**
 * What each running turn is doing: every tool call this client has seen it make, in order. The
 * line under a message shows the latest; clicking it lists them all.
 *
 * A turn that had not started writing used to show "思考中" and nothing else, so ten minutes of
 * reading files and running tests looked exactly like ten minutes of a stuck model. Ephemeral
 * like the command rows beside it: frames are not replayed, so a reload or a dropped connection
 * starts the list over, and nothing here is stored.
 */
export type ToolStep = {
  /** The tool call id. */
  id: string;
  name: string;
  /** What it is about: the command line for `shell`, otherwise the frame's `target`. */
  target: string | null;
  mcp: { server: string; tool: string } | null;
  running: boolean;
  /** When this client saw it start. Frames carry no clock of their own. */
  startedAt: number;
  exitCode: number | null;
  /** How long it ran, as the daemon measured it; null while it runs. */
  durationMs: number | null;
};

/** A turn that runs for an hour can make hundreds of calls; the list keeps the latest ones. */
export const MAX_STEPS = 100;

export class TurnActivity {
  private readonly steps = new Map<string, ToolStep[]>();

  applyTool(frame: ToolFrame, now = Date.now()): void {
    const list = this.steps.get(frame.turn_id) ?? [];
    if (frame.phase === "started") {
      const target = frame.name === "shell" ? frame.command : frame.target;
      list.push({
        id: frame.id,
        name: frame.name,
        target: typeof target === "string" && target.trim() ? target : null,
        mcp: frame.mcp_server ? { server: frame.mcp_server, tool: frame.mcp_tool || frame.name } : null,
        running: true,
        startedAt: now,
        exitCode: null,
        durationMs: null,
      });
      if (list.length > MAX_STEPS) list.splice(0, list.length - MAX_STEPS);
      this.steps.set(frame.turn_id, list);
      return;
    }
    // Calls in a hop run one after another, so only the latest one can be ending.
    const step = list.at(-1);
    if (!step || step.id !== frame.id) return;
    list[list.length - 1] = {
      ...step,
      running: false,
      exitCode: frame.exit_code ?? null,
      durationMs: frame.duration_ms ?? Math.max(0, now - step.startedAt),
    };
  }

  latestFor(turnId: string): ToolStep | null {
    return this.steps.get(turnId)?.at(-1) ?? null;
  }

  /** Oldest first. */
  stepsFor(turnId: string): readonly ToolStep[] {
    return this.steps.get(turnId) ?? [];
  }

  forget(turnId: string): void {
    this.steps.delete(turnId);
  }

  clear(): void {
    this.steps.clear();
  }
}

export type ActivityCopy = Copy["chat"]["activity"];
export type ActivityVerb = keyof ActivityCopy["verbs"];

const VERBS: Readonly<Record<string, ActivityVerb>> = {
  read_file: "read",
  write_file: "write",
  delete_file: "delete",
  list_dir: "list",
  shell: "run",
  send_message: "send",
  ask_user: "ask",
  check_back: "checkBack",
  remember: "memory",
  forget: "memory",
  list_skills: "skill",
  read_skill: "skill",
  create_skill: "editSkill",
  update_skill: "editSkill",
  delete_skill: "editSkill",
  list_bots: "roster",
  list_sessions: "roster",
  create_bot: "createBot",
  create_group: "createGroup",
  create_direct: "openDirect",
  add_member: "addMember",
  remove_member: "removeMember",
  update_profile: "profile",
  list_routines: "routine",
  create_routine: "routine",
  update_routine: "routine",
  delete_routine: "routine",
  list_annotations: "annotation",
  resolve_annotation: "annotation",
  list_endpoints: "settings",
  add_endpoint: "editSettings",
  update_endpoint: "editSettings",
  delete_endpoint: "editSettings",
  list_mcp_servers: "settings",
  add_mcp_server: "editSettings",
  update_mcp_server: "editSettings",
  delete_mcp_server: "editSettings",
  list_prompts: "prompt",
  read_prompt: "prompt",
  edit_prompt: "editPrompt",
  reset_prompt: "editPrompt",
  describe_data: "records",
  query_data: "records",
  read_data_log: "records",
};

/** A step shorter than this is over before its time would be worth reading. */
export const LONG_STEP_MS = 3000;
const SUBJECT_MAX = 48;

export type StepLine = {
  /** What the line says, clipped to fit beside a name. */
  text: string;
  /** The same with its subject whole, for a tooltip. */
  full: string;
  /**
   * How long a running step has taken, once that is worth saying. Apart from `text` so that
   * clipping a long command never cuts it off.
   */
  elapsed: string | null;
};

/**
 * "读取 src/app.ts" while it runs (with how long, once that is worth saying), then
 * "思考中 · 读了 src/app.ts" until the next step starts.
 */
export function describeStep(step: ToolStep, copy: ActivityCopy, nowMs: number): StepLine {
  const verb = copy.verbs[VERBS[step.name] ?? "call"];
  const whole = subjectOf(step);
  const clipped = whole ? clip(whole, step.name) : null;
  const phrase = (form: string, subject: string | null) => (subject ? `${form} ${subject}` : form);
  if (step.running) {
    const elapsed = nowMs - step.startedAt;
    return {
      text: phrase(verb.doing, clipped),
      full: phrase(verb.doing, whole),
      elapsed: elapsed >= LONG_STEP_MS ? formatElapsed(elapsed) : null,
    };
  }
  const failed = step.exitCode !== null && step.exitCode !== 0 ? ` · ${copy.failed}` : "";
  return {
    text: copy.after(phrase(verb.done, clipped) + failed),
    full: copy.after(phrase(verb.done, whole) + failed),
    elapsed: null,
  };
}

/** The line as one string, for a place that has no room for two parts. */
export function stepText(line: StepLine): string {
  return line.elapsed ? `${line.text} · ${line.elapsed}` : line.text;
}

/**
 * One row of the list a working message's last line opens: a step going on now, said whole. Only
 * running steps get there; what has finished is in the command card, or done with.
 */
export type StepRow = {
  /** The tool call id, which with the turn id also names its command output. */
  id: string;
  /** The whole phrase, the command every line of it: the list wraps where the line under a message clips. */
  text: string;
  /** How long it has taken so far; nothing under a second, where it would only be noise. */
  time: string | null;
  shell: boolean;
};

export function stepRow(step: ToolStep, copy: ActivityCopy, nowMs: number): StepRow {
  const verb = copy.verbs[VERBS[step.name] ?? "call"];
  const subject = step.mcp ? `${step.mcp.server} · ${step.mcp.tool}` : step.target?.trim() || (VERBS[step.name] ? null : step.name);
  const ms = nowMs - step.startedAt;
  return {
    id: step.id,
    text: subject ? `${verb.doing} ${subject}` : verb.doing,
    time: ms >= 1000 ? formatElapsed(ms) : null,
    shell: step.name === "shell",
  };
}

function subjectOf(step: ToolStep): string | null {
  if (step.mcp) return `${step.mcp.server} · ${step.mcp.tool}`;
  // A command reads as its row in the command card does: no leading cd, its lines on one line.
  if (step.target) return (step.name === "shell" ? commandLine(step.target) : step.target.split("\n")[0]!.trim()) || null;
  // A tool this table does not know still says which one it is.
  return VERBS[step.name] ? null : step.name;
}

/** A path is read from its end, where the file name is; anything else from its start. */
function clip(subject: string, name: string): string {
  if (subject.length <= SUBJECT_MAX) return subject;
  const pathLike = name !== "shell" && subject.includes("/");
  return pathLike ? `…${subject.slice(subject.length - SUBJECT_MAX + 1)}` : `${subject.slice(0, SUBJECT_MAX - 1)}…`;
}

/** Whole seconds: the line ticks while it runs, and tenths would make it flicker. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
