/**
 * Where Claude Code keeps a project's own memory, its auto memory (ADR 0095): `projects/<key>/memory`
 * under the account's config directory, the key a folder's path with every character but a letter or
 * a digit written `-`, as Claude Code 2.1 writes it. The folder is the project's git repository (a
 * linked worktree's main checkout), or the project folder outside one. Every folder Claude Code could
 * key it by is listed (the project folder, its real path, its repository): one it does not use names
 * a folder nothing writes to. A memory folder set elsewhere (`autoMemoryDirectory`) is not looked for:
 * the app reads no settings.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The longest key Claude Code keeps whole; a longer one is cut there and gets a hash of the path. */
const KEY_MAX = 200;

/** The folder name Claude Code gives a path under `projects/`. */
export function claudeProjectKey(path: string): string {
  const key = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= KEY_MAX) return key;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${key.slice(0, KEY_MAX)}-${Math.abs(hash).toString(36)}`;
}

/** The memory folders Claude Code may keep for a project, under the config directory it runs on. */
export function claudeMemoryDirs(projectDir: string, configDir: string): string[] {
  const folders = new Set<string>();
  let real: string | null = null;
  try {
    real = realpathSync(projectDir);
  } catch {
    // gone: its own spelling is all there is
  }
  for (const dir of [projectDir, real]) {
    if (!dir) continue;
    folders.add(dir);
    const repo = gitCheckoutRoot(dir);
    if (repo) folders.add(repo);
  }
  return [...folders].map((folder) => join(configDir, "projects", claudeProjectKey(folder), "memory"));
}

/**
 * Where Claude Code saves the plans it writes in plan mode (ADR 0098): `plans/` under the config
 * directory it runs on, as named and through links. A folder set elsewhere (`plansDirectory`) is not
 * looked for: the app reads no settings.
 */
export function claudePlanDirs(configDir: string): string[] {
  const dirs = new Set([join(configDir, "plans")]);
  try {
    dirs.add(join(realpathSync(configDir), "plans"));
  } catch {
    // not there yet: Claude Code makes it with the first plan
  }
  return [...dirs];
}

/**
 * The repository a folder is in, as Claude Code keys a project by it: the nearest folder up with a
 * `.git`, or for a linked worktree (its `.git` a file naming `<repo>/.git/worktrees/<name>`) the
 * main checkout. Null outside a repository, and at a `.git` that is a link, where Claude Code stops.
 */
export function gitCheckoutRoot(dir: string): string | null {
  let at = resolve(dir);
  for (;;) {
    const marker = join(at, ".git");
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(marker);
    } catch {
      // none here
    }
    if (stat?.isSymbolicLink()) return null;
    if (stat?.isDirectory()) return at;
    if (stat?.isFile()) return worktreeMain(at, marker) ?? at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** A linked worktree's main checkout, from its `.git` file and the `commondir` it points to. */
function worktreeMain(at: string, marker: string): string | null {
  try {
    const text = readFileSync(marker, "utf8").trim();
    if (!text.startsWith("gitdir:")) return null;
    const gitDir = resolve(at, text.slice("gitdir:".length).trim());
    const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    // A bare repository's worktrees are keyed by the repository itself.
    return basename(common) === ".git" ? dirname(common) : common;
  } catch {
    return null;
  }
}
