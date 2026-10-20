/**
 * Where a tool call of a project session's agent works (ADR 0095), for the task map: what a file
 * tool names, or, for a shell command, the place most of its paths are in. Read from the call's
 * input alone, never the disk; a command's words decide its kind, and the command itself is never
 * carried on.
 */
import { posix } from "node:path";
import type { AgentShellAction, AgentToolPlace } from "@real-bot/protocol";

export type PlaceContext = {
  /** The project session's directory: paths in it are given relative to it. */
  projectDir: string;
  /** The call's own working directory, which relative paths are read from. */
  cwd: string;
  home: string;
  /** Claude account directories besides `~/.claude*`: their files are Claude Code's own too. */
  configDirs?: string[];
};

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Grep", "Glob", "LS"]);
const EXT = "(?:ts|tsx|js|mjs|cjs|svelte|json|jsonl|md|css|py|sh|sql|txt|rs|toml|yaml|yml|html|swift|go)";
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()=,[\]{}`]+)/g;
const TEST = /\b(bun test|pnpm (run )?test|npm (run )?test|yarn test|vitest|jest|playwright|typecheck|svelte-check|tsc\b|cargo test|pytest|go test)/;
const TYPECHECK = /typecheck|svelte-check|\btsc\b/;
const GIT = /(^|[;&|]\s*|\s)git\s/;
const LOOKING = /\b(rg|grep|sed|cat|ls|find)\b/;

/** A path made absolute from `base`, `~` read as home, `.` and `..` folded away. */
function resolve(raw: string, base: string, home: string): string {
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? posix.join(home, raw.slice(2)) : raw;
  return posix.resolve(base, expanded);
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** An absolute path as a place: in the project, among Claude Code's own files, or elsewhere. */
export function placeOfPath(abs: string, ctx: Pick<PlaceContext, "projectDir" | "home" | "configDirs">): AgentToolPlace {
  const project = posix.resolve(ctx.projectDir);
  if (within(abs, project)) return { zone: "project", path: posix.relative(project, abs) };
  const fromHome = within(abs, ctx.home) ? posix.relative(ctx.home, abs) : null;
  if ((fromHome !== null && /^\.claude[\w-]*(\.json)?(\/|$)/.test(fromHome)) || (ctx.configDirs ?? []).some((dir) => within(abs, dir))) {
    return { zone: "claude_home", path: abs };
  }
  return { zone: "outside", path: abs };
}

/** What a shell command did, by its words: a check, git, a write, a search, a read, a script, or something else. */
export function shellActionOf(command: string): AgentShellAction {
  if (TEST.test(command)) return "check";
  if (GIT.test(command)) return "git";
  // Much of an agent's editing goes through the shell: a script that writes, sed -i, a redirect into a file.
  if (/cat\s*>|\btee\s|sed\s+-i|perl\s+-[pi]|\.write_text\(|\.write\(|open\([^)]*['"][wa]['"]|>\s*[\w./-]+\.(?:ts|svelte|md|json|css)\b/.test(command)) return "write";
  if (/\b(rg|grep|find|ls)\b/.test(command)) return "search";
  if (/\b(cat|sed|head|tail|wc)\b/.test(command)) return "read";
  if (/\b(bun|node|python3?|deno)\b/.test(command)) return "script";
  return "run";
}

/**
 * Where a shell command works: a test or type check and git are places of their own; otherwise
 * the place most of the paths it names are in (a file counts for its folder), the later one on a
 * tie; with none, where it runs (after a `cd`).
 */
export function placeOfCommand(command: string, ctx: PlaceContext): AgentToolPlace {
  if (TEST.test(command)) return { zone: "check", check: TYPECHECK.test(command) ? "typecheck" : "test" };
  if (GIT.test(command) && !LOOKING.test(command.split("git")[0] ?? "")) return { zone: "git" };
  let base = ctx.cwd;
  const cd = /\bcd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (cd) base = resolve(cd[1] ?? cd[2] ?? cd[3]!, ctx.cwd, ctx.home);
  const named: AgentToolPlace[] = [];
  const keys: string[] = [];
  for (const match of command.matchAll(TOKEN)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token || token.startsWith("-") || token.includes("://")) continue;
    const fileLike = new RegExp(`\\.${EXT}(:\\d+)?$`).test(token);
    if (!token.includes("/") && !fileLike) continue;
    let place: AgentToolPlace;
    let key: string;
    if (token.startsWith("$")) {
      // A shell variable: somewhere, but not a place this command's words can say.
      place = { zone: "outside", path: token };
      key = "outside:$";
    } else {
      const abs = resolve(token.replace(/:\d+$/, ""), base, ctx.home);
      place = placeOfPath(abs, ctx);
      key = `${place.zone}:${fileLike ? posix.dirname(abs) : abs}`;
    }
    named.push(place);
    keys.push(key);
  }
  if (named.length === 0) return placeOfPath(base, ctx);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const top = Math.max(...counts.values());
  for (let i = keys.length - 1; i >= 0; i -= 1) if (counts.get(keys[i]!) === top) return named[i]!;
  return named.at(-1)!;
}

/** Where one tool call works, from its name and input. */
export function placeOfCall(tool: string, input: Record<string, unknown>, ctx: PlaceContext): { place: AgentToolPlace; action?: AgentShellAction } {
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return { place: placeOfCommand(command, ctx), action: shellActionOf(command) };
  }
  if (FILE_TOOLS.has(tool)) {
    const named = ["file_path", "notebook_path", "path"].map((key) => input[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return { place: placeOfPath(resolve(named?.trim() ?? ".", ctx.cwd, ctx.home), ctx) };
  }
  return { place: { zone: "none" } };
}

/** The file a call names, its last name only, or null; a command's last named file. */
export function fileOfCall(tool: string, input: Record<string, unknown>): string | null {
  let path = ["file_path", "notebook_path", "path"].map((key) => input[key]).find((value): value is string => typeof value === "string") ?? "";
  if (!path && tool === "Bash" && typeof input.command === "string") {
    path = input.command.match(new RegExp(`[\\w\\-./]+\\.${EXT}\\b`, "g"))?.at(-1) ?? "";
  }
  const base = posix.basename(path.replace(/\/+$/, ""));
  return base && /^[\w\-.·]+$/.test(base) && base.length <= 60 ? base : null;
}
