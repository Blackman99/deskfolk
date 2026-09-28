import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";

export type ClassifiedPath =
  | { zone: "inside"; abs: string; rel: string }
  | { zone: "outside"; abs: string };

export type ClassifiedShell =
  | { kind: "jailed"; cwdAbs: string; cwdRel: string }
  | { kind: "unconstrained"; cwdAbs: string };

const EXEC_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
];

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

export function classifyPath(workspace: string, input: string): ClassifiedPath {
  const root = realpathSync(workspace);
  const expanded = expandHome(input);
  const rawAbs = isAbsolute(expanded) ? expanded : joinRaw(root, expanded);
  return walk(root, rawAbs);
}

export function classifyShell(workspace: string, command: string, cwd = "."): ClassifiedShell {
  const cwdClass = classifyPath(workspace, cwd);
  if (cwdClass.zone === "outside") {
    return { kind: "unconstrained", cwdAbs: cwdClass.abs };
  }
  for (const token of visiblePathTokens(command)) {
    if (isExecutablePrefix(token) || isHarmlessDevice(token) || namesNoRootEntry(token)) continue;
    const candidate =
      token.startsWith("/") || token.startsWith("~") ? token : joinRaw(cwdClass.abs, token);
    if (classifyPath(workspace, candidate).zone === "outside") {
      return { kind: "unconstrained", cwdAbs: cwdClass.abs };
    }
  }
  return { kind: "jailed", cwdAbs: cwdClass.abs, cwdRel: cwdClass.rel };
}

/**
 * An absolute path whose first name is not an entry of `/` on this machine: an HTML closing tag
 * in a script's string (`</h1>`), a `//` comment, a regex such as `/\s+/g`. Reading it fails,
 * and nothing can create it — `/` belongs to root, on the sealed system volume — so the command
 * cannot reach anything there. On 2026-09-28 almost half the approval cards in a benchmark run
 * were these, inside `python3 -c` and `node -e` scripts that only touched workspace files.
 * `/` itself and anything under an entry that exists (`/etc`, `/tmp`, `/Users`) still count.
 */
export function namesNoRootEntry(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const first = path.split("/").find((part) => part.length > 0);
  if (!first) return false;
  try {
    lstatSync(`/${first}`);
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

export function isHarmlessDevice(path: string): boolean {
  return HARMLESS_DEVICES.has(path) || /^\/dev\/fd\/\d+$/.test(path);
}

export function isExecutablePrefix(path: string): boolean {
  if (!path.startsWith("/")) return false;
  return EXEC_PREFIXES.some((pre) => path === pre.slice(0, -1) || path.startsWith(pre));
}

function walk(root: string, rawAbs: string): ClassifiedPath {
  const parts = rawAbs.split("/").filter(Boolean);
  let cursor = "/";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      cursor = cursor === "/" ? "/" : dirname(cursor);
      continue;
    }
    const next = cursor === "/" ? `/${seg}` : `${cursor}/${seg}`;
    let lst;
    try {
      lst = lstatSync(next);
    } catch {
      return finishMissing(root, cursor, parts.slice(i));
    }
    if (lst.isSymbolicLink()) {
      try {
        cursor = realpathSync(next);
      } catch {
        const text = readlinkSync(next);
        const target = isAbsolute(text) ? text : joinRaw(dirname(next), text);
        const rest = parts.slice(i + 1);
        const continued = rest.length ? joinRaw(target, rest.join("/")) : target;
        return walk(root, continued);
      }
      continue;
    }
    if (lst.isDirectory()) {
      try {
        cursor = realpathSync(next);
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

function finishMissing(root: string, existingCursor: string, remaining: string[]): ClassifiedPath {
  let existing = existingCursor;
  try {
    existing = realpathSync(existingCursor);
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
  const rel = relative(root, abs);
  if (rel === "") return ".";
  return rel.split(sep).join("/");
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
