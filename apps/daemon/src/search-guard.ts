/**
 * ADR 0040 P1, fixture F-g: refuse a recursive search rooted at your whole home folder or at `/`
 * before it runs, instead of asking for approval and then walking the folder once granted.
 *
 * On 2026-09-28 a Bot ran `grep -r "…" ~/`, which hit the shell's 10-minute timeout; that evening
 * it wrote the timeout into its memory, and the next morning it ran the same kind of search and
 * timed out again — a memory is text the Bot may or may not act on, not something the app enforces.
 * This guard judges only the resolved search root, never the command string: `cd ~ && grep -r . .`
 * resolves to the same root as `grep -r . ~`, and both are refused the same way `grep -r . ~` is.
 * A search bounded to a few levels (`find -maxdepth N`, `rg --max-depth N`, N ≤
 * {@link BOUNDED_DEPTH_MAX}) does not walk the tree and is let through. A
 * command this cannot parse — a pipe, a subshell, a backtick, `eval` — is left alone; if it then
 * runs long and times out, that is left for a later phase's failure-signature lesson, not caught
 * by this guard. It never grants a bypass: not the `force` a normal approval takes, not an
 * always-allow rule for `unconstrained-shell` — this refusal is unconditional.
 *
 * POSIX only (`toolShell().kind === "sh"`): the guarded tools (`grep`, `rg`, `find`, `du`, `ls`) are
 * Unix ones, and Windows' own path syntax needs its own walk if this is ever extended there.
 */
import { posix } from "node:path";
import { classifyPath, type PathHost, nodePathHost } from "./workspace-paths";

export type SearchGuardHit = {
  /** The tool that would have walked the tree: grep, rg, find, du or ls. */
  tool: string;
  /** Which boundary the resolved root hit. */
  target: "home" | "device";
  /** The resolved, symlink-followed root the search would have started from. */
  root: string;
  /**
   * How the root was reached: `cwd` when the command relied on the current or `cd`-ed-to
   * directory (no path operand, or a relative one like `.`), `arg` when it named the boundary
   * directly (`~`, `$HOME`, an absolute path, or `/`). The refusal's suggested fix reads this to
   * say "drop the cd" for the former and "name a subfolder" for the latter.
   */
  via: "cwd" | "arg";
};

const RECURSIVE_TOOLS = new Set(["grep", "rg", "find", "du", "ls"]);
/**
 * The deepest a `find -maxdepth` or `rg --max-depth` may go and still count as a look around, not a
 * walk of the tree: three levels under home is a few thousand entries, not the whole folder.
 */
export const BOUNDED_DEPTH_MAX = 3;
/** Prefixes that wrap the real command; skipped so the tool name underneath is still checked. */
const WRAPPER_COMMANDS = new Set(["time", "command", "nice", "timeout", "nohup"]);

/**
 * Whether `command`, read as a whole (after `cd` in it is followed and `~` / `$HOME` / `cwd` are
 * expanded), would start a recursive search of the home folder or of `/`. `cwdAbs` is the host
 * absolute path the shell actually starts in (the same one {@link classifyShell} resolves).
 */
export function recursiveSearchGuard(
  workspace: string,
  command: string,
  cwdAbs: string,
  host: PathHost = nodePathHost,
): SearchGuardHit | null {
  const segments = splitChain(command);
  if (!segments) return null;
  let cwd = cwdAbs;
  for (const segment of segments) {
    let tokens = stripEnvAssignments(shellWords(segment));
    tokens = stripWrappers(tokens);
    if (tokens.length === 0) continue;
    const [head, ...rest] = tokens;
    if (head === "cd") {
      const dest = rest[0];
      if (dest === "-") return null; // the previous directory: not something this can resolve statically
      cwd = resolveToken(dest ?? "~", cwd, host);
      continue;
    }
    // Anything that re-interprets its argument as more shell (or hands it to a subshell of its
    // own) is not something a fixed set of tool names can be checked against.
    if (head === "eval" || head === "xargs" || head === "sh" || head === "bash" || head === "env") return null;
    const tool = posix.basename(head);
    if (!RECURSIVE_TOOLS.has(tool)) continue;
    const args = stripRedirects(rest);
    if (!isRecursive(tool, args) || isShallow(tool, args)) continue;
    const paths = searchRoots(tool, args);
    // No path operand at all: every guarded tool searches the current directory by default.
    for (const token of paths.length > 0 ? paths : ["."]) {
      const abs = stripGlobRoot(resolveToken(token, cwd, host));
      const hit = classifyRoot(workspace, abs, host);
      if (hit) return { tool, target: hit, root: abs, via: tokenIsCwdRelative(token) ? "cwd" : "arg" };
    }
  }
  return null;
}

