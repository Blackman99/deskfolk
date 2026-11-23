/**
 * Where your local agents keep what signs them in and how they are set up (ADR 0061, ADR 0079):
 * off limits to every Bot, whichever agent runs it — a Bot on Codex reads no more of `~/.claude`
 * than one on Claude Code reads of `~/.codex`. Refused outright, never carded: an approval would be
 * you letting one agent read another's (or its own) credentials. Pure, like the rest of the policy:
 * home, platform and the listed account directories come in, so the rules are tested on a fake disk.
 */
import { posix } from "node:path";
import { asksKeychainForSecret, isKeychainPath } from "../../keychains";
import { isAbsoluteHostPath, isWithinPath, workspaceRelative } from "../../workspace-paths";

/**
 * Each agent's own directories and files under your home folder, as POSIX-style relative paths.
 * `.claude.json` also covers its backups (`.claude.json.backup`); a directory covers everything in it.
 */
const AGENT_HOME_ENTRIES = [
  ".claude", ".claude.json",
  ".codex",
  ".grok",
  ".gemini",
  ".dsh",
  ".zcode",
  ".config/opencode", ".local/share/opencode", ".local/state/opencode",
] as const;

/**
 * What an agent reads of its own install as it works, and may: Grok reads the skills it ships with
 * (`~/.grok/bundled/skills/**`) through the app's file reads. Reading these is no crossing out of
 * the workspace you would want a card for; writing them still is.
 */
const AGENT_OWN_READABLE = [".grok/bundled"] as const;

function homeRelative(abs: string, home: string, platform: NodeJS.Platform): string | null {
  if (!isAbsoluteHostPath(abs, platform)) return null;
  const norm = platform === "win32" ? abs : posix.resolve(abs);
  if (!isWithinPath(home, norm, platform)) return null;
  const rel = workspaceRelative(home, norm, platform).replace(/\\/g, "/");
  // Names compare as the file system does: regardless of case on Windows (and on macOS's default disk
  // too, but a lower-case spelling there is the one every agent writes).
  return platform === "win32" ? rel.toLowerCase() : rel;
}

function under(rel: string, entry: string): boolean {
  return rel === entry || rel.startsWith(`${entry}/`) || (entry.endsWith(".json") && rel.startsWith(`${entry}.`));
}

/**
 * A path in one of your agents' own directories, the keychains, or a config directory you listed
 * for one of your accounts (`configDirs`). Grok's shipped skills are not among them
 * ({@link isAgentOwnReadable}).
 */
export function isAgentCredentialPath(abs: string, home: string, platform: NodeJS.Platform = process.platform, configDirs: string[] = []): boolean {
  if (!isAbsoluteHostPath(abs, platform)) return false;
  const norm = platform === "win32" ? abs : posix.resolve(abs);
  if (isKeychainPath(norm, home, platform)) return true;
  if (configDirs.some((dir) => ownReadableIn(dir, norm, platform))) return false;
  if (configDirs.some((dir) => isWithinPath(dir, norm, platform))) return true;
  const rel = homeRelative(abs, home, platform);
  if (rel === null) return false;
  if (AGENT_OWN_READABLE.some((entry) => under(rel, entry))) return false;
  return AGENT_HOME_ENTRIES.some((entry) => under(rel, entry));
}

/**
 * Inside a listed account directory, the same shipped skills (`<dir>/bundled`, Grok's `GROK_HOME`)
 * as under the default home; the directory itself stays a credential directory.
 */
function ownReadableIn(dir: string, norm: string, platform: NodeJS.Platform): boolean {
  const base = dir.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  return isWithinPath(`${base}${platform === "win32" ? "\\" : "/"}bundled`, norm, platform);
}

/** What an agent may read of its own install without a card (Grok's shipped skills). */
export function isAgentOwnReadable(abs: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = homeRelative(abs, home, platform);
  return rel !== null && AGENT_OWN_READABLE.some((entry) => under(rel, entry));
}

