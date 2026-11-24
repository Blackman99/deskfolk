/**
 * Where your local agents keep what signs them in and how they are set up (ADR 0061, ADR 0079):
 * off limits to every Bot, whichever agent runs it — a Bot on Codex reads no more of `~/.claude`
 * than one on Claude Code reads of `~/.codex`. Refused outright, never carded: an approval would be
 * you letting one agent read another's (or its own) credentials. The one agent that cannot be made
 * to ask first (Antigravity, a Bot on it or a project session of it) is judged file by file instead
 * ({@link isAgentSecretPath}, {@link namesAgentSecret}): refusing it stops its turn after the call
 * has run. Pure, like the rest of the policy: home, platform and the listed account directories come
 * in, so the rules are tested on a fake disk.
 */
import { posix, win32 } from "node:path";
import { asksKeychainForSecret, isKeychainPath } from "../../keychains";
import { isAbsoluteHostPath, isWithinPath, workspaceRelative } from "../../workspace-paths";

/** What an agent hears when a call reaches one of your agents' own settings or credentials. */
export const AGENT_CREDENTIALS_REFUSAL = "your local agents' own settings and credentials are off limits";

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

/**
 * Where your local agents keep what was said and done, in each one's own home and in every account
 * directory you listed (`accounts`): Claude Code's `projects` (each session's transcript, its
 * subagents' and tool results, its memory of each project) and Grok's `sessions`. Records, not
 * settings or sign-in, though they sit beside them: a project session's agent reads them, and only
 * reads them (`readableDirs` in the policy). Codex and Antigravity keep theirs where the app has
 * never looked, so they are not named here.
 */
export function agentRecordDirs(home: string, accounts: (runner: "claude_code" | "grok") => string[], platform: NodeJS.Platform = process.platform): string[] {
  const { join } = platform === "win32" ? win32 : posix;
  return [
    ...[join(home, ".claude"), ...accounts("claude_code")].map((dir) => join(dir, "projects")),
    ...[join(home, ".grok"), ...accounts("grok")].map((dir) => join(dir, "sessions")),
  ];
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
  const sep = sepOf(win);
  const spelled = (path: string) => spelledPath(path, win);
  const homes = homeSpellings(home, platform);
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
  const sep = sepOf(win);
  // `sparingBundled`: `<dir>/bundled` (Grok's shipped skills in an account's GROK_HOME) is not named.
  const own = sparingBundled ? `(?!${sep}bundled(?![A-Za-z0-9._-]))` : "";
  return new RegExp(`(?:${dirSpellings(dir, home, platform).join("|")})(?![A-Za-z0-9._-])${own}`, win ? "i" : "").test(command);
}

/** What separates a path's parts in a command, as a pattern: either slash on Windows, any number of them. */
function sepOf(win: boolean): string {
  return win ? "[\\\\/]+" : "/+";
}

/** A path's parts as a pattern, whatever separates them. */
function spelledPath(path: string, win: boolean): string {
  return path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).map(escapeRegExp).join(sepOf(win));
}

