/**
 * Keeps the Rust target directories from growing without end. Cargo never removes what it built
 * for an earlier NSH `rev`, an earlier `nsh.json`, an earlier toolchain or another feature set, so
 * `target` (the shell) and `app/target` (`nsh test` / `nsh build`'s generated workspace) only grow.
 *
 *   bun apps/desktop-nsh/scripts/trim-target.ts [--dry-run]
 *
 * dev.ts, web-dev.ts and ui-tests.ts run it before they build. Three steps, per directory:
 *
 * 1. Incremental caches no compile has touched for `DESKFOLK_TARGET_INCREMENTAL_DAYS` (default 2)
 *    go: they only speed up recompiling a crate that changed, and rustc writes a fresh one.
 * 2. Build units unreachable in Cargo's `.fingerprint` dependency graph from the newest build
 *    roots (superseded NSH revs, old Cargo.lock, old feature sets, old rustc) and untouched for
 *    `DESKFOLK_TARGET_DEAD_HOURS` (default 2) go; live build units stay however old they are.
 * 3. Over `DESKFOLK_TARGET_CAP_GB` (default 20; 0 turns this off), all of `incremental/` goes,
 *    then any remaining unreachable units regardless of age, then, still over, the whole
 *    directory: the next build starts from nothing (several minutes).
 *
 * Then the NSH CLI cache (`nsh-cli.ts`, one directory per NSH commit, shared by every checkout):
 * a commit other than this checkout's that no script has run for `DESKFOLK_NSH_CACHE_DAYS`
 * (default 7) goes; a checkout still on it builds it again (several minutes).
 *
 * Nothing is removed while cargo, rustc or the shell runs: on Windows the shell's executable is
 * locked, and a build would be left half-deleted. Removing whole units (`.fingerprint` + `deps` +
 * `build` + `examples` for one hash) or whole directories means cargo can't be left with a
 * fingerprint whose output is gone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { nshCacheRoot, nshRev } from "./nsh-cli";

const root = resolve(import.meta.dir, "..");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
const UNIT_DIRS = [".fingerprint", "deps", "build", "examples"] as const;
const HASH_RE = /-([0-9a-f]{16})(?=\.|$)/;
const NON_COMPILED_SUFFIXES = [".rmeta", ".d", ".rcgu.o", ".rcgu.bc", ".dwo", ".dwp", ".pdb"];
const UPLIFTED_LIB_SUFFIXES = [".rlib", ".dylib", ".so", ".dll", ".a", ".wasm"];

export const TARGET_DIRS = [join(root, "target"), join(root, "app", "target")];

export interface TrimOptions {
  capBytes: number;
  incrementalAgeMs: number;
  /** Minimum age before an unreachable (superseded) build unit is pruned; default 2 hours. */
  deadAgeMs?: number;
  now?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Bytes under `path`, files only; 0 when it is missing. */
export function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
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

/** Newest mtime (ms) of `path` and everything under it, or 0 when missing. */
function newestMtimeOf(path: string): number {
  try {
    const st = statSync(path);
    let newest = st.mtimeMs;
    if (!st.isDirectory()) return newest;
    for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
      try {
        const m = statSync(join(entry.parentPath, entry.name)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // gone while walking
      }
    }
    return newest;
  } catch {
    return 0;
  }
}

/** Profile dirs holding a `.fingerprint` (`target/debug`, `target/<triple>/release`, …). */
function profileDirs(target: string): string[] {
  if (!existsSync(target)) return [];
  const found: string[] = [];
  const skip = new Set(["doc", "tmp", "package", "incremental", ...UNIT_DIRS]);
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".fingerprint")) {
      found.push(dir);
      return;
    }
    if (depth >= 2) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(target, 0);
  return found;
}

