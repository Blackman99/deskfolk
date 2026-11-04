/**
 * Steps of your own (ADR 0105): what an engine runs beside the app's own steps, at one of the
 * moments the app already has — before or after a call with an effect, as a turn ends, when work is
 * handed in, when you accept it or overturn it. A step says when it runs, which calls or files it
 * looks at, how it judges (a rule, a command of yours, a model reading your words), and what a
 * "no" does. What it does comes from a fixed list per moment: the step only judges, and the app's
 * own code refuses, sends back, holds a hand-over or tells you (ADR 0040: models and commands read
 * and propose, deterministic code writes state). A step that cannot judge — it timed out, would not
 * start, or its answer could not be read — lets things through and shows as an error on the flow.
 */

/** The moments a step can hang on, in the order a turn meets them. */
export const CUSTOM_STEP_ATS = ["before_effect", "after_effect", "turn_end", "handed_in", "accepted", "overturned"] as const;
export type CustomStepAt = (typeof CUSTOM_STEP_ATS)[number];

/** What a "no" can do. */
export const CUSTOM_STEP_THENS = ["refuse", "note", "send_back", "tell", "gate"] as const;
export type CustomStepThen = (typeof CUSTOM_STEP_THENS)[number];

/**
 * What a "no" may do at each moment. Before a call: refuse it, or let it through with the output
 * beside it. After one: the output beside its result. As a turn ends: send it back to go on, or tell
 * you. On a hand-in: hold it as a failed check would. Once you have accepted or overturned: tell you.
 */
export const CUSTOM_STEP_THENS_AT: Record<CustomStepAt, readonly CustomStepThen[]> = {
  before_effect: ["refuse", "note"],
  after_effect: ["note"],
  turn_end: ["send_back", "tell"],
  handed_in: ["gate"],
  accepted: ["tell"],
  overturned: ["tell"],
};

/** The moments that are about a job's hand-overs: in an engine with no jobs (ADR 0103) they never come. */
export const CUSTOM_STEP_JOB_ATS: readonly CustomStepAt[] = ["handed_in", "accepted", "overturned"];

/** The moments about one call, where a step can also say which tools it looks at. */
export const CUSTOM_STEP_CALL_ATS: readonly CustomStepAt[] = ["before_effect", "after_effect"];

/** The calls with an effect a step can name, by the app's name for them (a Claude Agent's Edit is `write_file`). */
export const CUSTOM_STEP_TOOLS = ["write_file", "delete_file", "shell", "mcp"] as const;
export type CustomStepTool = (typeof CUSTOM_STEP_TOOLS)[number];

/** How a step judges: by its match alone, by a command's exit code, or by a model reading your words. */
export const CUSTOM_STEP_RUN_KINDS = ["rule", "command", "model"] as const;
export type CustomStepRunKind = (typeof CUSTOM_STEP_RUN_KINDS)[number];

export const CUSTOM_STEPS_MAX = 12;
export const CUSTOM_STEP_NAME_MAX = 40;
export const CUSTOM_STEP_COMMAND_MAX = 1000;
export const CUSTOM_STEP_PROMPT_MAX = 4000;
export const CUSTOM_STEP_PATHS_MAX = 10;
export const CUSTOM_STEP_PATH_MAX = 300;

/**
 * How long a command may run, in seconds. Around a call it holds the Bot's next step, so it is
 * short; as a turn ends or on a hand-in it may run a test suite.
 */
export function customStepTimeout(at: CustomStepAt): { min: number; max: number; default: number } {
  return CUSTOM_STEP_CALL_ATS.includes(at) ? { min: 1, max: 60, default: 10 } : { min: 1, max: 600, default: 120 };
}

/**
 * Which calls or files a step looks at; absent, every one at its moment. `tools` only around a call.
 * `paths` are globs relative to the workspace: around a call its paths (a shell's has none), as a turn
 * ends the files it wrote, on a hand-in or after it the files handed in.
 */
export type CustomStepMatch = { tools?: CustomStepTool[]; paths?: string[] };

export type CustomStepRun =
  | { kind: "rule" }
  /** Exit 0 is a yes; anything else a no, its output's tail the reason. `cwd` is workspace-relative, the root when absent. */
  | { kind: "command"; command: string; cwd?: string; timeout_s?: number }
  /** Your words: the model is asked whether what happened keeps them, and why not. */
  | { kind: "model"; prompt: string };

export type CustomStep = {
  /** `u_` and letters or digits: never one of the app's own step ids. */
  id: string;
  name: string;
  on: boolean;
  at: CustomStepAt;
  match?: CustomStepMatch;
  run: CustomStepRun;
  then: CustomStepThen;
};

/** A step as the API shows an engine's: whether it runs there, which a moment about jobs does not where there are none. */
export type CustomStepView = CustomStep & { running: boolean };

