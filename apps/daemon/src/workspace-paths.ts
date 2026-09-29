import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type ClassifiedPath =
  | { zone: "inside"; abs: string; rel: string }
  | { zone: "outside"; abs: string };

export type ClassifiedShell =
  | { kind: "jailed"; cwdAbs: string; cwdRel: string }
  | { kind: "unconstrained"; cwdAbs: string };

/**
 * The file system a path is classified against, and whose rules it follows. Production uses this
 * machine ({@link nodePathHost}); tests hand in a Windows one over a fake file system, since the
 * win32 rules have to hold on a Mac too.
 */
export type PathHost = {
  platform: NodeJS.Platform;
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  realpath(path: string): string;
  readlink(path: string): string;
  homedir(): string;
  /**
   * What names the file itself rather than its spelling (volume and file id). Only Windows asks,
   * to tell the workspace spelled in another case from a different folder in a case-sensitive
   * one; without it such a spelling is outside.
   */
  fileId?(path: string): string;
};

export const nodePathHost: PathHost = {
  platform: process.platform,
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
  readlink: (path) => readlinkSync(path, "utf8"),
  homedir: () => homedir(),
  fileId: (path) => {
    const st = statSync(path, { bigint: true });
    // A file system that reports no file ids still has one real path per file.
    return st.ino === 0n ? `path:${realpathSync(path)}` : `${st.dev}:${st.ino}`;
  },
};

/**
 * The shell that will read a command. Unknown means every shell it could be: on Windows a `/x`
 * is Git Bash's `/x` and PowerShell's `\x` at once, and both have to stay inside.
 */
export type ShellKind = "sh" | "bash" | "powershell";

const EXEC_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
];

export function expandHome(path: string, host: PathHost = nodePathHost): string {
  if (path === "~") return host.homedir();
  if (host.platform === "win32") {
    return /^~[\\/]/.test(path) ? winJoin(host.homedir(), path.slice(2)) : path;
  }
  if (path.startsWith("~/")) return `${host.homedir()}/${path.slice(2)}`;
  return path;
}

export function classifyPath(workspace: string, input: string, host: PathHost = nodePathHost): ClassifiedPath {
  if (host.platform === "win32") return classifyWin(workspace, input, host);
  const root = host.realpath(workspace);
  const expanded = expandHome(input, host);
  const rawAbs = posix.isAbsolute(expanded) ? expanded : joinRaw(root, expanded);
  return walk(host, root, rawAbs);
}

export function classifyShell(
  workspace: string,
  command: string,
  cwd = ".",
  host: PathHost = nodePathHost,
  shell?: ShellKind,
): ClassifiedShell {
  const cwdClass = classifyPath(workspace, cwd, host);
  if (cwdClass.zone === "outside") {
    return { kind: "unconstrained", cwdAbs: cwdClass.abs };
  }
  const stays = host.platform === "win32"
    ? winCommandStaysInside(workspace, command, cwdClass.abs, host, shell)
    : commandStaysInside(workspace, command, cwdClass.abs, host);
  if (!stays) return { kind: "unconstrained", cwdAbs: cwdClass.abs };
  return { kind: "jailed", cwdAbs: cwdClass.abs, cwdRel: cwdClass.rel };
}

function commandStaysInside(workspace: string, command: string, cwdAbs: string, host: PathHost): boolean {
  for (const token of visiblePathTokens(command)) {
    if (isExecutablePrefix(token, host.platform) || isHarmlessDevice(token, host.platform) || namesNoRootEntry(token, host)) {
      continue;
    }
    const candidate =
      token.startsWith("/") || token.startsWith("~") ? token : joinRaw(cwdAbs, token);
    if (classifyPath(workspace, candidate, host).zone === "outside") return false;
  }
  return true;
}

/**
 * An absolute path whose first name is not an entry of `/` on this machine: an HTML closing tag
 * in a script's string (`</h1>`), a `//` comment, a regex such as `/\s+/g`. Reading it fails,
 * and nothing can create it — `/` belongs to root, on the sealed system volume — so the command
 * cannot reach anything there. On 2026-09-28 almost half the approval cards in a benchmark run
 * were these, inside `python3 -c` and `node -e` scripts that only touched workspace files.
 * `/` itself and anything under an entry that exists (`/etc`, `/tmp`, `/Users`) still count.
 * POSIX only: Windows commands go through {@link winCommandStaysInside}.
 */
