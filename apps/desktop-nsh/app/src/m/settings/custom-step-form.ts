/**
 * The pure side of the panel for a step of your own (ADR 0105): what changing a field does to the
 * others, the checks that catch the obvious before a save, and the engine's difference with a step
 * added, replaced or removed. The daemon checks again and has the last word.
 */
import {
  CUSTOM_STEP_CALL_ATS,
  CUSTOM_STEP_COMMAND_MAX,
  CUSTOM_STEP_NAME_MAX,
  CUSTOM_STEP_PATHS_MAX,
  CUSTOM_STEP_PATH_MAX,
  CUSTOM_STEP_PROMPT_MAX,
  CUSTOM_STEP_THENS_AT,
  CUSTOM_STEP_TOOLS,
  CUSTOM_STEPS_MAX,
  customStepTimeout,
  type CustomStep,
  type CustomStepAt,
  type CustomStepRunKind,
  type CustomStepSample,
  type CustomStepTool,
  type CustomStepView,
  type PlaybookDiff,
} from "@real-bot/protocol";

/** A step as the API shows it, without what only the API adds. */
export function plainStep(step: CustomStep | CustomStepView): CustomStep {
  const { running: _running, ...rest } = step as CustomStepView;
  return rest;
}

/** Another moment: its "no" is the first it allows if the old one is not allowed there, and a tool list means nothing off a call. */
export function withMoment(step: CustomStep, at: CustomStepAt): CustomStep {
  const next: CustomStep = { ...step, at };
  if (!CUSTOM_STEP_THENS_AT[at].includes(step.then)) next.then = CUSTOM_STEP_THENS_AT[at][0]!;
  if (!CUSTOM_STEP_CALL_ATS.includes(at) && next.match?.tools) {
    const { tools: _tools, ...rest } = next.match;
    if (rest.paths?.length) next.match = rest;
    else delete next.match;
  }
  // A command's time is held to the moment's range.
  if (next.run.kind === "command" && next.run.timeout_s !== undefined) {
    const range = customStepTimeout(at);
    next.run = { ...next.run, timeout_s: Math.min(range.max, Math.max(range.min, next.run.timeout_s)) };
  }
  return next;
}

/** Another way to judge, keeping what was written for the ways that remain open. */
export function withRunKind(step: CustomStep, kind: CustomStepRunKind, kept: { command: string; prompt: string }): CustomStep {
  if (kind === "rule") return { ...step, run: { kind: "rule" } };
  if (kind === "command") return { ...step, run: { kind: "command", command: kept.command, ...(step.run.kind === "command" && step.run.cwd ? { cwd: step.run.cwd } : {}) } };
  return { ...step, run: { kind: "model", prompt: kept.prompt } };
}

export function withTool(step: CustomStep, tool: CustomStepTool, on: boolean): CustomStep {
  const has = new Set(step.match?.tools ?? []);
  if (on) has.add(tool);
  else has.delete(tool);
  return withMatch(step, { tools: CUSTOM_STEP_TOOLS.filter((one) => has.has(one)) });
}

/** The lines of a textarea of globs: trimmed, none blank. */
export function pathLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function withPaths(step: CustomStep, text: string): CustomStep {
  return withMatch(step, { paths: pathLines(text) });
}

function withMatch(step: CustomStep, change: { tools?: CustomStepTool[]; paths?: string[] }): CustomStep {
  const tools = change.tools ?? step.match?.tools ?? [];
  const paths = change.paths ?? step.match?.paths ?? [];
  const { match: _match, ...rest } = step;
  if (tools.length === 0 && paths.length === 0) return rest;
  return { ...rest, match: { ...(tools.length > 0 ? { tools } : {}), ...(paths.length > 0 ? { paths } : {}) } };
}

/** The step as it is to be saved: names and commands trimmed, an empty folder left out, nothing the API does not take. */
export function cleanStep(step: CustomStep): CustomStep {
  const out: CustomStep = { ...plainStep(step), name: step.name.trim() };
  if (out.run.kind === "command") {
    const { cwd, ...run } = out.run;
    const folder = cwd?.trim() ?? "";
    out.run = { ...run, command: run.command.trim(), ...(folder && folder !== "." ? { cwd: folder } : {}) };
  } else if (out.run.kind === "model") {
    out.run = { kind: "model", prompt: out.run.prompt.trim() };
  }
  return out;
}