/** Whether `token` is read against the current directory, rather than naming a place on its own. */
function tokenIsCwdRelative(token: string): boolean {
  const namesItself = token.startsWith("~") || token.startsWith("$HOME") || token.startsWith("${HOME}") || token.startsWith("/");
  return !namesItself;
}

/** One line for the tool result: what would have run, and where to scope it instead. */
export function searchGuardMessage(hit: SearchGuardHit): string {
  const scope = hit.target === "device" ? "the whole disk (/)" : `your whole home folder (${hit.root})`;
  const fix =
    hit.via === "cwd"
      ? "drop the cd (or the directory this ran in) and search from the current task or plan directory instead."
      : "name a specific subfolder instead — one under the workspace, or a concrete folder under home.";
  return `refused before running: this ${hit.tool} call would recursively search ${scope}. Scope it: ${fix}`;
}

/**
 * `command` split on its top-level `&&` and `;`, the only chaining this guard follows. Null means
 * it saw something it will not parse — a pipe, a subshell (`(…)`, `` ` ``, `$(…)`), a background
 * `&`, or an unterminated quote — and the whole command is left to run unchecked. A comment (an
 * unquoted `#` that starts a word, up to the end of its line) is dropped first, as the shell drops
 * it: what it says, quotes, parens and pipes included, is never part of the command.
 */
function splitChain(command: string): string[] | null {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      // A comment runs to the end of its line; the newline itself still ends the segment.
      const eol = command.indexOf("\n", i);
      if (eol === -1) break;
      i = eol - 1;
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")" || ch === "|") return null;
    if (ch === "$" && command[i + 1] === "(") return null;
    if (ch === "&") {
      if (command[i + 1] === "&") {
        segments.push(cur);
        cur = "";
        i += 1;
        continue;
      }
      // `>&N` (duplicate a file descriptor) and `&>file` (redirect stdout+stderr): both use a
      // lone `&` as part of a redirect operator, not as backgrounding.
      if (cur.endsWith(">") || command[i + 1] === ">") {
        cur += ch;
        continue;
      }
      return null; // a backgrounded job: what runs next is not this command's business
    }
    if (ch === "\\" && command[i + 1] === "\n") {
      // A line continuation (a long command wrapped over two lines), not a separator: fold it to
      // a space so the wrapped command still reads as one segment.
      cur += " ";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  segments.push(cur);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whitespace-split, quotes stripped from around their content — same rule the shell itself uses. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** `FOO=bar grep -r x .`: the assignment is not the command. */
function stripEnvAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1;
  return words.slice(i);
}

/**
 * `time grep -r x .`, `timeout 30 grep -r x .`, `nice -n 10 grep -r x .`, `command grep -r x .`,
 * `nohup grep -r x .`: the wrapper is not the command being run. `timeout` takes the duration as
 * its own word (after any of its own flags), which is skipped along with the wrapper's name.
 */
function stripWrappers(tokens: string[]): string[] {
  let out = tokens;
  for (;;) {
    const head = out[0];
    if (head === undefined || !WRAPPER_COMMANDS.has(head)) return out;
    out = out.slice(1);
    if (head === "time") {
      if (out[0] === "-p") out = out.slice(1);
    } else if (head === "nice") {
      if (out[0] === "-n") out = out.slice(2);
      else if (/^-?\d+$/.test(out[0] ?? "")) out = out.slice(1);
    } else if (head === "timeout") {
      while (out[0]?.startsWith("-")) {
        out = out[0] === "-s" || out[0] === "--signal" || out[0] === "-k" || out[0] === "--kill-after" ? out.slice(2) : out.slice(1);
      }
      out = out.slice(1); // the duration itself
    }
  }
}

/**
 * A bare redirection operator and the token right after it (its target) are not path arguments.
 * `2>&1` (duplicate a file descriptor) is complete in one token — unlike a plain `>`/`>>`/`<`, it
 * has no separate target word to skip.
 */
function stripRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^\d?>&\d+$/.test(w)) continue;
    if (/^\d?>>?$|^&>>?$|^<$/.test(w)) {
      i += 1; // skip its target too, when the operator stands on its own
      continue;
    }
    if (/^\d?>>?[^\s>&]/.test(w) || /^&>>?[^\s]/.test(w)) continue; // glued, e.g. `>out.txt`, `2>err.log`, `&>out.txt`
    out.push(w);
  }
  return out;
}

/**
 * Whether grep is told to recurse: `-r`/`-R`/`--recursive`, or `-d recurse` / `--directories=recurse`
 * (BSD's spelling of the same). A cluster is read getopt's way — flags up to the first one that takes
 * a value, which takes the rest of the cluster (`-rA3`, `-drecurse`) or the next word.
 */
function grepRecurses(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return false;
    if (a === "--recursive" || a === "--dereference-recursive" || a === "--directories=recurse") return true;
    if (a === "--directories" && args[i + 1] === "recurse") return true;
    if (!/^-[a-zA-Z]/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]!;
      if (letter === "r" || letter === "R") return true;
      if (!GREP_VALUE_LETTERS.has(letter) && !GREP_OPTIONAL_LETTERS.has(letter)) continue;
      const value = j < a.length - 1 ? a.slice(j + 1) : args[i + 1];
      if (letter === "d" && value === "recurse") return true;
      break;
    }
  }
  return false;
}

function isRecursiveLsFlag(a: string): boolean {
  if (a === "--recursive") return true;
  return /^-[A-Za-z]+$/.test(a) && a.slice(1).includes("R"); // ls's `-r` is reverse sort, not recursion
}

function isRecursive(tool: string, args: string[]): boolean {
  switch (tool) {
    case "grep":
      return grepRecurses(args);
    case "ls":
      return args.some(isRecursiveLsFlag);
    case "rg":
    case "find":
    case "du":
      return true; // each of these walks a subtree by default
    default:
      return false;
  }
}

/**
 * Whether a `find` or `rg` is told to go at most {@link BOUNDED_DEPTH_MAX} levels down: find's
 * `-maxdepth N`, rg's `--max-depth N` / `--max-depth=N` (or `--maxdepth`, or `-d N`). Anything that
 * is not a plain number there leaves it unbounded.
 */
function isShallow(tool: string, args: string[]): boolean {
  const shallow = (value: string | undefined): boolean => value !== undefined && /^\d+$/.test(value) && Number(value) <= BOUNDED_DEPTH_MAX;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (tool === "find" && a === "-maxdepth") return shallow(args[i + 1]);
    if (tool === "rg") {
      if (a === "--max-depth" || a === "--maxdepth" || a === "-d") return shallow(args[i + 1]);
      const glued = /^(?:--max-?depth=|-d)(.+)$/.exec(a);
      if (glued) return shallow(glued[1]);
    }
  }
  return false;
}

/** grep's and rg's flags that take the next word as their value: a count, a glob, a type, a file of patterns. */
const GREP_VALUE_FLAGS = new Set(["--include", "--exclude", "--exclude-dir", "--after-context", "--before-context", "--max-count", "--file",
  "--devices", "--directories", "--label"]);
const RG_VALUE_FLAGS = new Set(["--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--max-count", "--max-columns", "--max-filesize",
  "--max-depth", "--maxdepth", "--threads", "--encoding", "--replace", "--context", "--after-context", "--before-context", "--file", "--pre", "--pre-glob",
  "--sort", "--sortr", "--colors", "--color", "--path-separator", "--ignore-file", "--context-separator", "--engine", "--dfa-size-limit", "--regex-size-limit"]);
/** The short ones; in a cluster only the last letter can take the next word (`-rnA 3`), and one glued on (`-A3`) takes none. */
const GREP_VALUE_LETTERS = new Set(["A", "B", "m", "f", "d", "D", "e"]);
/**
 * grep's context, whose number BSD grep takes only glued on (`-C2`, `--context=2`) and GNU grep also
 * as the next word: read both ways, and a root either reading finds counts.
 */
const GREP_OPTIONAL_LETTERS = new Set(["C"]);
const GREP_OPTIONAL_FLAGS = new Set(["--context"]);
const RG_VALUE_LETTERS = new Set(["A", "B", "C", "m", "f", "g", "t", "T", "M", "j", "E", "r", "d", "e"]);

/**
 * grep/rg: the first non-flag word is the pattern, unless one came another way — `-e`/`--regexp`, a
 * file of patterns (`-f`/`--file`), or rg's `--files`, which takes none; a flag's value is neither.
 * A cluster of short flags is read the way getopt reads it: left to right, and the first letter that
 * takes a value takes the rest of the cluster (`-tmd`, `-A3`), or the next word when it ends it
 * (`-rnA 3`, `-rf pats`).
 */
