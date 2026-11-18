/**
 * Grok's calls as the app's rules count them (ADR 0115). Grok names its tools and their input in
 * the hook it runs before each call (`toolName`, `toolInput`) and in its tool updates (`title` and
 * `rawInput` at first, `_meta["x.ai/tool"].name`): `read_file {target_file}`, `list_dir
 * {target_directory}`, `run_terminal_command {command}`, `write {file_path, content}`,
 * `search_replace {file_path, …}`, `monitor {command}`, `spawn_subagent {description, prompt}`
 * (measured on 1.0.89, 2026-11-18). A tool not named here is told by what it names: a path it would
 * change is a write, any other path a read, else nothing to check.
 */
import { pathsOf } from "../engine/agent/drivers/acp";
import { absoluteFrom, unwrapShell, type AppAction, type AppActionName } from "../engine/agent/policy";

/** Commands: what they run is the command. */
const SHELL_TOOLS = new Set(["run_terminal_command", "monitor", "run_terminal_cmd", "bash", "shell"]);
const READ_TOOLS = new Set(["read_file", "hashline_read", "view_image", "read_image"]);
const LIST_TOOLS = new Set(["list_dir", "grep", "hashline_grep", "glob", "file_search", "codebase_search", "lsp"]);
const WRITE_TOOLS = new Set(["write", "search_replace", "hashline_edit", "edit_notebook", "delete_file", "delete", "multi_edit", "apply_patch"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch", "x_keyword_search", "x_semantic_search", "x_user_search", "x_thread_fetch"]);
/**
 * Calls the app sees through a door of its own, with nothing of yours to check: its questions and
 * plan (cards), its to-do list, reading or ending what it runs in the background, starting a
 * subagent (whose own calls each come through the hook).
 */
const OWN_TOOLS = new Set(["ask_user_question", "exit_plan_mode", "enter_plan_mode", "todo_write", "get_command_or_subagent_output", "kill_command_or_subagent", "wait_commands_or_subagents", "spawn_subagent", "task"]);
/**
 * Work Grok schedules to go on after its reply, by itself (ADR 0115): a run's Grok ends with the
 * run, so it would stop without a word. Refused, with the reason told to Grok.
 */
export const GROK_SCHEDULING_TOOLS = new Set(["scheduler_create", "scheduler_update", "workflow", "loop", "goal"]);

const PATH_KEYS = ["target_file", "file_path", "path", "target_directory", "directory", "notebook_path"] as const;

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The tool's name in a tool update: Grok's own (`_meta["x.ai/tool"].name`), else its first title. */
export function grokToolName(update: Record<string, unknown>): string {
  const meta = (update._meta as { "x.ai/tool"?: { name?: unknown } } | undefined)?.["x.ai/tool"];
  return stringOf(meta?.name) ?? stringOf(update.title) ?? "tool";
}

/**
 * Whether a call is one the app answers through its own door (a card) or reads elsewhere: Grok's
 * own doors, and its skills (invoking one changes nothing; what the skill then does comes through
 * the hook call by call).
 */
export function isOwnTool(name: string): boolean {
  return OWN_TOOLS.has(name) || /(^|_)skills?($|_)/.test(name);
}

/** One of Grok's calls as the app's rules count it, from its tool's name and input. */
export function grokActionOf(name: string, input: Record<string, unknown>, cwd: string): AppAction {
  const where = stringOf(input.cwd) ?? stringOf(input.working_directory) ?? cwd;
  const named = PATH_KEYS.flatMap((key) => (stringOf(input[key]) ? [input[key] as string] : []));
  const paths = named.length > 0 ? named : pathsOf(input);
  const command = stringOf(input.command) ?? stringOf(input.cmd);
  let appName: AppActionName;
  if (SHELL_TOOLS.has(name) || (command && !READ_TOOLS.has(name) && !LIST_TOOLS.has(name) && !WRITE_TOOLS.has(name))) appName = "shell";
  else if (WRITE_TOOLS.has(name)) appName = "write_file";
  else if (READ_TOOLS.has(name)) appName = "read_file";
  else if (LIST_TOOLS.has(name)) appName = "list_dir";
  else if (WEB_TOOLS.has(name)) appName = "web";
  else if (OWN_TOOLS.has(name)) appName = "other";
  else if (paths.length > 0) appName = /write|edit|replace|delete|remove|move|rename|create|patch|mkdir|save|_gen$/i.test(name) ? "write_file" : "read_file";
  else appName = "other";
  return {
    appName, vendorTool: name,
    paths: appName === "shell" ? [] : paths.map((path) => absoluteFrom(where, path)),
    ...(appName === "shell" ? { command: unwrapShell(command ?? name) } : {}),
    cwd: where,
  };
}

/** A call's words on a card or in a refusal: the command, or the tool and what it names. */
export function grokCallText(action: AppAction): string {
  if (action.appName === "shell") return action.command ?? action.vendorTool;
  return action.paths.length > 0 ? `${action.vendorTool} ${action.paths.join(", ")}` : action.vendorTool;
}

/** What one approval covers once Grok asks again (a refused call comes back with a new id): the call's kind and what it names. */
export function grokActionKey(action: AppAction): string {
  return `${action.appName}\u0000${action.appName === "shell" ? action.command ?? "" : action.paths.join("\u0000")}`;
}