/** How a command may spell your home folder, as patterns: `~`, `$HOME`, spelled out; on Windows `%USERPROFILE%` and the like, and Git Bash's `/c/Users/…`. */
function homeSpellings(home: string, platform: NodeJS.Platform): string[] {
  const win = platform === "win32";
  const homes = win
    ? ["~", "\\$HOME", "\\$\\{HOME\\}", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", "%HOMEDRIVE%%HOMEPATH%", spelledPath(home, win)]
    : ["~", "\\$HOME", "\\$\\{HOME\\}", escapeRegExp(home)];
  if (win) {
    const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(home);
    if (drive) homes.push(`[\\\\/]${drive[1]}[\\\\/]+${spelledPath(drive[2]!, win)}`);
  }
  return homes;
}

/** How a command may spell `dir`, as patterns: spelled out, and under your home folder through `~`, `$HOME` and the like. */
function dirSpellings(dir: string, home: string, platform: NodeJS.Platform): string[] {
  const win = platform === "win32";
  const sep = sepOf(win);
  const spelled = (path: string) => spelledPath(path, win);
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
  return prefixes;
}

/** A `..` as a path's own part: `../x`, `cd ..`, `cd ..;`, `(cd ..)`, `"..")`; not `...`, nor `1..9`. */
const CLIMBS = /(?:^|[\\/\s'"=(])\.\.(?:[\\/\s'"`;|&)]|$)/;

/**
 * The command with every path it names inside one of `openDirs` taken out: an agent's own memory,
 * skills or plans, open to it as a folder outside the workspace is (ADR 0111). Null when the
 * command could leave such a folder by itself: it climbs with `..` anywhere, or a path it names
 * there leads out through a link (`stays` says no), or where it names the folder
 * ({@link leavesFrom}) it changes directory, builds a path the rules cannot read, or hands the
 * folder on to be built on. A project session passes `unplaced`: such a mention is then taken out
 * too and `unplaced` is told, so the caller can look at what else the command names. What is left
 * is checked as any command is, so naming anything else of an agent's still shuts it out.
 */
export function withoutOpenDirs(command: string, openDirs: string[], home: string, platform: NodeJS.Platform, stays: (abs: string) => boolean, unplaced?: () => void): string | null {
  if (openDirs.length === 0) return command;
  if (CLIMBS.test(command)) return null;
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
        if (!stays(abs)) leaves = true;
        else if (leavesFrom(whole, at, at + match.length, win)) {
          if (unplaced) unplaced();
          else leaves = true;
        }
        return "OPEN_DIR";
      });
      if (leaves) return null;
    }
  }
  return out;
}

/** A path past a glob: none of a shell word's ends, and not ending on a slash. */
const PATH_REST = String.raw`(/+[^\s'"\x60;|&<>()]*[^\s'"\x60;|&<>()/])`;

/**
 * The command with each path that globs the folder right under your home (`.claude*` there, then
 * `projects/…`: every account's records at once) taken out where each folder there the glob matches (`foldersIn`),
 * with the rest of the path, is `fine`; a glob matching nothing names nothing. Null when such a path
 * could leave: a `..` anywhere, or as {@link leavesFrom} has it unless `unplaced` is given, as in
 * {@link withoutOpenDirs}. A glob that is the whole path (`~/.claude*`) stays in, as does any path
 * with no glob there: the rules read those as written. POSIX shells only.
 */
export function withoutHomeGlobs(command: string, home: string, platform: NodeJS.Platform, foldersIn: (dir: string) => string[], fine: (abs: string) => boolean, unplaced?: () => void): string | null {
  if (platform === "win32") return command;
  const found = new RegExp(String.raw`(?:~|\$HOME|\$\{HOME\}|${escapeRegExp(home)})/+([^\s'"\x60;|&<>()/]*[*?[][^\s'"\x60;|&<>()/]*)${PATH_REST}`, "g");
  if (!new RegExp(found.source).test(command)) return command;
  if (CLIMBS.test(command)) return null;
  let leaves = false;
  const out = command.replace(found, (match: string, glob: string, rest: string, at: number, whole: string) => {
    const pattern = globPattern(glob);
    if (!foldersIn(home).filter((name) => pattern.test(name)).every((name) => fine(posix.join(home, name, rest)))) return match;
    if (leavesFrom(whole, at, at + match.length, false)) {
      if (unplaced) unplaced();
      else leaves = true;
    }
    return "OPEN_DIR";
  });
  return leaves ? null : out;
}

/** Your agents' own folders under your home, as written there: the folders of {@link AGENT_HOME_ENTRIES}. */
const AGENT_HOME_FOLDERS = AGENT_HOME_ENTRIES.filter((entry) => !entry.endsWith(".json"));

/**
 * The command with each of your agents' own folders taken out where a program of its own is handed
 * the folder as a string to expand and build on itself — `os.path.expanduser("~/.claude")` in a
 * `python3 -c '…'` or a heredoc — so the rules cannot read what it reaches, as they never read
 * `Path.home() / ".claude"` either; `unplaced` is told. Only the folder itself (an account folder you
 * listed under your home too), spelled with `~`, between two quotes that the shell passes on as they
 * are (inside other quotes, or a heredoc), so no shell expands that `~`: neither this one, nor one
 * the string is handed to (`bash -c '… "~/.claude" …'`). Not after a quote of its own (`""~`), which
 * zsh does expand. Null when the command climbs with `..` anywhere. POSIX shells only.
 */