export function namesNoRootEntry(path: string, host: PathHost = nodePathHost): boolean {
  if (!path.startsWith("/")) return false;
  const first = path.split("/").find((part) => part.length > 0);
  if (!first) return false;
  try {
    host.lstat(`/${first}`);
    return false;
  } catch {
    return true;
  }
}

/** The null device, the standard streams and the random sources hold nothing of the user's. */
const HARMLESS_DEVICES = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
]);

export function isHarmlessDevice(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (HARMLESS_DEVICES.has(path) || /^\/dev\/fd\/\d+$/.test(path)) return true;
  // Git Bash keeps the `/dev` names above; cmd and PowerShell have their own null device.
  return platform === "win32" && /^(?:nul:?|\\\\\.\\nul|\$null)$/i.test(path);
}

export function isExecutablePrefix(path: string, platform: NodeJS.Platform = process.platform): boolean {
  // Git Bash's `/usr/bin` is Git's own folder, not the system's; on Windows a program path is
  // classified like any other path.
  if (platform === "win32") return false;
  if (!path.startsWith("/")) return false;
  return EXEC_PREFIXES.some((pre) => path === pre.slice(0, -1) || path.startsWith(pre));
}

/** An absolute path on this host: `/x`, or on Windows `C:\x`, `C:/x` and `\\server\share\x`. */
export function isAbsoluteHostPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return path.startsWith("/");
  return winSplit(path).kind === "absolute";
}

/** The root an absolute host path hangs from: `/`, or on Windows `C:\` or `\\server\share\`. */
export function hostPathRoot(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "/";
  const split = winSplit(path);
  if (split.kind !== "absolute") throw new Error("not an absolute host path");
  return split.root;
}

/**
 * Whether `abs` is `root` or somewhere under it, compared the way the platform's file system
 * compares names: exactly here, regardless of case on Windows. Both are absolute host paths.
 */
export function isWithinPath(root: string, abs: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return isInside(root, abs);
  const r = winNormal(root);
  const a = winNormal(abs);
  return r !== null && a !== null && winWithin(winFormat(r), winFormat(a));
}

/** `abs` relative to `root`, `/`-separated the way workspace paths are stored on every platform. */
export function workspaceRelative(root: string, abs: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.relative(root, abs).split(path.sep).join("/");
}

/** A folder written so a name can follow it: `/ws/`, or `C:\ws\` on Windows. */
export function asFolder(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return `${path}/`;
  return /[\\/]$/.test(path) ? path : `${path}\\`;
}

function walk(host: PathHost, root: string, rawAbs: string): ClassifiedPath {
  const parts = rawAbs.split("/").filter(Boolean);
  let cursor = "/";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      cursor = cursor === "/" ? "/" : posix.dirname(cursor);
      continue;
    }
    const next = cursor === "/" ? `/${seg}` : `${cursor}/${seg}`;
    let lst;
    try {
      lst = host.lstat(next);
    } catch {
      return finishMissing(host, root, cursor, parts.slice(i));
    }
    if (lst.isSymbolicLink()) {
      try {
        cursor = host.realpath(next);
      } catch {
        const text = host.readlink(next);
        const target = posix.isAbsolute(text) ? text : joinRaw(posix.dirname(next), text);
        const rest = parts.slice(i + 1);
        const continued = rest.length ? joinRaw(target, rest.join("/")) : target;
        return walk(host, root, continued);
      }
      continue;
    }
    if (lst.isDirectory()) {
      try {
        cursor = host.realpath(next);
      } catch {
        cursor = next;
      }
    } else {
      cursor = next;
    }
  }
  if (isInside(root, cursor)) return { zone: "inside", abs: cursor, rel: posixRel(root, cursor) };
  return { zone: "outside", abs: cursor };
}