/** What a step stood on when it ran, as its call record keeps it. */
export type CustomStepRef = { id: string; name: string; at: CustomStepAt };

const ID = /^u_[A-Za-z0-9]{8,32}$/;

export function isCustomStepId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isCustomStepAt(value: unknown): value is CustomStepAt {
  return typeof value === "string" && (CUSTOM_STEP_ATS as readonly string[]).includes(value);
}

/** Whether a step runs in an engine: switched on, and its moment comes there. */
export function customStepRuns(step: CustomStep, jobsOn: boolean): boolean {
  return step.on && (jobsOn || !CUSTOM_STEP_JOB_ATS.includes(step.at));
}

function codePoints(text: string): number {
  return [...text].length;
}

/** A path glob as a step takes it: relative to the workspace, inside it. */
function pathOk(glob: string): boolean {
  if (!glob.trim() || glob.startsWith("/") || glob.startsWith("~") || /^[A-Za-z]:[\\/]/.test(glob)) return false;
  return !glob.split(/[\\/]/).includes("..");
}

/**
 * The steps as the API takes them: each whole and in range, its "no" one its moment allows, a rule
 * only with something to match, ids unique. `fail` throws with what is wrong.
 */
export function validateCustomSteps(value: unknown, fail: (message: string) => never): CustomStep[] {
  if (!Array.isArray(value)) fail("diff.custom_steps must be a list");
  const list = value as unknown[];
  if (list.length > CUSTOM_STEPS_MAX) fail(`an engine has at most ${CUSTOM_STEPS_MAX} steps of your own`);
  const seen = new Set<string>();
  return list.map((raw, index) => {
    const where = `diff.custom_steps[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${where} must be an object`);
    const { id, name, on, at, match, run, then, ...rest } = raw as Record<string, unknown>;
    if (Object.keys(rest).length > 0) fail(`${where}: unknown field ${Object.keys(rest)[0]}`);
    if (!isCustomStepId(id)) fail(`${where}.id must be u_ and 8 to 32 letters or digits`);
    if (seen.has(id as string)) fail(`${where}.id ${id as string} is used twice`);
    seen.add(id as string);
    if (typeof name !== "string" || !name.trim()) fail(`${where}.name must be text`);
    if (codePoints((name as string).trim()) > CUSTOM_STEP_NAME_MAX) fail(`${where}.name is at most ${CUSTOM_STEP_NAME_MAX} characters`);
    if (typeof on !== "boolean") fail(`${where}.on must be true or false`);
    if (!isCustomStepAt(at)) fail(`${where}.at must be one of ${CUSTOM_STEP_ATS.join(", ")}`);
    const moment = at as CustomStepAt;
    if (typeof then !== "string" || !CUSTOM_STEP_THENS_AT[moment].includes(then as CustomStepThen)) {
      fail(`${where}.then must be one of ${CUSTOM_STEP_THENS_AT[moment].join(", ")} at ${moment}`);
    }
    const step: CustomStep = { id: id as string, name: (name as string).trim(), on: on as boolean, at: moment, run: { kind: "rule" }, then: then as CustomStepThen };
    if (match !== undefined) {
      if (!match || typeof match !== "object" || Array.isArray(match)) fail(`${where}.match must be an object`);
      const { tools, paths, ...other } = match as Record<string, unknown>;
      if (Object.keys(other).length > 0) fail(`${where}.match: unknown field ${Object.keys(other)[0]}`);
      const kept: CustomStepMatch = {};
      if (tools !== undefined) {
        if (!CUSTOM_STEP_CALL_ATS.includes(moment)) fail(`${where}.match.tools only applies before or after a call`);
        if (!Array.isArray(tools) || tools.some((tool) => !(CUSTOM_STEP_TOOLS as readonly unknown[]).includes(tool))) {
          fail(`${where}.match.tools must list some of ${CUSTOM_STEP_TOOLS.join(", ")}`);
        }
        const named = CUSTOM_STEP_TOOLS.filter((tool) => (tools as unknown[]).includes(tool));
        if (named.length > 0) kept.tools = named;
      }
      if (paths !== undefined) {
        if (!Array.isArray(paths)) fail(`${where}.match.paths must be a list`);
        if ((paths as unknown[]).length > CUSTOM_STEP_PATHS_MAX) fail(`${where}.match.paths has at most ${CUSTOM_STEP_PATHS_MAX} entries`);
        const globs = (paths as unknown[]).map((glob) => {
          if (typeof glob !== "string" || !pathOk(glob)) fail(`${where}.match.paths must be globs inside the workspace, like src/**/*.ts`);
          if (codePoints(glob as string) > CUSTOM_STEP_PATH_MAX) fail(`${where}.match.paths entries are at most ${CUSTOM_STEP_PATH_MAX} characters`);
          return (glob as string).trim();
        });
        if (globs.length > 0) kept.paths = [...new Set(globs)];
      }
      if (kept.tools || kept.paths) step.match = kept;
    }
    if (!run || typeof run !== "object" || Array.isArray(run)) fail(`${where}.run must be an object`);
    const { kind, command, cwd, timeout_s, prompt, ...more } = run as Record<string, unknown>;
    if (Object.keys(more).length > 0) fail(`${where}.run: unknown field ${Object.keys(more)[0]}`);
    if (kind === "rule") {
      if (command !== undefined || cwd !== undefined || timeout_s !== undefined || prompt !== undefined) fail(`${where}.run: a rule runs nothing`);
      if (!step.match) fail(`${where}: a rule needs something to match (tools or paths)`);
      step.run = { kind: "rule" };
    } else if (kind === "command") {
      if (prompt !== undefined) fail(`${where}.run: a command takes no prompt`);
      if (typeof command !== "string" || !command.trim()) fail(`${where}.run.command must be text`);
      if (codePoints(command as string) > CUSTOM_STEP_COMMAND_MAX) fail(`${where}.run.command is at most ${CUSTOM_STEP_COMMAND_MAX} characters`);
      const out: Extract<CustomStepRun, { kind: "command" }> = { kind: "command", command: (command as string).trim() };
      if (cwd !== undefined) {
        if (typeof cwd !== "string" || !pathOk(cwd) || codePoints(cwd) > CUSTOM_STEP_PATH_MAX) fail(`${where}.run.cwd must be a folder inside the workspace`);
        if ((cwd as string).trim() !== "." && (cwd as string).trim() !== "") out.cwd = (cwd as string).trim();
      }
      if (timeout_s !== undefined) {
        const range = customStepTimeout(moment);
        if (typeof timeout_s !== "number" || !Number.isInteger(timeout_s) || timeout_s < range.min || timeout_s > range.max) {
          fail(`${where}.run.timeout_s must be a whole number from ${range.min} to ${range.max} at ${moment}`);
        }
        if (timeout_s !== range.default) out.timeout_s = timeout_s as number;
      }
      step.run = out;
    } else if (kind === "model") {
      if (command !== undefined || cwd !== undefined || timeout_s !== undefined) fail(`${where}.run: a model step runs no command`);
      if (typeof prompt !== "string" || !prompt.trim()) fail(`${where}.run.prompt must be text`);
      if (codePoints(prompt as string) > CUSTOM_STEP_PROMPT_MAX) fail(`${where}.run.prompt is at most ${CUSTOM_STEP_PROMPT_MAX} characters`);
      step.run = { kind: "model", prompt: (prompt as string).trim() };
    } else {
      fail(`${where}.run.kind must be one of ${CUSTOM_STEP_RUN_KINDS.join(", ")}`);
    }
    return step;
  });
}

