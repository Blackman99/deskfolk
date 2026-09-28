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
  setups: {
    manual: { group: string; bots: BotProfile[] };
    coordinator: { bot: BotProfile; message: string };
    /** One generalist Bot, alone in your direct with it. Optional so other task sets still load. */
    solo?: { bot: BotProfile; message: string };
  };
};

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

/** The tasks `--only` names, in the set's order; an unknown id is an error, not an empty run. */
export function selectTasks(set: TaskSet, only: readonly string[] | null): GoldenTask[] {
  if (!only || only.length === 0) return set.tasks;
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
