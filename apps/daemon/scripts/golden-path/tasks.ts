/**
 * The golden-path benchmark's task set: what each job seeds into the workspace, the one line you
 * post in the group, how the team is formed in each setup, and what the judge and the checks hold
 * the result to. `parseTaskSet` is pure so the shape rules are unit-tested; `loadTaskSet` adds the
 * file reads (the seed folder and its brief must exist).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const SETUPS = ["manual", "coordinator", "solo"] as const;
export type Setup = (typeof SETUPS)[number];

export type BotProfile = { name: string; duties: string; boundaries: string };

/** A deterministic look at one delivered text file. Regexes are case-insensitive and multiline. */
export type FileCheck = { path: string; contains: string[]; matches: string[]; not_matches: string[] };

/** A command the runner itself runs in the workspace once the job has settled and the team is gone. */
export type VerifyStep = {
  /** Workspace-relative directory to run in. */
  cwd: string;
  /** argv; a leading `bun` runs the Bun that runs this script. */
  command: string[];
  expect_exit: number;
  /** Compared after normalising line endings and trailing whitespace; null skips the comparison. */
  expect_stdout: string | null;
  timeout_sec: number;
};

export type GoldenTask = {
  id: string;
  title: string;
  /** Folder next to the task file whose whole tree is copied to the workspace root. */
  seed: string;
  /** The brief inside the seed; the judge reads the seed's copy, not the workspace's. */
  brief: string;
  /** What you post in the group. Never an @: nobody is told who does which step. */
  message: string;
  goal: string;
  acceptance: string[];
  rules: string[];
  /** Workspace-relative files that must exist and be non-empty. */
  deliverables: string[];
  checks: FileCheck[];
  verify: VerifyStep[];
  /** Timed follow-up lines; empty for the office tasks, non-empty for the S/R/G-shaped tasks (cross-stop, repeat-note, big-room). */
  script: ScriptStep[];
  /** Set for L: the runner registers a delayed-completion media MCP server before posting the task. */
  mcp: TaskMcp | null;
  /**
   * True for a task that must be named explicitly (via `--only`, or a `--tasks` file of its own) to
   * run: the default (no `--only`) selection leaves it out. The L/S/R/G benchmark families are
   * `extra` — they widen the default paid sweep with a roster `--setup all` can't fully use (no
   * `setups.solo`), so they stay opt-in the same way the issue that added them always meant to run
   * them (`--only long-mission,cross-stop,repeat-note,big-room`).
   */
  extra: boolean;
  setups: {
    manual: { group: string; bots: BotProfile[] };
    coordinator: { bot: BotProfile; message: string };
    /** One generalist Bot, alone in your direct with it. Optional so other task sets still load. */
    solo?: { bot: BotProfile; message: string };
  };
};

/**
 * A follow-up line the runner posts on its own, timed off the run's clock or off the first file the
 * team hands over — the L/S/R/G benchmark families need one (a stop mid-job, the same complaint
 * again, an unrelated new ask or a line that just continues the kickoff job) without a human typing
 * it. `after` decides when; `target` decides which session it lands in.
 */
export type ScriptTrigger = { kind: "seconds"; after_s: number } | { kind: "first_delivery" };
export type ScriptTarget = { kind: "group" } | { kind: "coordinator" } | { kind: "bot_direct"; bot: string };
export type ScriptStep = {
  id: string;
  after: ScriptTrigger;
  target: ScriptTarget;
  body: string;
  /** Which Bot this line is expected to wake — informational, read back for the run log from the
   *  turns it triggered and the judgements that joined it. Which Bot answers is participation, not
   *  attribution, so it is not what G scores (see `expect_plan`). */
  expect_bot: string | null;
  /**
   * G's real labelled attribution: whether this line should end up filed on the plan the task line
   * itself opened ("kickoff") or split into a different one ("new"). Scored against
   * `messages.task_id` after the run — see `attribution.ts`.
   */
  expect_plan: "kickoff" | "new" | null;
};

/** L's fake async job: `mcp-fixture.ts --media --video-polls=N` registered as an MCP server. */
export type TaskMcp = { video_polls: number };

export type TaskSet = { version: 1; tasks: GoldenTask[] };

export const DEFAULT_VERIFY_TIMEOUT_SEC = 120;
const MAX_VERIFY_TIMEOUT_SEC = 600;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class TaskSetError extends Error {}