/** The steps with their fields in one order, so the same steps always read the same. */
export function compactCustomSteps(steps: readonly CustomStep[]): CustomStep[] {
  return steps.map((step) => {
    const match: CustomStepMatch | undefined = step.match
      ? {
        ...(step.match.tools?.length ? { tools: CUSTOM_STEP_TOOLS.filter((tool) => step.match!.tools!.includes(tool)) } : {}),
        ...(step.match.paths?.length ? { paths: [...step.match.paths] } : {}),
      }
      : undefined;
    const run: CustomStepRun = step.run.kind === "command"
      ? { kind: "command", command: step.run.command, ...(step.run.cwd ? { cwd: step.run.cwd } : {}), ...(step.run.timeout_s !== undefined ? { timeout_s: step.run.timeout_s } : {}) }
      : step.run.kind === "model" ? { kind: "model", prompt: step.run.prompt } : { kind: "rule" };
    return {
      id: step.id,
      name: step.name,
      on: step.on,
      at: step.at,
      ...(match && (match.tools || match.paths) ? { match } : {}),
      run,
      then: step.then,
    };
  });
}

/**
 * What a try from the panel judges a step on (`POST /v1/playbooks/:id/custom-steps/try`): around a
 * call, a tool and its files or command; as a turn ends, a reply and the files it wrote; on a hand-in
 * or after it, the files. A field left out is taken from what happened last (the newest shell command
 * the Bots ran, the newest reply, the newest hand-over), and the answer says what was used.
 */
export type CustomStepSample = { tool?: CustomStepTool; command?: string; paths?: string[]; reply?: string };

/** A step judged on a sample: nothing is refused, sent back or told, and nothing is recorded. */
export type CustomStepTry = {
  outcome: "pass" | "fail" | "error" | "blocked";
  reason: string | null;
  exit_code: number | null;
  /** A command's output (its tail) or the model's answer. */
  output: string | null;
  sample: CustomStepSample;
};