function grepPaths(tool: string, args: string[], optionalTakesNext: boolean): string[] {
  const longValued = tool === "rg" ? RG_VALUE_FLAGS : optionalTakesNext ? new Set([...GREP_VALUE_FLAGS, ...GREP_OPTIONAL_FLAGS]) : GREP_VALUE_FLAGS;
  const letters = tool === "rg" ? RG_VALUE_LETTERS : optionalTakesNext ? new Set([...GREP_VALUE_LETTERS, ...GREP_OPTIONAL_LETTERS]) : GREP_VALUE_LETTERS;
  const nonFlag: string[] = [];
  let explicitPattern = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      nonFlag.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (name === "--regexp" || name === "--file" || (tool === "rg" && name === "--files")) explicitPattern = true;
      if (!a.includes("=") && (longValued.has(a) || a === "--regexp")) i += 1;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j]!;
        if (!letters.has(letter)) continue;
        if (letter === "e" || letter === "f") explicitPattern = true;
        if (j === a.length - 1) i += 1;
        break;
      }
      continue;
    }
    nonFlag.push(a);
  }
  return explicitPattern ? nonFlag : nonFlag.slice(1);
}

/** How find is told to walk symlinks (-H/-L/-P) or is otherwise switched (macOS -E/-X/-d/-s/-x). */
const FIND_LEADING_FLAGS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);

/** find: every path operand comes before the first `-`-led predicate, after its own leading flags. */
function findPaths(args: string[]): string[] {
  let i = 0;
  while (FIND_LEADING_FLAGS.has(args[i] ?? "")) i += 1;
  const paths: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) break;
    paths.push(a);
  }
  return paths;
}