/**
 * A command that names one of your agents' own directories — `~/.claude`, `~/.codex`, … through
 * `~`, `$HOME` or the home folder spelled out (on Windows `%USERPROFILE%` and the like, either
 * slash, any case) — or one of the listed account directories, or asks the keychain for a secret.
 * Grok's shipped skills may be named.
 */
export function touchesAgentCredentials(command: string, home: string, platform: NodeJS.Platform = process.platform, configDirs: string[] = []): boolean {
  const win = platform === "win32";
  const sep = win ? "[\\\\/]+" : "/+";
  const spelled = (path: string) => path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).map(escapeRegExp).join(sep);
  const homes = win
    ? ["~", "\\$HOME", "\\$\\{HOME\\}", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", "%HOMEDRIVE%%HOMEPATH%", spelled(home)]
    : ["~", "\\$HOME", "\\$\\{HOME\\}", escapeRegExp(home)];
  if (win) {
    const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(home);
    if (drive) homes.push(`[\\\\/]${drive[1]}[\\\\/]+${spelled(drive[2]!)}`);
  }
  const own = AGENT_OWN_READABLE.map((entry) => `(?!${spelled(entry)}(?:[\\\\/]|$))`).join("");
  const entries = AGENT_HOME_ENTRIES.map((entry) => spelled(entry)).join("|");
  const names = new RegExp(`(?:${homes.join("|")})${sep}${own}(?:${entries})(?![A-Za-z0-9_-])`, win ? "i" : "");
  if (names.test(command)) return true;
  if (configDirs.some((dir) => namesDir(command, dir, home, platform, true))) return true;
  return asksKeychainForSecret(command, platform);
}

/**
 * Whether a command names `dir` or something in it: spelled out, or under your home folder through
 * `~`, `$HOME` (and on Windows `%USERPROFILE%` and the like), either slash on Windows, any case there.
 * A longer name that only starts the same (`~/.claude-b2` for `~/.claude-b`) is another directory.
 */
export function namesDir(command: string, dir: string, home: string, platform: NodeJS.Platform, sparingBundled = false): boolean {
  const win = platform === "win32";
  const sep = win ? "[\\\\/]+" : "/+";
  const spelled = (path: string) => path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).map(escapeRegExp).join(sep);
  const prefixes: string[] = [];
  if (!win) prefixes.push(`/${spelled(dir)}`);
  else if (/^\\\\/.test(dir)) prefixes.push(`[\\\\/]{2}${spelled(dir)}`);
  else {
    prefixes.push(spelled(dir));
    const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(dir);
    if (drive) prefixes.push(`[\\\\/]${drive[1]}${sep}${spelled(drive[2]!)}`);
  }
  if (dir.length > home.length && isWithinPath(home, dir, platform)) {
    const rel = spelled(dir.slice(home.length));
    const homes = win
      ? ["~", "\\$HOME", "\\$\\{HOME\\}", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", "%HOMEDRIVE%%HOMEPATH%"]
      : ["~", "\\$HOME", "\\$\\{HOME\\}"];
    for (const spelling of homes) prefixes.push(`${spelling}${sep}${rel}`);
  }
  // `sparingBundled`: `<dir>/bundled` (Grok's shipped skills in an account's GROK_HOME) is not named.
  const own = sparingBundled ? `(?!${sep}bundled(?![A-Za-z0-9._-]))` : "";
  return new RegExp(`(?:${prefixes.join("|")})(?![A-Za-z0-9._-])${own}`, win ? "i" : "").test(command);
}

/**
 * The command with every path it names inside one of `openDirs` taken out: an agent's own memory,
 * skills or plans, open to it as a folder outside the workspace is (ADR 0111). Null when the
 * command could leave such a folder by itself: it climbs with `..` anywhere, or the part of it that
 * names the folder ({@link leavesFrom}) changes directory, builds a path the rules cannot read, or
 * hands the folder on to be built on; or a path it names there leads out through a link (`stays`
 * says no). What is left is checked as any command is, so naming anything else of an agent's still
 * shuts it out.
 */