/** `<profile>/incremental` for each profile directory (`debug`, `release`, `<triple>/debug`, …). */
function incrementalDirs(target: string): string[] {
  if (!existsSync(target)) return [];
  const found = new Set<string>();
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const direct = join(target, entry.name, "incremental");
    if (existsSync(direct)) found.add(direct);
  }
  for (const prof of profileDirs(target)) {
    const nested = join(prof, "incremental");
    if (existsSync(nested)) found.add(nested);
  }
  return [...found];
}

function u64ToLeHex(value: bigint): string {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return Buffer.from(buf).toString("hex");
}

/**
 * Extracts Cargo's dependency fingerprint hex keys from raw `.fingerprint/<unit>/*.json` text.
 * Uses `BigInt` directly from the JSON source because Cargo writes unsigned 64-bit hashes that
 * exceed `Number.MAX_SAFE_INTEGER` and would lose low bits under `JSON.parse`.
 */
export function parseFingerprintDeps(raw: string): string[] {
  const key = /"deps"\s*:\s*\[/.exec(raw);
  if (!key) return [];
  const start = key.index + key[0].length;
  let depth = 1;
  let inString = false;
  let escaped = false;
  let end = start;
  for (; end < raw.length && depth > 0; end++) {
    const ch = raw[end];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    }
  }
  if (depth !== 0) return [];
  const slice = raw.slice(start, end - 1);
  const out: string[] = [];
  const tuple = /\[\s*\d+\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*(?:true|false)\s*,\s*(\d+)\s*\]/g;
  for (const match of slice.matchAll(tuple)) {
    try {
      const n = BigInt(match[1]);
      if (n >= 0n && n < 1n << 64n) out.push(u64ToLeHex(n));
    } catch {
      // ignore malformed entry
    }
  }
  return out;
}

interface BuildUnit {
  profile: string;
  hash: string;
  crateName: string;
  jsonKey: string;
  jsonNames: string[];
  fpVals: string[];
  depFpVals: Set<string>;
  hasCompiled: boolean;
  hasFp: boolean;
  paths: string[];
  mtimeMs: number;
  size: number;
  live: boolean;
  gone: boolean;
}

function scanProfileUnits(profile: string): BuildUnit[] {
  const byHash = new Map<string, BuildUnit>();
  for (const sub of UNIT_DIRS) {
    const subDir = join(profile, sub);
    if (!existsSync(subDir)) continue;
    let entries;
    try {
      entries = readdirSync(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = HASH_RE.exec(entry.name);
      if (!match) continue;
      const hash = match[1];
      let unit = byHash.get(hash);
      if (!unit) {
        unit = {
          profile,
          hash,
          crateName: "",
          jsonKey: "",
          jsonNames: [],
          fpVals: [],
          depFpVals: new Set(),
          hasCompiled: false,
          hasFp: false,
          paths: [],
          mtimeMs: 0,
          size: 0,
          live: true,
          gone: false,
        };
        byHash.set(hash, unit);
      }
      const full = join(subDir, entry.name);
      unit.paths.push(full);
      if ((sub === "deps" || sub === "examples") && entry.isFile()) {
        if (!NON_COMPILED_SUFFIXES.some((s) => entry.name.endsWith(s))) unit.hasCompiled = true;
      }
      if (sub === ".fingerprint" && entry.isDirectory()) {
        unit.hasFp = true;
        unit.crateName = entry.name.slice(0, match.index);
        let fpEntries: string[];
        try {
          fpEntries = readdirSync(full).sort();
        } catch {
          fpEntries = [];
        }
        const jnames: string[] = [];
        for (const fn of fpEntries) {
          if (!fn.endsWith(".json")) continue;
          jnames.push(fn);
          const base = fn.slice(0, -5);
          try {
            const val = readFileSync(join(full, base), "utf8").trim();
            if (val) unit.fpVals.push(val);
          } catch {
            // missing sibling fingerprint value
          }
          try {
            const raw = readFileSync(join(full, fn), "utf8");
            for (const dep of parseFingerprintDeps(raw)) unit.depFpVals.add(dep);
          } catch {
            // unreadable json
          }
        }
        unit.jsonNames = jnames;
        unit.jsonKey = jnames.join(",");
      }
    }
  }
  for (const unit of byHash.values()) {
    let newest = 0;
    let total = 0;
    for (const p of unit.paths) {
      const m = newestMtimeOf(p);
      if (m > newest) newest = m;
      total += sizeOf(p);
    }
    unit.mtimeMs = newest;
    unit.size = total;
  }
  return [...byHash.values()];
}

function upliftedLibStems(profile: string): Set<string> {
  const stems = new Set<string>();
  let entries;
  try {
    entries = readdirSync(profile, { withFileTypes: true });
  } catch {
    return stems;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const suf of UPLIFTED_LIB_SUFFIXES) {
      if (!entry.name.endsWith(suf)) continue;
      let stem = entry.name.slice(0, -suf.length);
      if (stem.startsWith("lib")) stem = stem.slice(3);
      stems.add(stem.replaceAll("-", "_"));
      break;
    }
  }
  return stems;
}