export function withoutQuotedHomes(command: string, home: string, platform: NodeJS.Platform, configDirs: string[], unplaced: () => void): string | null {
  if (platform === "win32") return command;
  const accounts = configDirs.filter((dir) => dir.length > home.length && isWithinPath(home, dir, platform)).map((dir) => dir.slice(home.length));
  const folders = [...AGENT_HOME_FOLDERS, ...accounts].map((path) => path.split(/\/+/).filter(Boolean).map(escapeRegExp).join("/+"));
  const found = new RegExp(String.raw`~/+(?:${folders.join("|")})/*(?=\\?["'])`, "g");
  if (!new RegExp(found.source).test(command)) return command;
  const quoting = shellQuoting(command);
  let took = false;
  const out = command.replace(found, (match: string, at: number) => {
    const open = at - 1;
    const close = command[at + match.length] === "\\" ? at + match.length + 1 : at + match.length;
    const quote = command[open];
    if ((quote !== '"' && quote !== "'") || command[close] !== quote) return match;
    if (!quoting.inside[at] || !quoting.literal(open) || !quoting.literal(close)) return match;
    // What the program reads just before the string's own quote: a quote there (`""~`) leaves the ~ bare.
    const before = command[quoting.escaped[open] ? open - 2 : open - 1];
    if (before === '"' || before === "'") return match;
    took = true;
    return "OPEN_DIR";
  });
  if (!took) return command;
  if (CLIMBS.test(command)) return null;
  unplaced();
  return out;
}

/**
 * How the shell quotes each character of a command: `inside` quotes or a heredoc's body, where no
 * `~` is expanded; `escaped` by a backslash; and `literal(i)`, a quote mark the shell passes on as a
 * character (in other quotes, escaped, or in a heredoc) rather than reading it as a quote. A
 * substitution's own quotes are not followed: a quote in `"$(…)"` reads as closing the outer one,
 * which only ever keeps a folder in.
 */