function fail(where: string, message: string): never {
  throw new TaskSetError(`${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(where, "must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(where, "must be a non-empty string");
  return value;
}

function texts(value: unknown, where: string, { nonEmpty }: { nonEmpty: boolean }): string[] {
  if (value === undefined && !nonEmpty) return [];
  if (!Array.isArray(value)) fail(where, "must be an array of strings");
  if (nonEmpty && value.length === 0) fail(where, "must not be empty");
  return value.map((item, i) => text(item, `${where}[${i}]`));
}

/** A path the team could have written: relative, inside the workspace, no `..`. */
export function isWorkspaceRelative(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== ".." && part !== "");
}

/** Whether a line names someone: `@Name` or `@everyone`. The golden path posts without one. */
export function mentionsSomeone(line: string): boolean {
  return /(^|[\s（(，,。：:])@\S/.test(line);
}

function workspacePath(value: unknown, where: string, { dot }: { dot: boolean }): string {
  const path = text(value, where).trim();
  if (dot && path === ".") return path;
  if (!isWorkspaceRelative(path)) fail(where, "must be a workspace-relative path without ..");
  return path;
}

function regexes(value: unknown, where: string): string[] {
  const list = texts(value, where, { nonEmpty: false });
  list.forEach((source, i) => {
    try {
      new RegExp(source, "mi");
    } catch (error) {
      fail(`${where}[${i}]`, `is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  return list;
}

function bot(value: unknown, where: string): BotProfile {
  const row = record(value, where);
  return {
    name: text(row.name, `${where}.name`).trim(),
    duties: text(row.duties, `${where}.duties`),
    boundaries: text(row.boundaries, `${where}.boundaries`),
  };
}

function check(value: unknown, where: string): FileCheck {
  const row = record(value, where);
  const out: FileCheck = {
    path: workspacePath(row.path, `${where}.path`, { dot: false }),
    contains: texts(row.contains, `${where}.contains`, { nonEmpty: false }),
    matches: regexes(row.matches, `${where}.matches`),
    not_matches: regexes(row.not_matches, `${where}.not_matches`),
  };
  if (out.contains.length + out.matches.length + out.not_matches.length === 0) fail(where, "checks nothing");
  return out;
}

function verifyStep(value: unknown, where: string): VerifyStep {
  const row = record(value, where);
  const command = texts(row.command, `${where}.command`, { nonEmpty: true });
  const exit = row.expect_exit ?? 0;
  if (typeof exit !== "number" || !Number.isInteger(exit) || exit < 0 || exit > 255) fail(`${where}.expect_exit`, "must be an integer 0–255");
  const stdout = row.expect_stdout ?? null;
  if (stdout !== null && typeof stdout !== "string") fail(`${where}.expect_stdout`, "must be a string");
  const timeout = row.timeout_sec ?? DEFAULT_VERIFY_TIMEOUT_SEC;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_VERIFY_TIMEOUT_SEC) {
    fail(`${where}.timeout_sec`, `must be a number of seconds up to ${MAX_VERIFY_TIMEOUT_SEC}`);
  }
  return { cwd: workspacePath(row.cwd ?? ".", `${where}.cwd`, { dot: true }), command, expect_exit: exit, expect_stdout: stdout, timeout_sec: timeout };
}

function scriptTrigger(value: unknown, where: string): ScriptTrigger {
  const row = record(value, where);
  if (row.kind === "seconds") {
    const s = row.after_s;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0) fail(`${where}.after_s`, "must be a non-negative number of seconds");
    return { kind: "seconds", after_s: s };
  }
  if (row.kind === "first_delivery") return { kind: "first_delivery" };
  fail(`${where}.kind`, "must be seconds or first_delivery");
}

/**
 * `bot_direct` names one of `setups.manual.bots`. The runner looks that name's direct-with-you
 * session up once the team has formed (`resolveBotDirects`), so the step fires under `manual` and
 * `coordinator` alike, whoever created the Bot; it is skipped, with a log line, only when no Bot of
 * that name exists by then.
 */
function scriptTarget(value: unknown, where: string, botNames: ReadonlySet<string>): ScriptTarget {
  const row = record(value, where);
  if (row.kind === "group") return { kind: "group" };
  if (row.kind === "coordinator") return { kind: "coordinator" };
  if (row.kind === "bot_direct") {
    const name = text(row.bot, `${where}.bot`).trim();
    if (!botNames.has(name)) fail(`${where}.bot`, `${name} is not one of setups.manual.bots`);
    return { kind: "bot_direct", bot: name };
  }
  fail(`${where}.kind`, "must be group, coordinator or bot_direct");
}