function isTopKind(jsonNames: string[]): boolean {
  return jsonNames.some((fn) => fn.startsWith("bin-") || fn.startsWith("test-") || fn.startsWith("example-") || fn.startsWith("bench-"));
}

function isBuildScript(jsonNames: string[]): boolean {
  return jsonNames.length > 0 && jsonNames.every((fn) => fn.startsWith("build-script-") || fn.startsWith("run-build-script-"));
}

/**
 * Marks units reachable from the newest top-level build roots across every profile in `target`.
 * Returns `true` only when the graph resolved reliably and at least one live root was found.
 */
function markLiveUnits(units: BuildUnit[], profiles: string[], now: number, deadAgeMs: number): boolean {
  const nodes = units.filter((u) => u.hasFp && !u.gone);
  if (nodes.length === 0) return false;

  const byFpVal = new Map<string, BuildUnit[]>();
  for (const u of nodes) {
    for (const val of u.fpVals) {
      let list = byFpVal.get(val);
      if (!list) {
        list = [];
        byFpVal.set(val, list);
      }
      list.push(u);
    }
  }

  const indeg = new Map<BuildUnit, number>(nodes.map((u) => [u, 0]));
  let totalEdges = 0;
  let matchedEdges = 0;
  for (const u of nodes) {
    for (const depVal of u.depFpVals) {
      totalEdges++;
      const targets = byFpVal.get(depVal);
      if (targets && targets.length > 0) {
        matchedEdges++;
        for (const t of targets) {
          if (t !== u) indeg.set(t, (indeg.get(t) ?? 0) + 1);
        }
      }
    }
  }

  // Guard against a future Cargo changing `.fingerprint` encoding.
  if (totalEdges >= 5 && matchedEdges === 0) return false;

  const newestInGroup = new Map<string, number>();
  const profileHasTop = new Set<string>();
  const groupKey = (u: BuildUnit): string => `${u.profile}\0${u.crateName}\0${u.jsonKey}\0${u.hasCompiled ? "1" : "0"}`;
  for (const u of nodes) {
    const g = groupKey(u);
    if (u.mtimeMs > (newestInGroup.get(g) ?? -1)) newestInGroup.set(g, u.mtimeMs);
    if (isTopKind(u.jsonNames)) profileHasTop.add(u.profile);
  }

  const uplifted = new Map(profiles.map((p) => [p, upliftedLibStems(p)]));
  const keepAfter = now - deadAgeMs;
  const roots: BuildUnit[] = [];
  for (const u of nodes) {
    if ((indeg.get(u) ?? 0) !== 0 || isBuildScript(u.jsonNames)) continue;
    if (u.mtimeMs < (newestInGroup.get(groupKey(u)) ?? 0)) continue;
    if (isTopKind(u.jsonNames)) {
      roots.push(u);
    } else if (
      !profileHasTop.has(u.profile) ||
      uplifted.get(u.profile)?.has(u.crateName.replaceAll("-", "_")) ||
      u.mtimeMs >= keepAfter
    ) {
      roots.push(u);
    }
  }
  if (roots.length === 0) return false;

  const visited = new Set<BuildUnit>();
  const stack = [...roots];
  while (stack.length > 0) {
    const u = stack.pop()!;
    if (visited.has(u)) continue;
    visited.add(u);
    for (const depVal of u.depFpVals) {
      for (const next of byFpVal.get(depVal) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
  }
  for (const u of nodes) u.live = visited.has(u);
  return true;
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
  const deadAgeMs = options.deadAgeMs ?? 2 * HOUR;
  if (!existsSync(target)) return 0;

  // 1. Stale incremental caches.
  let stale = 0;
  const removedInc = new Set<string>();
  for (const incremental of incrementalDirs(target)) {
    for (const entry of readdirSync(incremental, { withFileTypes: true })) {
      const path = join(incremental, entry.name);
      if (now - statSync(path).mtimeMs < options.incrementalAgeMs) continue;
      stale += sizeOf(path);
      removedInc.add(path);
      remove(path, options);
    }
  }
  if (stale > 0) log(`trim-target: ${target}: ${gb(stale)} of incremental caches unused for a while`);

  // 2. Unreachable (superseded) build units.
  const profiles = profileDirs(target);
  const units = profiles.flatMap(scanProfileUnits);
  const graphOk = markLiveUnits(units, profiles, now, deadAgeMs);
  let deadBytes = 0;
  let deadCount = 0;
  if (graphOk) {
    for (const u of units) {
      if (!u.hasFp || u.live || u.gone || now - u.mtimeMs < deadAgeMs) continue;
      for (const p of u.paths) remove(p, options);
      u.gone = true;
      deadBytes += u.size;
      deadCount++;
    }
    if (deadCount > 0) {
      log(`trim-target: ${target}: ${deadCount} unreachable build units (${gb(deadBytes)}) from earlier builds`);
    }
  }

  // A dry run removed nothing, so it takes off what it would have.
  let size = sizeOf(target) - (options.dryRun ? stale + deadBytes : 0);
  if (options.capBytes <= 0 || size <= options.capBytes) return size;

  // 3a. Over the cap: drop all remaining incremental caches first.
  const incrementals = incrementalDirs(target);
  let incrementalSize = 0;
  for (const dir of incrementals) {
    if (!options.dryRun) {
      incrementalSize += sizeOf(dir);
    } else {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (!removedInc.has(path)) incrementalSize += sizeOf(path);
      }
    }
  }
  if (incrementalSize > 0) {
    log(`trim-target: ${target} is ${gb(size)}, over ${gb(options.capBytes)}: removing incremental/ (${gb(incrementalSize)})`);
    for (const dir of incrementals) remove(dir, options);
    size -= incrementalSize;
  }
  if (size <= options.capBytes) return size;

  // 3b. Still over the cap: drop any remaining unreachable units regardless of age.
  if (graphOk) {
    let extraDeadBytes = 0;
    let extraDeadCount = 0;
    for (const u of units) {
      if (!u.hasFp || u.live || u.gone) continue;
      for (const p of u.paths) remove(p, options);
      u.gone = true;
      extraDeadBytes += u.size;
      extraDeadCount++;
    }
    if (extraDeadCount > 0) {
      log(`trim-target: ${target} is ${gb(size)}, over ${gb(options.capBytes)}: removing ${extraDeadCount} recent unreachable units (${gb(extraDeadBytes)})`);
      size -= extraDeadBytes;
    }
  }
  if (size <= options.capBytes) return size;

  // 3c. Last resort: live set itself is still over cap.
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
    const deadAgeMs = envNumber("DESKFOLK_TARGET_DEAD_HOURS", 2) * HOUR;
    for (const target of TARGET_DIRS) trimTarget(target, { capBytes, incrementalAgeMs, deadAgeMs, dryRun: options.dryRun });
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