function finishMissing(host: PathHost, root: string, existingCursor: string, remaining: string[]): ClassifiedPath {
  let existing = existingCursor;
  try {
    existing = host.realpath(existingCursor);
  } catch {
    // keep
  }
  const stack = existing === "/" ? [""] : existing.split("/");
  for (let i = 0; i < remaining.length; i++) {
    const seg = remaining[i]!;
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      const prefixParts = existing === "/" ? [""] : existing.split("/");
      if (stack.length <= prefixParts.length) {
        const abs = joinFromStack(applyRest(stack.slice(0, -1), remaining.slice(i + 1)));
        return { zone: "outside", abs: abs || "/" };
      }
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  const abs = joinFromStack(stack);
  if (isInside(root, abs)) return { zone: "inside", abs, rel: posixRel(root, abs) };
  return { zone: "outside", abs };
}

function applyRest(stack: string[], rest: string[]): string[] {
  const next = [...stack];
  for (const seg of rest) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (next.length > 1) next.pop();
      continue;
    }
    next.push(seg);
  }
  return next;
}

function joinFromStack(stack: string[]): string {
  if (stack.length === 0 || (stack.length === 1 && stack[0] === "")) return "/";
  return stack.join("/") || "/";
}

function joinRaw(base: string, rel: string): string {
  if (rel.length === 0) return base;
  if (base.endsWith("/")) return `${base}${rel}`;
  return `${base}/${rel}`;
}

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function posixRel(root: string, abs: string): string {
  const rel = posix.relative(root, abs);
  if (rel === "") return ".";
  return rel.split(posix.sep).join("/");
}