function scriptStep(value: unknown, where: string, botNames: ReadonlySet<string>): ScriptStep {
  const row = record(value, where);
  const id = text(row.id, `${where}.id`).trim();
  const body = text(row.body, `${where}.body`);
  if (mentionsSomeone(body)) fail(`${where}.body`, "must not @ anyone: nobody is told who does which step");
  let expectBot: string | null = null;
  if (row.expect_bot !== undefined && row.expect_bot !== null) {
    expectBot = text(row.expect_bot, `${where}.expect_bot`).trim();
    if (!botNames.has(expectBot)) fail(`${where}.expect_bot`, `${expectBot} is not one of setups.manual.bots`);
  }
  let expectPlan: "kickoff" | "new" | null = null;
  if (row.expect_plan !== undefined && row.expect_plan !== null) {
    if (row.expect_plan !== "kickoff" && row.expect_plan !== "new") fail(`${where}.expect_plan`, "must be kickoff or new");
    expectPlan = row.expect_plan;
  }
  return {
    id,
    after: scriptTrigger(row.after, `${where}.after`),
    target: scriptTarget(row.target, `${where}.target`, botNames),
    body,
    expect_bot: expectBot,
    expect_plan: expectPlan,
  };
}

function optionalBool(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(where, "must be a boolean");
  return value;
}

function taskMcp(value: unknown, where: string): TaskMcp {
  const row = record(value, where);
  const polls = row.video_polls;
  if (typeof polls !== "number" || !Number.isInteger(polls) || polls < 0) fail(`${where}.video_polls`, "must be a non-negative integer");
  return { video_polls: polls };
}

function task(value: unknown, where: string): GoldenTask {
  const row = record(value, where);
  const id = text(row.id, `${where}.id`).trim();
  if (!TASK_ID.test(id)) fail(`${where}.id`, "must be lowercase letters, digits and dashes");
  const message = text(row.message, `${where}.message`);
  if (mentionsSomeone(message)) fail(`${where}.message`, "must not @ anyone: nobody is told who does which step");
  const setups = record(row.setups, `${where}.setups`);
  const manual = record(setups.manual, `${where}.setups.manual`);
  if (!Array.isArray(manual.bots) || manual.bots.length < 2) fail(`${where}.setups.manual.bots`, "a group needs at least two Bots");
  const bots = manual.bots.map((item, i) => bot(item, `${where}.setups.manual.bots[${i}]`));
  const names = new Set<string>();
  for (const [i, profile] of bots.entries()) {
    if (names.has(profile.name)) fail(`${where}.setups.manual.bots[${i}].name`, `${profile.name} is listed twice`);
    names.add(profile.name);
  }
  const coordinator = record(setups.coordinator, `${where}.setups.coordinator`);
  const lead = bot(coordinator.bot, `${where}.setups.coordinator.bot`);
  if (names.has(lead.name)) fail(`${where}.setups.coordinator.bot.name`, "must differ from the teammates it hires");
  const leadMessage = text(coordinator.message, `${where}.setups.coordinator.message`);
  if (mentionsSomeone(leadMessage)) fail(`${where}.setups.coordinator.message`, "must not @ anyone");
  let solo: { bot: BotProfile; message: string } | undefined;
  if (setups.solo !== undefined) {
    const soloRow = record(setups.solo, `${where}.setups.solo`);
    const soloBot = bot(soloRow.bot, `${where}.setups.solo.bot`);
    const soloMessage = text(soloRow.message, `${where}.setups.solo.message`);
    if (mentionsSomeone(soloMessage)) fail(`${where}.setups.solo.message`, "must not @ anyone: it works alone, nobody to address");
    solo = { bot: soloBot, message: soloMessage };
  }
  const brief = workspacePath(row.brief ?? "brief.md", `${where}.brief`, { dot: false });
  const script = (Array.isArray(row.script) ? row.script : row.script === undefined ? [] : fail(`${where}.script`, "must be an array")).map(
    (item, i) => scriptStep(item, `${where}.script[${i}]`, names),
  );
  const stepIds = new Set<string>();
  for (const [i, step] of script.entries()) {
    if (stepIds.has(step.id)) fail(`${where}.script[${i}].id`, `${step.id} is used twice`);
    stepIds.add(step.id);
  }
  const mcp = row.mcp === undefined || row.mcp === null ? null : taskMcp(row.mcp, `${where}.mcp`);
  return {
    id,
    title: text(row.title, `${where}.title`).trim(),
    seed: workspacePath(row.seed ?? id, `${where}.seed`, { dot: false }),
    brief,
    message,
    goal: text(row.goal, `${where}.goal`).trim(),
    acceptance: texts(row.acceptance, `${where}.acceptance`, { nonEmpty: true }),
    rules: texts(row.rules, `${where}.rules`, { nonEmpty: false }),
    deliverables: texts(row.deliverables, `${where}.deliverables`, { nonEmpty: true }).map((path, i) =>
      workspacePath(path, `${where}.deliverables[${i}]`, { dot: false }),
    ),
    checks: (Array.isArray(row.checks) ? row.checks : row.checks === undefined ? [] : fail(`${where}.checks`, "must be an array")).map(
      (item, i) => check(item, `${where}.checks[${i}]`),
    ),
    verify: (Array.isArray(row.verify) ? row.verify : row.verify === undefined ? [] : fail(`${where}.verify`, "must be an array")).map(
      (item, i) => verifyStep(item, `${where}.verify[${i}]`),
    ),
    script,
    mcp,
    extra: optionalBool(row.extra, `${where}.extra`),
    setups: {
      manual: { group: text(manual.group, `${where}.setups.manual.group`).trim(), bots },
      coordinator: { bot: lead, message: leadMessage },
      ...(solo ? { solo } : {}),
    },
  };
}

