/**
 * Keeps the Rust target directories from growing without end. Cargo never removes what it built
 * for an earlier NSH `rev`, an earlier `nsh.json`, an earlier toolchain or another feature set, so
 * `target` (the shell) and `app/target` (`nsh test` / `nsh build`'s generated workspace) only grow.
 *
 *   bun apps/desktop-nsh/scripts/trim-target.ts [--dry-run]
 *
 * dev.ts, web-dev.ts and ui-tests.ts run it before they build. Two steps, per directory:
 *
 * 1. Incremental caches no compile has touched for `DESKFOLK_TARGET_INCREMENTAL_DAYS` (default 2)
 *    go: they only speed up recompiling a crate that changed, and rustc writes a fresh one.
 * 2. Over `DESKFOLK_TARGET_CAP_GB` (default 20; 0 turns this off), all of `incremental/` goes, then,
 *    still over, the whole directory: the next build starts from nothing (several minutes).
 *
 * Then the NSH CLI cache (`nsh-cli.ts`, one directory per NSH commit, shared by every checkout):
 * a commit other than this checkout's that no script has run for `DESKFOLK_NSH_CACHE_DAYS`
 * (default 7) goes; a checkout still on it builds it again (several minutes).
 *
 * Nothing is removed while cargo, rustc or the shell runs: on Windows the shell's executable is
 * locked, and a build would be left half-deleted. Removing a whole directory, never single
 * artifacts, means cargo can't be left with a fingerprint whose output is gone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { nshCacheRoot, nshRev } from "./nsh-cli";

const root = resolve(import.meta.dir, "..");
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

export const TARGET_DIRS = [join(root, "target"), join(root, "app", "target")];

export interface TrimOptions {
  capBytes: number;
  incrementalAgeMs: number;
  now?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Bytes under `path`, files only; 0 when it is missing. */
export function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    try {
      total += statSync(join(entry.parentPath, entry.name)).size;
    } catch {
      // gone while walking
    }
  }
  return total;
}

/** `<target>/<profile>/incremental` for each profile directory (debug, release, web-dev, …). */
function incrementalDirs(target: string): string[] {
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(target, entry.name, "incremental"))
    .filter((dir) => existsSync(dir));
}

function remove(path: string, options: TrimOptions): void {
  if (!options.dryRun) rmSync(path, { recursive: true, force: true });
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)}G`;
}

/** Trims one target directory; returns its size afterwards. */
export function trimTarget(target: string, options: TrimOptions): number {
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now();
  if (!existsSync(target)) return 0;

  let stale = 0;
  for (const incremental of incrementalDirs(target)) {
    for (const entry of readdirSync(incremental, { withFileTypes: true })) {
      const path = join(incremental, entry.name);
      if (now - statSync(path).mtimeMs < options.incrementalAgeMs) continue;
      stale += sizeOf(path);
      remove(path, options);
    }
  }
  if (stale > 0) log(`trim-target: ${target}: ${gb(stale)} of incremental caches unused for a while`);

  // A dry run removed nothing, so it takes off what it would have.
  let size = sizeOf(target) - (options.dryRun ? stale : 0);
  if (options.capBytes <= 0 || size <= options.capBytes) return size;

  const incrementals = incrementalDirs(target);
  const incrementalSize = incrementals.reduce((sum, dir) => sum + sizeOf(dir), 0);
  if (incrementalSize > 0) {
    log(`trim-target: ${target} is ${gb(size)}, over ${gb(options.capBytes)}: removing incremental/ (${gb(incrementalSize)})`);
    for (const dir of incrementals) remove(dir, options);
    size -= incrementalSize;
  }
  if (size <= options.capBytes) return size;

  log(`trim-target: ${target} is still ${gb(size)}, over ${gb(options.capBytes)}: removing it; the next build starts from nothing`);
  remove(target, options);
  return 0;
}

export interface NshCacheOptions {
  /** The commit this checkout is on, kept whenever it was last used. */
  keep: string;
  unusedMs: number;
  now?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const REMOVING = ".removing";

/** When `<rev>`'s CLI was last run: its stamp, else (a cache from before stamps) the directory's. */
function lastUsed(dir: string): number {
  try {
    return statSync(join(dir, "last-used")).mtimeMs;
  } catch {
    return statSync(dir).mtimeMs;
  }
}

/**
 * Removes the NSH commits under `root` other than `keep` that nothing has used for `unusedMs`.
 * Each is renamed before it is removed: on Windows a running CLI locks its directory, so the
 * rename fails and it stays whole, instead of a removal stopping half-way through a checkout that
 * `nsh-cli.ts` would then take for built. What a removal left (`<rev>.removing`) goes next time.
 */
export function trimNshCache(root: string, options: NshCacheOptions): void {
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now();
  if (!existsSync(root)) return;
  const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    if (!entry.name.endsWith(REMOVING) || options.dryRun) continue;
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {
      // Still locked; next time.
    }
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{7,40}$/.test(entry.name) || entry.name === options.keep) continue;
    const dir = join(root, entry.name);
    const unused = now - lastUsed(dir);
    if (unused < options.unusedMs) continue;
    log(`trim-target: ${dir}: the CLI of NSH ${entry.name.slice(0, 12)}, unused for ${Math.floor(unused / DAY)} days (${gb(sizeOf(dir))})`);
    if (options.dryRun) continue;
    try {
      renameSync(dir, dir + REMOVING);
    } catch {
      log(`trim-target: ${dir} is in use; not removing it now`);
      continue;
    }
    try {
      rmSync(dir + REMOVING, { recursive: true, force: true });
    } catch {
      // Finished next time.
    }
  }
}

/** Whether cargo, rustc or the shell runs now (any of them, from any checkout). */
export function rustBusy(): boolean {
  const names = ["cargo", "rustc", "deskfolk-nsh"];
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" });
    if (result.status !== 0) return true;
    const running = new Set(result.stdout.split(/\r?\n/).map((line) => line.split(",")[0]?.replaceAll('"', "").toLowerCase()));
    return names.some((name) => running.has(`${name}.exe`));
  }
  return names.some((name) => spawnSync("pgrep", ["-x", name]).status === 0);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The trim dev.ts, web-dev.ts and ui-tests.ts run first; never throws. */
export function trimTargets(options: { dryRun?: boolean } = {}): void {
  try {
    // A dry run removes nothing, so it may look while a build runs.
    if (!options.dryRun && rustBusy()) {
      console.log("trim-target: cargo, rustc or the shell is running; not trimming now");
      return;
    }
    const capBytes = envNumber("DESKFOLK_TARGET_CAP_GB", 20) * GB;
    const incrementalAgeMs = envNumber("DESKFOLK_TARGET_INCREMENTAL_DAYS", 2) * DAY;
    for (const target of TARGET_DIRS) trimTarget(target, { capBytes, incrementalAgeMs, dryRun: options.dryRun });
    trimNshCache(nshCacheRoot(), {
      keep: nshRev(),
      unusedMs: envNumber("DESKFOLK_NSH_CACHE_DAYS", 7) * DAY,
      dryRun: options.dryRun,
    });
  } catch (error) {
    console.warn(`trim-target: skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) for (const target of [...TARGET_DIRS, nshCacheRoot()]) console.log(`${target}: ${gb(sizeOf(target))}`);
  trimTargets({ dryRun });
}