function shellQuoting(command: string): { inside: boolean[]; escaped: boolean[]; literal: (i: number) => boolean } {
  const n = command.length;
  const inside: boolean[] = new Array(n).fill(false);
  const escaped: boolean[] = new Array(n).fill(false);
  const marks: boolean[] = new Array(n).fill(false);
  let quote: "'" | '"' | null = null;
  const pending: Array<{ word: string; tabs: boolean }> = [];
  for (let i = 0; i < n; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") { marks[i] = true; quote = null; } else inside[i] = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < n) {
        inside[i] = inside[i + 1] = true;
        if (/[$`"\\\n]/.test(command[i + 1]!)) escaped[i + 1] = true;
        i += 1;
      } else if (ch === '"') { marks[i] = true; quote = null; } else inside[i] = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < n) escaped[i + 1] = true;
      i += 1;
    } else if (ch === "'" || ch === '"') {
      marks[i] = true;
      quote = ch;
    } else if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && (i === 0 || /[\s;&|(]/.test(command[i - 1]!))) {
      // A heredoc: `<<EOF`, `<<-'EOF'`, `<< "EOF"`; its body starts on the next line. Not a shift (`$((1 << 2))`).
      const word = /^<<(-?)[ \t]*([A-Za-z_'"](?:[^\s;|&<>()]|'[^']*'|"[^"]*")*)/.exec(command.slice(i));
      if (!word) continue;
      pending.push({ word: word[2]!.replace(/['"\\]/g, ""), tabs: word[1] === "-" });
      for (let j = i; j < i + word[0].length; j += 1) if (command[j] === "'" || command[j] === '"') marks[j] = true;
      i += word[0].length - 1;
    } else if (ch === "\n" && pending.length > 0) {
      let at = i + 1;
      for (const { word, tabs } of pending.splice(0)) {
        while (at < n) {
          const lineEnd = command.indexOf("\n", at) < 0 ? n : command.indexOf("\n", at);
          const line = command.slice(at, lineEnd);
          if ((tabs ? line.replace(/^\t+/, "") : line) === word) {
            at = lineEnd;
            break;
          }
          for (let j = at; j <= lineEnd && j < n; j += 1) inside[j] = true;
          at = lineEnd + 1;
        }
      }
      i = at - 1;
    }
  }
  return { inside, escaped, literal: (i) => !marks[i] && (inside[i] || escaped[i]) };
}

/** What may come before a file's name where a command writes one: its start, a blank, a slash, a quote, `=`, `(`, `,` or `:`. */
const NAME_START = String.raw`(?:^|[\s/\\'"\x60=(,:])`;

/**
 * What signs an agent in, by its file's name: Claude Code's `.credentials.json` (and a name starting
 * `.cred`, as a glob for it would), Codex's and Grok's `auth.json`, Gemini's `oauth_creds.json` and
 * `.env`, any `*token*.json`.
 */
const SIGN_IN_NAMES = String.raw`\.cred[\w*?[\]-]*(?:\.json)?|credentials\.json|auth\.json|oauth_creds\.json|[\w.-]*tokens?[\w.-]*\.json|\.env`;

/**
 * How an agent is set up, by its file's name: Claude Code's `settings*.json` and `~/.claude.json`,
 * Codex's `config.toml` (a profile's `<name>.config.toml` too), Gemini's `settings.json` and
 * `google_accounts.json`, Grok's `user-settings.json`.
 */
const SETTINGS_NAMES = String.raw`google_accounts\.json|(?:user-)?settings(?:\.[\w-]+)?\.json|(?:[\w-]+\.)?config\.(?:toml|json)|\.claude\.json`;

/**
 * More of each, read only as the whole name of a file in an agent's folder ({@link isAgentSecretPath}),
 * never wherever a command writes one: OpenCode's `mcp-auth.json`; the MCP servers an agent starts
 * (`mcp_config.json`, `.mcp.json`: their keys sit in them), its hooks, OpenCode's `opencode.json`,
 * a managed or remote settings file, a backup of `~/.claude.json`. A project has files by these
 * names too.
 */
const MORE_SIGN_IN_NAMES = String.raw`[\w-]+[-_.]auth\.json`;
const MORE_SETTINGS_NAMES = String.raw`\.?mcp[\w.-]*\.json|hooks\.json|opencode\.jsonc?|[\w-]+-settings(?:\.[\w-]+)?\.json|\.claude\.json\.[\w.-]+`;

/**
 * Where your agents keep their sign-in and settings, by file name, wherever a command names one: what
 * a command that builds its own paths on an agent's folder may not also name ({@link SIGN_IN_NAMES},
 * {@link SETTINGS_NAMES}).
 */
const SETTINGS_FILE = new RegExp(String.raw`${NAME_START}(?:${SIGN_IN_NAMES}|${SETTINGS_NAMES})(?![\w.-])`);

/** Whether a command names one of your agents' sign-in or settings files by its name ({@link SETTINGS_FILE}). */
export function namesAgentSettingsFile(command: string): boolean {
  return SETTINGS_FILE.test(command);
}

/** Such a file's name, whole, sign-in or settings. Any case: the disk does not tell them apart everywhere. */
const SECRET_FILE = new RegExp(`^(?:${SIGN_IN_NAMES}|${MORE_SIGN_IN_NAMES}|${SETTINGS_NAMES}|${MORE_SETTINGS_NAMES})$`, "i");

/** A path's last part, as a file's name. */
function nameOf(path: string, win: boolean): string {
  return path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).at(-1) ?? "";
}

/**
 * A file that signs one of your agents in or sets it up, for a session or a Bot's turn to which the
 * agents' folders are otherwise open (one with `ownAgentDirs`, ADR 0111 addendum 2026-11-24): a path in the
 * keychains; or one in another agent's folder (an account folder you listed too) under a sign-in or
 * settings file's name ({@link SIGN_IN_NAMES}, {@link SETTINGS_NAMES}). Nothing else there is: its
 * skills, what it remembers, its records, notes and logs, the folder itself; nor anything among the
 * skills Grok ships with, as ever ({@link isAgentCredentialPath}). And nothing at all in the folders
 * of the session's own agent (`ownDirs`), which are its own as in its terminal: the skills it ships
 * with, its settings, the file that signs it in.
 */
export function isAgentSecretPath(abs: string, home: string, platform: NodeJS.Platform, configDirs: string[], ownDirs: string[]): boolean {
  if (!isAbsoluteHostPath(abs, platform)) return false;
  const win = platform === "win32";
  const norm = win ? win32.normalize(abs) : posix.resolve(abs);
  if (isKeychainPath(norm, home, platform)) return true;
  if (ownDirs.some((dir) => isWithinPath(dir, norm, platform))) return false;
  return isAgentCredentialPath(norm, home, platform, configDirs) && SECRET_FILE.test(nameOf(norm, win));
}

/** Where a command names one of your agents' folders: from `at` up to `end`, and the path it names there. */
type FolderMention = {
  at: number;
  end: number;
  /** The path as written, `..` taken out. */
  abs: string;
  /** Whether the path goes on from the folder with a slash (`<folder>/x`), not with a glob on the folder's own name (`.claude` and a `*` after it). */
  direct: boolean;
};

/**
 * Each place a command names one of your agents' folders or something in one — `~/.claude`,
 * `$HOME/.codex/x`, an account folder you listed, spelled as {@link homeSpellings} and
 * {@link dirSpellings} have it — with the rest of that path, up to where the shell word or its
 * quote ends.
 */
function agentFolderMentions(command: string, home: string, platform: NodeJS.Platform, configDirs: string[]): FolderMention[] {
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const rest = String.raw`([^\s'"\x60;|&<>()]*)`;
  const flags = win ? "gi" : "g";
  const out: FolderMention[] = [];
  const add = (at: number, length: number, base: string, tail: string) => {
    // What ends a sentence or a list is no part of the path: `~/.codex/auth.json,`.
    const path = tail.replace(/[.,:\]}]+$/, "");
    const direct = path === "" || (win ? /^[\\/]/ : /^\//).test(path);
    out.push({ at, end: at + length, abs: direct ? p.join(base, path) : p.normalize(`${base}${path}`), direct });
  };
  // The longer name first: `.claude.json` is not `.claude` and a `.json` after it.
  const entries = [...AGENT_HOME_ENTRIES].sort((a, b) => b.length - a.length);
  const named = new RegExp(`(?:${homeSpellings(home, platform).join("|")})${sepOf(win)}(${entries.map((entry) => spelledPath(entry, win)).join("|")})(?![A-Za-z0-9_-])${rest}`, flags);
  for (const match of command.matchAll(named)) {
    const written = match[1]!.split(win ? /[\\/]+/ : /\/+/).join("/");
    const entry = entries.find((one) => (win ? one.toLowerCase() === written.toLowerCase() : one === written)) ?? written;
    add(match.index ?? 0, match[0].length, p.join(home, ...entry.split("/")), match[2] ?? "");
  }
  for (const dir of configDirs) {
    const listed = new RegExp(`(?:${dirSpellings(dir, home, platform).join("|")})(?![A-Za-z0-9._-])${rest}`, flags);
    for (const match of command.matchAll(listed)) add(match.index ?? 0, match[0].length, dir, match[1] ?? "");
  }
  return out;
}

/**
 * Whether a command names a file that signs another of your agents in or sets it up
 * ({@link isAgentSecretPath}), for a session to which the agents' folders are otherwise open. One
 * of three: it asks the keychain for a secret; or a path it writes into an agent's folder is such a
 * file, as written or where its links lead (`real`); or it works from inside another agent's folder
 * or builds its own paths on one — a `cd` there, the folder in a variable, a loop or a `$(…)`, or
 * handed as a string to a program — and writes such a file's name anywhere
 * ({@link namesAgentSettingsFile}, as for any command that builds its own paths), since what it
 * reaches cannot be read off it. A whole path by itself — `ls ~/.claude/skills`,
 * `rg x ~/.claude/skills apps/x/config.json` — builds nothing, and a name elsewhere in the command
 * is some other file's.
 *
 * Nothing counts in the folders that are the session's own: its agent's (`ownDirs`) and the ones
 * open to it (`open`: its notes and plans). Whatever is built there is its own business; a path
 * that climbs out of them as written is judged where it lands. In the folders it only reads
 * (`read`: your agents' records) no file is a secret, but a path built on them counts as built. On
 * Windows every mention of another agent's folder counts as built: its shells' quoting is not read.
 */
export function namesAgentSecret(
  command: string, home: string, platform: NodeJS.Platform, configDirs: string[], ownDirs: string[],
  folders: { open: (abs: string) => boolean; read: (abs: string) => boolean; real: (abs: string) => string | null },
): boolean {
  if (asksKeychainForSecret(command, platform)) return true;
  const mentions = agentFolderMentions(command, home, platform, configDirs);
  if (mentions.length === 0) return false;
  const win = platform === "win32";
  const secret = (abs: string) => !folders.open(abs) && !folders.read(abs) && isAgentSecretPath(abs, home, platform, configDirs, ownDirs);
  let built = false;
  for (const mention of mentions) {
    const real = folders.real(mention.abs);
    if (secret(mention.abs) || (real !== null && secret(real))) return true;
    // A glob on the folder's own name (`.claude` with a `*` after it, then `/settings.json`) names every account's at once.
    if (!mention.direct && SECRET_FILE.test(nameOf(mention.abs, win))) return true;
    if (folders.open(mention.abs) || ownDirs.some((dir) => isWithinPath(dir, mention.abs, platform))) continue;
    if (win || !isWholeWord(command, mention, win) || leavesFrom(command, mention.at, mention.end, win)) built = true;
  }
  return built && namesAgentSettingsFile(command);
}

/**
 * Whether a mention is a whole shell word by itself, so the shell hands exactly that path on: bare,
 * or in double quotes of its own (`"$HOME/.codex/x"`; not `"~/…"`, which no shell expands and so
 * is a string for the program to build on).
 */
function isWholeWord(command: string, mention: FolderMention, win: boolean): boolean {
  const [from, to] = wordAround(command, mention.at, mention.end, win);
  const word = command.slice(from, to);
  const text = command.slice(mention.at, mention.end);
  return word === text || (word === `"${text}"` && !text.startsWith("~"));
}

/** One folder name's shell glob as a regular expression: a leading dot is matched only by a glob that starts with one. */
function globPattern(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    const end = ch === "[" ? glob.indexOf("]", i + 2) : -1;
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (end > 0) {
      const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
      source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
      i = end;
    } else source += escapeRegExp(ch);
  }
  return new RegExp(glob.startsWith(".") ? `^${source}$` : `^(?!\\.)${source}$`);
}

/** Where one command of a list ends and the next begins: `&&`, `||`, `;`, `|`, `&`, a new line. */
const BETWEEN_COMMANDS = /&&|\|\||[;|&\r\n]/g;

/**
 * Whether the command around a mention of an open folder (`start`…`end`) could take a path out of
 * it. A `cd` into the project or a `$(git rev-parse HEAD)` elsewhere builds nothing on the folder:
 * the command of the list that names it (between `&&`, `;`, `|`, new lines) may not change
 * directory, and the shell word that names it may not build on it with `$…` (but `$HOME`) or
 * backquotes — `"<folder>/$X"` and `<folder>/"$(…)"` do, `ssh host "V=$V bash -s" < <folder>/x`
 * does not. Nor may the folder be handed on to be built on: as a variable's value (`D=<folder>`),
 * a loop's list (`for d in <folder>`), or inside `$(…)` or backquotes, whose output another
 * command could add to.
 */
function leavesFrom(command: string, start: number, end: number, win: boolean): boolean {
  let from = 0;
  for (const match of command.slice(0, start).matchAll(BETWEEN_COMMANDS)) from = (match.index ?? 0) + match[0].length;
  const after = command.slice(end).search(BETWEEN_COMMANDS);
  const to = after < 0 ? command.length : end + after;
  const own = command.slice(from, to);
  if (/(?:^|[\s(])(?:cd|pushd|popd|chdir)(?=\s|$)/.test(own)) return true;
  if (/(?:^|[\s(])for\s+\w+\s+in\s/.test(own)) return true;
  const [wordFrom, wordTo] = wordAround(command, start, end, win);
  if (/`|\$(?!\{?HOME\b)[\w{('"@*#?!$-]/.test(command.slice(Math.max(from, wordFrom), Math.min(to, wordTo)))) return true;
  const before = command.slice(0, start);
  if (/(?:^|[\s;&|(`'"])[A-Za-z_]\w*\+?=\(?["']?$/.test(before)) return true;
  return inSubstitution(before);
}

/**
 * The shell word holding `start`…`end`, as the shell splits it: up to a blank or `;|&<>` outside
 * quotes, so `"<folder>/my notes $X"` is one word. A backslash escapes outside single quotes, but
 * not on Windows, where it separates folders.
 */
function wordAround(command: string, start: number, end: number, win: boolean): [number, number] {
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && !win) i += 1;
      continue;
    }
    if (ch === "\\" && !win) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (/[\s;|&<>]/.test(ch)) {
      if (i >= end) return [from, i];
      if (i < start) from = i + 1;
    }
  }
  return [from, command.length];
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