function visiblePathTokens(command: string): string[] {
  const out: string[] = [];
  for (const token of shellTokens(command)) {
    for (const candidate of pathCandidates(token)) {
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
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
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * A token that is a relative path as written: a slash, no shell syntax, and names in any script
 * (work dirs are named after the plan's title, which is often Chinese). A colon stays out, so
 * `host:/etc/passwd` is still looked into below.
 */
const RELATIVE_PATH = /^[^\s'"`$|&;<>(){}*?\\:]+$/u;

/** Web addresses name nothing on this machine; `file://` ones do, so those are left in. */
const WEB_URL = /\b(?:https?|wss?|ftp):\/\/[^\s'"`)]*/gi;

/**
 * A path starts a token, or follows a quote, a bracket, a redirection, a separator or an
 * assignment inside one (`open('/etc/passwd')`, `2>/dev/null`, `open('../../x')`); a slash
 * between two names is not one.
 */
const EMBEDDED_PATH = /(?:^|[=:<>(\[{,;|&'"`])(~\/[^'"`\s);|&<>]+|\/[^'"`\s);|&<>]+|\.\.(?:\/[^'"`\s);|&<>]*)?)/g;

function pathCandidates(token: string): string[] {
  const t = token.replace(/^[`'"]+|[`'"]+$/g, "").replace(WEB_URL, "");
  const out: string[] = [];
  const eq = t.indexOf("=");
  if (eq >= 0 && eq < t.length - 1) {
    out.push(...pathCandidates(t.slice(eq + 1)));
  }
  if (
    t.startsWith("/") ||
    t.startsWith("~") ||
    t === "." ||
    t === ".." ||
    t.startsWith("./") ||
    t.startsWith("../")
  ) {
    out.push(t);
  } else if (t.startsWith("-")) {
    // An option with its value glued on: `-o/tmp/x`, `-I../include`.
    const rest = t.replace(/^-+[A-Za-z0-9]*/, "");
    if (rest && rest !== t) out.push(...pathCandidates(rest));
  } else if (t.includes("/") && RELATIVE_PATH.test(t)) {
    out.push(t);
  } else {
    for (const m of t.matchAll(EMBEDDED_PATH)) out.push(m[1]!);
  }
  return out;
}

// Windows ----------------------------------------------------------------------------------------
//
// A root is a drive (`C:\`) or a share (`\\server\share\`); `\` and `/` both separate; names
// compare regardless of case. The `abs` handed back is native (`C:\ws\notes\a.md`) and is what the
// caller opens, so a spelling Win32 would quietly rewrite (a trailing dot, `CON`) is never placed.

/** A clean absolute Windows path: its root and the names under it, no `.` or `..`. */
type WinAbs = { root: string; parts: string[] };

type WinSplit =
  | { kind: "absolute"; root: string; rest: string }
  /** `C:x` or `C:` alone: from that drive's own current folder, which only the process knows. */
  | { kind: "drive"; root: string; rest: string }
  /** `\x`: the root of whatever drive the reader is on. */
  | { kind: "rooted"; rest: string }
  | { kind: "relative"; rest: string }
  /** `\\.\PhysicalDrive0`, `\\?\Volume{…}\`, `\??\`: no folder a walk can place. */
  | { kind: "device" };

const MAX_LINK_HOPS = 40;

/** Device names Win32 opens in any folder, with any extension: `C:\ws\nul.txt` is not a file. */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:[ .].*)?$/i;

function winSplit(path: string): WinSplit {
  let p = path;
  // The long-path forms name the same files as the plain ones.
  if (/^\\\\\?\\UNC\\/i.test(p)) p = `\\\\${p.slice(8)}`;
  else if (/^\\\\\?\\[A-Za-z]:(?:\\|$)/.test(p)) p = p.slice(4);
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(p) || p.startsWith("\\??\\")) return { kind: "device" };
  if (/^[\\/]{2}/.test(p)) {
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/s.exec(p);
    if (!unc) return { kind: "device" };
    return { kind: "absolute", root: `\\\\${unc[1]}\\${unc[2]}\\`, rest: unc[3]! };
  }
  const drive = /^([A-Za-z]):(.*)$/s.exec(p);
  if (drive) {
    const root = `${drive[1]!.toUpperCase()}:\\`;
    const rest = drive[2]!;
    return /^[\\/]/.test(rest) ? { kind: "absolute", root, rest } : { kind: "drive", root, rest };
  }
  if (/^[\\/]/.test(p)) return { kind: "rooted", rest: p };
  return { kind: "relative", rest: p };
}

function winParts(rest: string): string[] {
  return rest.split(/[\\/]+/).filter(Boolean);
}

function winFormat(path: WinAbs): string {
  return path.root + path.parts.join("\\");
}

function winJoin(base: string, rest: string): string {
  if (rest.length === 0) return base;
  return /[\\/]$/.test(base) ? `${base}${rest}` : `${base}\\${rest}`;
}

/** An absolute path (a realpath, a workspace) in the one shape the walk compares; null if it is not one. */
function winNormal(path: string): WinAbs | null {
  const split = winSplit(path);
  if (split.kind !== "absolute") return null;
  const parts: string[] = [];
  for (const seg of winParts(split.rest)) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return { root: split.root, parts };
}

/**
 * Where `input` points when read from `base`, before any link is followed. `C:x` is taken from
 * the drive's root: the drive's current folder is the process's business, and the path handed
 * back is the one that gets opened.
 */
function winAnchor(input: string, base: WinAbs): WinAbs | null {
  const split = winSplit(input);
  switch (split.kind) {
    case "device":
      return null;
    case "absolute":
    case "drive":
      return { root: split.root, parts: winParts(split.rest) };
    case "rooted":
      return { root: base.root, parts: winParts(split.rest) };
    case "relative":
      return { root: base.root, parts: [...base.parts, ...winParts(split.rest)] };
  }
}

/** A name Win32 opens as written: no trailing dot or space it would trim, no stream, no device. */
function winNameOk(seg: string): boolean {
  if (seg === "." || seg === "..") return true;
  return !/[<>:"|?*\x00-\x1f]/.test(seg) && !/[. ]$/.test(seg) && !WIN_RESERVED.test(seg);
}

function classifyWin(workspace: string, input: string, host: PathHost): ClassifiedPath {
  const base = winNormal(host.realpath(workspace));
  if (!base) throw new Error("the workspace is not an absolute path");
  const start = winAnchor(expandHome(input, host), base);
  if (!start) return { zone: "outside", abs: input };
  return winWalk(host, winFormat(base), start, 0);
}

function winWalk(host: PathHost, root: string, start: WinAbs, hops: number): ClassifiedPath {
  if (hops > MAX_LINK_HOPS || !start.parts.every(winNameOk)) return { zone: "outside", abs: winFormat(start) };
  const parts = start.parts;
  let cursor = start.root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      cursor = win32.dirname(cursor);
      continue;
    }
    const next = winJoin(cursor, seg);
    let lst;
    try {
      lst = host.lstat(next);
    } catch {
      return winFinishMissing(host, root, cursor, parts.slice(i));
    }
    let real: string;
    try {
      // Files too: a reparse point lstat does not call a link still resolves here.
      real = host.realpath(next);
    } catch {
      if (!lst.isSymbolicLink()) {
        cursor = next;
        continue;
      }
      // A dangling link or junction is classified from where it says it goes.
      const target = winAnchor(host.readlink(next), winNormal(cursor)!);
      if (!target) return { zone: "outside", abs: next };
      return winWalk(host, root, { root: target.root, parts: [...target.parts, ...parts.slice(i + 1)] }, hops + 1);
    }
    const normal = winNormal(real);
    if (!normal) return { zone: "outside", abs: real };
    cursor = winFormat(normal);
  }
  return winPlace(host, root, cursor);
}

function winFinishMissing(host: PathHost, root: string, existingCursor: string, remaining: string[]): ClassifiedPath {
  let existing = winNormal(existingCursor)!;
  try {
    const real = host.realpath(existingCursor);
    const normal = winNormal(real);
    if (!normal) return { zone: "outside", abs: real };
    existing = normal;
  } catch {
    // keep
  }
  const stack = [...existing.parts];
  for (let i = 0; i < remaining.length; i++) {
    const seg = remaining[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      // Climbing out of the last folder that exists is not followed back in.
      if (stack.length <= existing.parts.length) {
        const parts = [...stack.slice(0, -1)];
        for (const rest of remaining.slice(i + 1)) {
          if (rest === "..") parts.pop();
          else if (rest !== ".") parts.push(rest);
        }
        return { zone: "outside", abs: winFormat({ root: existing.root, parts }) };
      }
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return winPlace(host, root, winFormat({ root: existing.root, parts: stack }));
}

function winPlace(host: PathHost, root: string, abs: string): ClassifiedPath {
  if (!winWithin(root, abs)) return { zone: "outside", abs };
  const head = abs.slice(0, root.length);
  // The same letters in another case are the same folder, unless the folder above is one of
  // Windows' case-sensitive ones: then only the file system can say.
  if (head !== root && !sameFile(host, head, root)) return { zone: "outside", abs };
  if (abs.length === root.length) return { zone: "inside", abs, rel: "." };
  const rel = abs.slice(root.endsWith("\\") ? root.length : root.length + 1).split("\\").join("/");
  return { zone: "inside", abs, rel };
}

function sameFile(host: PathHost, a: string, b: string): boolean {
  if (!host.fileId) return false;
  try {
    return host.fileId(a) === host.fileId(b);
  } catch {
    return false;
  }
}

/** Both are in {@link winFormat}'s shape. */
function winWithin(root: string, abs: string): boolean {
  const r = foldCase(root);
  const a = foldCase(abs);
  return a === r || a.startsWith(r.endsWith("\\") ? r : `${r}\\`);
}

/** Lower case one character at a time, so offsets in the folded string still line up with the original. */
function foldCase(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

// What a Windows command names ------------------------------------------------------------------
//
// The shell there is Git Bash or PowerShell, and whatever either runs (cmd, a native program)
// reads its own arguments. So a token is looked into for every spelling of a path any of them
// takes, and anything that cannot be placed counts as outside.

/**
 * Ends a path inside a token: whitespace (a quoted command string for a nested shell), quotes,
 * brackets, redirections, separators, assignments, and `@` (`curl -d @C:\x`, PowerShell's `@(…)`).
 */
const WIN_TERMINATORS = /[\s=,;|&<>(){}\[\]'"`@]+/;

/** PowerShell's own drives that name no folder of the user's workspace. */
const PS_DRIVES = new Set(["alias", "cert", "env", "function", "hkcr", "hkcu", "hklm", "hku", "registry", "temp", "variable", "wsman"]);

/** PowerShell variables that hold a folder, whatever their case. */
const PS_FOLDER_VARIABLES = new Set(["home", "pshome", "profile", "psscriptroot", "pscommandpath"]);

/** `cd` alone goes home in Git Bash, `cd -` to wherever the shell was before: folders no path names. */
const CD_WORDS = new Set(["cd", "chdir", "pushd", "sl", "set-location", "push-location"]);

const WILDCARD_NAME = "real-bot-wildcard";

function winCommandStaysInside(
  workspace: string,
  command: string,
  cwdAbs: string,
  host: PathHost,
  shell: ShellKind | undefined,
): boolean {
  const tokens = shellTokens(command);
  if (winChangesDirectoryUnnamed(tokens)) return false;
  const cwd = winNormal(cwdAbs);
  if (!cwd) return false;
  for (const token of tokens) {
    const candidates = winPathCandidates(token);
    if (candidates === null) return false;
    for (const candidate of candidates) {
      const targets = winShellTargets(winTrimProse(candidate), cwd, shell);
      if (targets === "skip") continue;
      if (targets === "outside") return false;
      for (const target of targets) {
        const concrete = winWithoutWildcards(target);
        if (concrete === null) return false;
        if (classifyPath(workspace, concrete, host).zone === "outside") return false;
      }
    }
  }
  return true;
}

/** A `cd` at the start of a command with no folder after it, or PowerShell's own `cd..` and `cd\`. */
function winChangesDirectoryUnnamed(tokens: string[]): boolean {
  // A quoted string with spaces may be a command of its own: `pwsh -Command "cd; Get-Content x"`.
  const words = tokens.flatMap((token) => {
    const inner = token.split(/\s+/).filter(Boolean);
    return inner.map((text, i) => ({ text, nested: inner.length > 1 && i === 0 }));
  });
  let start = true;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!.text.toLowerCase();
    const word = raw.replace(/^[({]+/, "");
    const bare = word.replace(/[;&|)}]+$/, "");
    const atStart = start || words[i]!.nested || word !== raw;
    start = bare !== word || bare === "";
    if (!atStart) continue;
    if (/^(?:cd|chdir)(?:\.\.|[\\/])/.test(bare)) return true;
    if (!CD_WORDS.has(bare)) continue;
    if (bare !== word) return true;
    const next = words[i + 1]?.text;
    if (next === undefined || /^[;&|)}]/.test(next) || next === "-" || next === "--" || next === "+") return true;
  }
  return false;
}

/**
 * An environment or shell variable in a path, or one standing alone as an argument, can put the
 * command anywhere: `%USERPROFILE%\x`, `$env:APPDATA`, `$HOME/.ssh`, `cd $home`. Lower-case
 * one-word variables standing alone (`$f` in a loop, `$null`, `$_`) are the script's own.
 */
function winEnvReference(token: string): boolean {
  if (/%[A-Za-z_][\w()]+%/.test(token) || /\$\{?env:/i.test(token)) return true;
  // .NET's ways to the user's folders, which PowerShell reaches without a path in sight.
  if (/GetFolderPath|GetEnvironmentVariable|ExpandEnvironmentVariables|GetTempPath/i.test(token)) return true;
  const inPath = /[\\/]/.test(token);
  for (const match of token.matchAll(/\$\{?(\w+)/g)) {
    const name = match[1]!;
    if (inPath) return true;
    if (/^(?=.*[A-Z])[A-Z_][A-Z0-9_]*$/.test(name) || PS_FOLDER_VARIABLES.has(name.toLowerCase())) return true;
  }
  return false;
}

/** Everything in a token that may be read as a path, or null when it cannot be placed at all. */
function winPathCandidates(token: string): string[] | null {
  const t = token.replace(/^[`'"]+|[`'"]+$/g, "").replace(WEB_URL, "");
  if (winEnvReference(t)) return null;
  // A PowerShell provider path other than the file system's: `Registry::HKEY_CURRENT_USER\x`.
  if (/(?:^|[\\/\s(])(?!filesystem::)[A-Za-z]\w*::/i.test(t)) return null;
  const out: string[] = [];
  const add = (candidate: string) => {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  const pieces = (text: string, split: RegExp) => text.split(split).filter(Boolean);
  // A quoted path with spaces, as a whole, when it reads like one.
  for (const whole of pieces(t, /[=,;|&<>(){}\[\]'"`@]+/)) {
    if (/\s/.test(whole) && (winStartsLikePath(whole) || (/[\\/]/.test(whole) && !whole.includes(":")))) add(whole);
  }
  for (const piece of pieces(t, WIN_TERMINATORS)) {
    add(piece);
    // After a colon that is not a drive's own: `-Path:C:\x`, `-LiteralPath:~\x`, `host:/etc/passwd`.
    for (let k = piece.indexOf(":"); k >= 0; k = piece.indexOf(":", k + 1)) {
      const drive = /[A-Za-z]/.test(piece[k - 1] ?? "") && (k === 1 || piece[k - 2] === ":");
      if (!drive) add(piece.slice(k + 1));
    }
    // An option with its value glued on: `-o/tmp/x`, `-I..\include`, `-IC:\include`.
    const glued = /^-+([A-Za-z0-9]*)(.*)$/s.exec(piece);
    if (glued) {
      const letters = glued[1]!;
      const rest = glued[2]!;
      add(rest);
      // `-IC:\x` is `-I` and `C:\x`; `-Path:x` is a named value, found after its colon above.
      if (/[A-Za-z]$/.test(letters) && /^:[\\/]/.test(rest)) add(letters.slice(-1) + rest);
    }
  }
  return out;
}

function winStartsLikePath(text: string): boolean {
  return /^(?:[A-Za-z]:|[\\/~]|\.\.?(?:[\\/]|$))/.test(text);
}

/**
 * What Win32 would open for a candidate written in prose or with a stream: `notes\a.md.` is
 * `notes\a.md`, and `tests\a.py::test_x` (a stream, or pytest's node id) is a file in `tests`.
 */
function winTrimProse(candidate: string): string {
  // The colon of a drive (`C:`, PowerShell's `HKCU:`) is not a stream's.
  const drive = /^[A-Za-z][\w-]*:/.exec(candidate)?.[0].length ?? 0;
  const colon = candidate.indexOf(":", drive);
  const cut = colon >= 0 ? candidate.slice(0, colon) : candidate;
  return cut.replace(/(?<=[^\\/.])[. ]+$/, "");
}

/**
 * The paths a candidate names from `cwd`: absolute or `~` ones for {@link classifyPath}, or
 * "outside" for what cannot be placed. `/x` is Git Bash's (`/c/Users` is `C:\Users`; anything
 * else sits under Git's own root) and PowerShell's (`\x` on the current drive) at once.
 */
function winShellTargets(c: string, cwd: WinAbs, shell: ShellKind | undefined): string[] | "outside" | "skip" {
  if (!c || isHarmlessDevice(c, "win32")) return "skip";
  if (/^[A-Za-z]:/.test(c)) return /^[A-Za-z]:[\\/]/.test(c) ? [c] : "outside";
  const drive = /^([A-Za-z][\w-]+):([\\/]|$)/.exec(c);
  if (drive && (drive[2] || PS_DRIVES.has(drive[1]!.toLowerCase()))) return "outside";
  if (/^[\\/]{2}/.test(c)) return "outside";
  if (c.startsWith("\\")) return [cwd.root + c.slice(1)];
  if (c.startsWith("/")) {
    const targets: string[] = [];
    if (shell !== "bash") targets.push(cwd.root + c.slice(1));
    if (shell !== "powershell") {
      const bash = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(c);
      if (!bash) return "outside";
      targets.push(`${bash[1]!.toUpperCase()}:\\${bash[2] ?? ""}`);
    }
    return targets;
  }
  if (c === "~" || /^~[\\/]/.test(c)) return [c];
  if (c.startsWith("~")) return "outside";
  if (/^\.\.?(?:[\\/]|$)/.test(c) || /[\\/]/.test(c)) return [winJoin(winFormat(cwd), c)];
  return "skip";
}

/** A wildcard matches names inside its own folder, never `..`, unless it may start with a dot. */
function winWithoutWildcards(path: string): string | null {
  if (!/[*?]/.test(path)) return path;
  let dotted = false;
  const concrete = path.replace(/[^\\/]*[*?][^\\/]*/g, (seg) => {
    if (seg.startsWith(".")) dotted = true;
    return WILDCARD_NAME;
  });
  return dotted ? null : concrete;
}