/** du/ls: whatever is not a flag is a path, in any order. */
function flatPaths(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** The search's path operands; empty means it defaults to the current directory. */
function searchRoots(tool: string, args: string[]): string[] {
  switch (tool) {
    case "grep":
      // Every root either reading of an optional value finds: a guard errs toward refusing.
      return [...new Set([...grepPaths(tool, args, true), ...grepPaths(tool, args, false)])];
    case "rg":
      return grepPaths(tool, args, true);
    case "find":
      return findPaths(args);
    default:
      return flatPaths(args);
  }
}

/**
 * `~/*` and `/*` name every entry directly under home or the device root, one by one — for a
 * recursive tool that's the same walk as the root itself, so a trailing bare `*` path component
 * is treated as its parent (`du -sh ~/*`, `grep -r x /*`).
 */
function stripGlobRoot(abs: string): string {
  return abs.endsWith("/*") ? abs.slice(0, -2) || "/" : abs;
}

/** `token` resolved to a host absolute path from `cwd`, expanding a leading `~`, `$HOME` or `${HOME}`. */
function resolveToken(token: string, cwd: string, host: PathHost): string {
  let t = token;
  if (t === "~") t = host.homedir();
  else if (t.startsWith("~/")) t = `${host.homedir()}/${t.slice(2)}`;
  else if (t === "$HOME" || t === "${HOME}") t = host.homedir();
  else if (t.startsWith("$HOME/")) t = `${host.homedir()}/${t.slice(6)}`;
  else if (t.startsWith("${HOME}/")) t = `${host.homedir()}/${t.slice(8)}`;
  return posix.resolve(cwd, t);
}

/**
 * Whether `abs` is one of the two guarded roots — the home folder's own root, or `/` — rather
 * than the workspace or somewhere inside it, which stay allowed. Symlinks are followed first
 * ({@link classifyPath} does that for both), so a workspace that happens to sit under a symlinked
 * home still compares the real paths.
 */
function classifyRoot(workspace: string, abs: string, host: PathHost): "home" | "device" | null {
  const classified = classifyPath(workspace, abs, host);
  if (classified.zone === "inside") return null;
  if (classified.abs === "/") return "device";
  let home: string;
  try {
    home = host.realpath(host.homedir());
  } catch {
    home = host.homedir();
  }
  return classified.abs === stripTrailingSlash(home) ? "home" : null;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Where a command ran or searched, as a lesson's signature tells places apart (ADR 0050). */
export type CommandPlace = "home" | "device" | "workspace" | "task" | "inside" | "outside" | "unknown";

/**
 * What kind of command this is, for a failure-signature lesson (ADR 0050; only a tree walk, `walks`,
 * is learned from): the program, `-r` when a search tool walks a tree (`-rn`, `-R` and `--recursive` are the same kind; a shallow `find` or
 * `rg` is not), else the program's first plain word (`git log`, `python render.py`); and the place
 * it searched or ran in — a class for the roots (home, `/`, the workspace root, the turn's own work
 * dir, whichever task that is), the folder itself anywhere deeper (workspace-relative, or `~/…`
 * outside it), so a search narrowed to a subfolder is a different kind of call. Quoted literals and
 * patterns never enter it. A pipeline is read by its first stage; a command too tangled to follow
 * keeps its program with an unknown place. `workDirRel` is the turn's work dir, workspace-relative.
 */
export function commandSignature(
  workspace: string,
  command: string,
  cwdAbs: string,
  workDirRel: string | null = null,
  host: PathHost = nodePathHost,
): { head: string; place: CommandPlace; signature: string; walks: boolean } | null {
  const stage = firstStage(command);
  const segments = splitChain(stage);
  const sign = (head: string, place: CommandPlace, at = "", walks = false) => ({ head, place, walks, signature: `${head}@${place}${at ? `:${at}` : ""}` });
  if (!segments) {
    const words = stripWrappers(stripEnvAssignments(shellWords(stage.replace(/[`()$|;&]/g, " "))));
    return words[0] ? sign(posix.basename(words[0]), "unknown") : null;
  }
  let cwd = cwdAbs;
  for (const segment of segments) {
    const tokens = stripWrappers(stripEnvAssignments(shellWords(segment)));
    if (tokens.length === 0) continue;
    const [first, ...rest] = tokens;
    if (first === "cd") {
      if (rest[0] === "-") return sign("cd", "unknown");
      cwd = resolveToken(rest[0] ?? "~", cwd, host);
      continue;
    }
    const program = posix.basename(first!);
    const args = stripRedirects(rest);
    if (RECURSIVE_TOOLS.has(program)) {
      const walks = isRecursive(program, args) && !isShallow(program, args);
      const roots = searchRoots(program, args);
      // Several roots: the widest is what made it long.
      const [place, at] = (roots.length > 0 ? roots : ["."])
        .map((root) => placeOf(workspace, stripGlobRoot(resolveToken(root, cwd, host)), workDirRel, host))
        .sort((a, b) => PLACE_RANK[a[0]] - PLACE_RANK[b[0]])[0]!;
      return sign(walks ? `${program} -r` : program, place, at, walks);
    }
    const operand = args[0] && !args[0].startsWith("-") && /^[\w./-]{1,60}$/.test(args[0]) ? ` ${posix.basename(args[0])}` : "";
    return sign(`${program}${operand}`, ...placeOf(workspace, cwd, workDirRel, host));
  }
  return null;
}

/** A pipeline's first stage: the command up to its first unquoted lone `|` (an `||` is a chain, not a pipe). */
function firstStage(command: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "|") {
      if (command[i + 1] === "|") {
        i += 1;
        continue;
      }
      return command.slice(0, i);
    }
  }
  return command;
}

/** Widest first: which of several search roots a lesson is about. */
const PLACE_RANK: Record<CommandPlace, number> = { device: 0, home: 1, workspace: 2, outside: 3, task: 4, inside: 5, unknown: 6 };

/** The place's class, and the folder itself when it is not one of the roots. */
function placeOf(workspace: string, abs: string, workDirRel: string | null, host: PathHost): [CommandPlace, string] {
  const root = classifyRoot(workspace, abs, host);
  if (root) return [root, ""];
  let classified;
  try {
    classified = classifyPath(workspace, abs, host);
  } catch {
    return ["unknown", ""];
  }
  if (classified.zone === "outside") {
    const home = stripTrailingSlash(host.homedir());
    return ["outside", classified.abs.startsWith(`${home}/`) ? `~/${classified.abs.slice(home.length + 1)}` : classified.abs];
  }
  const rel = stripTrailingSlash(classified.rel.replace(/^\.\/?/, ""));
  if (rel === "") return ["workspace", ""];
  const dir = workDirRel?.replace(/^\.\/?/, "").replace(/\/$/, "");
  if (dir && rel === dir) return ["task", ""];
  return [dir && rel.startsWith(`${dir}/`) ? "task" : "inside", rel];
}
