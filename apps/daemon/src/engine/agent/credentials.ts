/**
 * Where your local agents keep what signs them in and how they are set up (ADR 0061, ADR 0079):
 * off limits to every Bot, whichever agent runs it — a Bot on Codex reads no more of `~/.claude`
 * than one on Claude Code reads of `~/.codex`. Refused outright, never carded: an approval would be
 * you letting one agent read another's (or its own) credentials. Pure, like the rest of the policy:
 * home, platform and the listed account directories come in, so the rules are tested on a fake disk.
 */
import { posix } from "node:path";
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
  if (platform !== "win32" && (norm.startsWith(`${posix.join(home, "Library", "Keychains")}/`) || norm.startsWith("/Library/Keychains/"))) return true;
  if (configDirs.some((dir) => isWithinPath(dir, norm, platform))) return true;
  const rel = homeRelative(abs, home, platform);
  if (rel === null) return false;
  if (AGENT_OWN_READABLE.some((entry) => under(rel, entry))) return false;
  return AGENT_HOME_ENTRIES.some((entry) => under(rel, entry));
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
  if (configDirs.some((dir) => namesDir(command, dir, home, platform))) return true;
  return !win && /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(command);
}

/**
 * Whether a command names `dir` or something in it: spelled out, or under your home folder through
 * `~`, `$HOME` (and on Windows `%USERPROFILE%` and the like), either slash on Windows, any case there.
 * A longer name that only starts the same (`~/.claude-b2` for `~/.claude-b`) is another directory.
 */
export function namesDir(command: string, dir: string, home: string, platform: NodeJS.Platform): boolean {
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
  return new RegExp(`(?:${prefixes.join("|")})(?![A-Za-z0-9._-])`, win ? "i" : "").test(command);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