export function withoutOpenDirs(command: string, openDirs: string[], home: string, platform: NodeJS.Platform, stays: (abs: string) => boolean): string | null {
  if (openDirs.length === 0) return command;
  if (/(?:^|[\\/\s'"=])\.\.(?:[\\/\s'"]|$)/.test(command)) return null;
  const win = platform === "win32";
  const sep = win ? "[\\\\/]+" : "/+";
  const spelled = (path: string) => path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).map(escapeRegExp).join(sep);
  let out = command;
  for (const dir of openDirs) {
    const patterns = [win ? spelled(dir) : `/${spelled(dir)}`];
    if (dir.length > home.length && isWithinPath(home, dir, platform)) {
      for (const lead of win ? ["~", "%USERPROFILE%"] : ["~", "\\$HOME", "\\$\\{HOME\\}"]) patterns.push(`${lead}${sep}${spelled(dir.slice(home.length))}`);
    }
    for (const pattern of patterns) {
      const found = new RegExp(`${pattern}((?:${sep}[^\\s'"\`;|&<>()]*)?)(?![A-Za-z0-9._-])`, win ? "gi" : "g");
      let leaves = false;
      out = out.replace(found, (match: string, rest: string, at: number, whole: string) => {
        const inner = rest.replace(/^[\\/]+/, "");
        const abs = inner ? (win ? `${dir.replace(/[\\/]+$/, "")}\\${inner}` : posix.join(dir, inner)) : dir;
        if (!stays(abs) || leavesFrom(whole, at, at + match.length)) leaves = true;
        return "OPEN_DIR";
      });
      if (leaves) return null;
    }
  }
  return out;
}

/** Where one command of a list ends and the next begins: `&&`, `||`, `;`, `|`, `&`, a new line. */
const BETWEEN_COMMANDS = /&&|\|\||[;|&\r\n]/g;

/**
 * Whether the command around a mention of an open folder (`start`…`end`) could take a path out of
 * it. Only the command of the list that names the folder counts — a `cd` into the project or a
 * `$(git rev-parse HEAD)` further along builds nothing on it — and it may not change directory or
 * build a path with `$…` (but `$HOME`) or backquotes. Nor may the folder be handed on to be built
 * on: as a variable's value (`D=<folder>`), a loop's list (`for d in <folder>`), or inside `$(…)`
 * or backquotes, whose output another command could add to.
 */
function leavesFrom(command: string, start: number, end: number): boolean {
  let from = 0;
  for (const match of command.slice(0, start).matchAll(BETWEEN_COMMANDS)) from = match.index + match[0].length;
  const after = command.slice(end).search(BETWEEN_COMMANDS);
  const own = command.slice(from, after < 0 ? command.length : end + after);
  if (/(?:^|[\s(])(?:cd|pushd|popd|chdir)(?=\s|$)/.test(own)) return true;
  if (/`|\$(?!\{?HOME\b)[\w{('"@*#?!$-]/.test(own)) return true;
  if (/(?:^|[\s(])for\s+\w+\s+in\s/.test(own)) return true;
  const before = command.slice(0, start);
  if (/(?:^|[\s;&|(`'"])[A-Za-z_]\w*\+?=\(?["']?$/.test(before)) return true;
  return inSubstitution(before);
}

/** Whether text ending here is inside a `$(…)` or backquotes still open. */
function inSubstitution(before: string): boolean {
  let depth = 0;
  let ticks = 0;
  for (let i = 0; i < before.length; i += 1) {
    const ch = before[i];
    if (ch === "`") ticks += 1;
    else if (ch === "$" && before[i + 1] === "(") {
      depth += 1;
      i += 1;
    } else if (ch === "(" && depth > 0) depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
  }
  return depth > 0 || ticks % 2 === 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
