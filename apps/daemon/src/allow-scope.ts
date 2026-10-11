/**
 * Where an Always allow on a card for a path outside the workspace reaches (ADR 0087): the project
 * the path is in — the nearest folder above it holding a `.git` — or else the folder it is in. One
 * press then covers the next file the Bot touches there, not only the one on the card. Never your
 * home folder, a folder above it, a disk's root or a folder right under one: a card there covers
 * the path itself.
 */
import { posix, win32 } from "node:path";
import { isWithinPath, nodePathHost, type PathHost } from "./workspace-paths";

/** The kinds whose cards name one path outside the workspace. */
const FOLDER_KINDS = new Set(["outside-read", "outside-write"]);

/** What an Always allow on this card would cover; null when the kind is not about a path. */
export function proposedAllowScope(kindKey: string, target: string, host: PathHost = nodePathHost): string | null {
  if (!FOLDER_KINDS.has(kindKey)) return null;
  const path = host.platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(target)) return null;
  const home = host.homedir();
  const tooWide = (dir: string) => {
    const root = path.parse(dir).root;
    return dir === root || path.dirname(dir) === root || isWithinPath(dir, home, host.platform);
  };
  const start = isDirectory(host, target) ? target : path.dirname(target);
  for (let dir = start; !tooWide(dir); dir = path.dirname(dir)) {
    if (exists(host, path.join(dir, ".git"))) return dir;
  }
  return tooWide(start) ? target : start;
}

function isDirectory(host: PathHost, path: string): boolean {
  try {
    return host.lstat(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(host: PathHost, path: string): boolean {
  try {
    host.lstat(path);
    return true;
  } catch {
    return false;
  }
}