export function parseTaskSet(raw: unknown): TaskSet {
  const root = record(raw, "task set");
  if (root.version !== 1) fail("version", "must be 1");
  if (!Array.isArray(root.tasks) || root.tasks.length === 0) fail("tasks", "must be a non-empty array");
  const tasks = root.tasks.map((item, i) => task(item, `tasks[${i}]`));
  const seen = new Set<string>();
  for (const [i, item] of tasks.entries()) {
    if (seen.has(item.id)) fail(`tasks[${i}].id`, `${item.id} is used twice`);
    seen.add(item.id);
  }
  return { version: 1, tasks };
}

/**
 * The tasks `--only` names, in the set's order; an unknown id is an error, not an empty run. With
 * no `--only`, every task except one marked `extra` (see `GoldenTask.extra`) — naming one by id is
 * how you ask for it.
 */
export function selectTasks(set: TaskSet, only: readonly string[] | null): GoldenTask[] {
  if (!only || only.length === 0) return set.tasks.filter((task) => !task.extra);
  const known = new Set(set.tasks.map((item) => item.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new TaskSetError(`unknown task id(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
  const wanted = new Set(only);
  return set.tasks.filter((item) => wanted.has(item.id));
}

/** `manual|coordinator|solo|both|all`, comma-separated; `both` = manual+coordinator, `all` = every setup. */
export function parseSetups(value: string): Setup[] {
  const wanted = new Set<Setup>();
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const name of names) {
    if (name === "both") {
      wanted.add("manual");
      wanted.add("coordinator");
    } else if (name === "all") {
      for (const setup of SETUPS) wanted.add(setup);
    } else if ((SETUPS as readonly string[]).includes(name)) {
      wanted.add(name as Setup);
    } else {
      throw new TaskSetError(`--setup must be manual, coordinator, solo, both or all (comma-separated), not ${name}`);
    }
  }
  if (wanted.size === 0) throw new TaskSetError(`--setup must be manual, coordinator, solo, both or all (comma-separated), not ${JSON.stringify(value)}`);
  return SETUPS.filter((setup) => wanted.has(setup));
}

/** `solo` needs every selected task to carry `setups.solo`; the other setups are required by the schema already. */
export function requireSetups(tasks: readonly GoldenTask[], setups: readonly Setup[]): void {
  if (!setups.includes("solo")) return;
  for (const task of tasks) {
    if (!task.setups.solo) throw new TaskSetError(`${task.id} has no setups.solo`);
  }
}

export type LoadedTaskSet = { set: TaskSet; file: string; dir: string };

export function seedDir(loaded: LoadedTaskSet, item: GoldenTask): string {
  return join(loaded.dir, item.seed);
}

/** Reads and validates a task file; every seed folder and its brief must be there. */
export function loadTaskSet(file: string): LoadedTaskSet {
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TaskSetError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const set = parseTaskSet(raw);
  const dir = dirname(path);
  const loaded = { set, file: path, dir };
  for (const item of set.tasks) {
    const seed = seedDir(loaded, item);
    if (relative(dir, seed).startsWith("..")) throw new TaskSetError(`${item.id}: seed must stay next to the task file`);
    if (!existsSync(seed) || !statSync(seed).isDirectory()) throw new TaskSetError(`${item.id}: seed folder ${seed} is missing`);
    if (!existsSync(join(seed, item.brief))) throw new TaskSetError(`${item.id}: brief ${item.brief} is not in the seed folder`);
  }
  return loaded;
}