export type StepProblem =
  | "name"
  | "name_long"
  | "command"
  | "command_long"
  | "prompt"
  | "prompt_long"
  | "rule_empty"
  | "paths_many"
  | "path_bad"
  | "path_long"
  | "folder_bad"
  | "timeout"
  | "too_many";

const codePoints = (text: string): number => [...text].length;

function globOk(glob: string): boolean {
  if (!glob.trim() || glob.startsWith("/") || glob.startsWith("~") || /^[A-Za-z]:[\\/]/.test(glob)) return false;
  return !glob.split(/[\\/]/).includes("..");
}

/** What is plainly wrong with a step before it is sent, the first thing; null when nothing is. */
export function stepProblem(step: CustomStep): StepProblem | null {
  const s = cleanStep(step);
  if (!s.name) return "name";
  if (codePoints(s.name) > CUSTOM_STEP_NAME_MAX) return "name_long";
  for (const glob of s.match?.paths ?? []) {
    if (!globOk(glob)) return "path_bad";
    if (codePoints(glob) > CUSTOM_STEP_PATH_MAX) return "path_long";
  }
  if ((s.match?.paths?.length ?? 0) > CUSTOM_STEP_PATHS_MAX) return "paths_many";
  if (s.run.kind === "rule" && !s.match) return "rule_empty";
  if (s.run.kind === "command") {
    if (!s.run.command) return "command";
    if (codePoints(s.run.command) > CUSTOM_STEP_COMMAND_MAX) return "command_long";
    if (s.run.cwd !== undefined && !globOk(s.run.cwd)) return "folder_bad";
    if (s.run.timeout_s !== undefined) {
      const range = customStepTimeout(s.at);
      if (!Number.isInteger(s.run.timeout_s) || s.run.timeout_s < range.min || s.run.timeout_s > range.max) return "timeout";
    }
  }
  if (s.run.kind === "model") {
    if (!s.run.prompt) return "prompt";
    if (codePoints(s.run.prompt) > CUSTOM_STEP_PROMPT_MAX) return "prompt_long";
  }
  return null;
}

/** The engine's difference with `step` put in: replaced where it stands, else added at the end. The others stay as they were. */
export function diffWithStep(diff: PlaybookDiff, own: readonly CustomStep[], step: CustomStep): PlaybookDiff {
  const steps = own.map(plainStep);
  const at = steps.findIndex((one) => one.id === step.id);
  const next = at >= 0 ? steps.map((one, index) => (index === at ? cleanStep(step) : one)) : [...steps, cleanStep(step)];
  return { ...diff, custom_steps: next };
}

/** The engine's difference without the step; the field itself goes when none is left. */
export function diffWithout(diff: PlaybookDiff, own: readonly CustomStep[], id: string): PlaybookDiff {
  const rest = own.filter((one) => one.id !== id).map(plainStep);
  const { custom_steps: _before, ...others } = diff;
  return rest.length > 0 ? { ...others, custom_steps: rest } : others;
}

/** Whether another step of your own can be added. */
export function canAdd(own: readonly unknown[]): boolean {
  return own.length < CUSTOM_STEPS_MAX;
}

/** A sample as the form holds it, to the API's: empty fields left out; null when nothing is filled in. */
export function sampleOf(form: { tool: CustomStepTool | ""; command: string; paths: string; reply: string }): CustomStepSample | undefined {
  const sample: CustomStepSample = {};
  if (form.tool) sample.tool = form.tool;
  if (form.command.trim()) sample.command = form.command.trim();
  const paths = pathLines(form.paths);
  if (paths.length > 0) sample.paths = paths;
  if (form.reply.trim()) sample.reply = form.reply;
  return Object.keys(sample).length > 0 ? sample : undefined;
}

/** Whether two steps are the same in every field the form edits. */
export function sameStep(a: CustomStep, b: CustomStep): boolean {
  return JSON.stringify(cleanStep(a)) === JSON.stringify(cleanStep(b));
}

/** The moment's "no" kinds, for the select. */
export function thensAt(at: CustomStepAt): readonly string[] {
  return CUSTOM_STEP_THENS_AT[at];
}
