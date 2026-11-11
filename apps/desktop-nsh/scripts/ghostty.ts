/**
 * What the shell's `ghostty` feature builds with (Ghostty's terminal emulator for the NSH terminal,
 * `app/native/src/ghostty.rs`): Zig 0.15, the only Zig minor Ghostty takes, and Ghostty's sources
 * and Zig packages at the commit `libghostty-vt-sys` pins, kept in a cache shared by every checkout
 * (`~/.cache/deskfolk-nsh/ghostty/<commit>`, or `DESKFOLK_NSH_CACHE`). A build given them fetches
 * nothing: left alone, `libghostty-vt-sys`'s build clones Ghostty and Zig fetches its packages
 * through its own HTTP client, which fails through this Mac's proxy.
 *
 * The same env every time (`ghosttyEnv`): the build script runs again whenever one of these
 * variables changes, and a run without them falls back to fetching.
 *
 *   bun apps/desktop-nsh/scripts/ghostty.ts           prepares the cache if missing, prints the env
 *   bun apps/desktop-nsh/scripts/ghostty.ts --check   prints the env, fails if it is not ready
 *   … --shell                                         prints it as `export` lines, for `eval` (CI)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** The `libghostty-vt-sys` this is for, and the Ghostty commit its build pins (`GHOSTTY_COMMIT` in its `build.rs`). */
export const GHOSTTY = { sys: "0.2.2", commit: "a887df42c56f6de86c0fe6da9c4eeca37931e083" };

const REPOSITORY = "https://github.com/ghostty-org/ghostty.git";
const PROXIES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

/** The `libghostty-vt-sys` version `Cargo.lock` resolves, if any. */
export function lockedSysVersion(lock = join(root, "Cargo.lock")): string | undefined {
  for (const block of readFileSync(lock, "utf8").split("[[package]]")) {
    if (/name = "libghostty-vt-sys"/.test(block)) return block.match(/version = "([^"]+)"/)?.[1];
  }
  return undefined;
}

function cacheDir(): string {
  return join(process.env.DESKFOLK_NSH_CACHE ?? join(homedir(), ".cache", "deskfolk-nsh"), "ghostty", GHOSTTY.commit);
}

/** Where Ghostty's sources and its Zig packages go. */
export function ghosttyCache(): { source: string; packages: string } {
  const dir = cacheDir();
  return { source: join(dir, "source"), packages: join(dir, "zig", "p") };
}

function zigVersion(zig: string): string | undefined {
  const result = spawnSync(zig, ["version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The directory of a Zig 0.15: `ZIG`'s, the one on PATH, or Homebrew's keg-only `zig@0.15`. */
export function zig015Dir(): string | undefined {
  const candidates = [
    process.env.ZIG,
    "zig",
    "/opt/homebrew/opt/zig@0.15/bin/zig",
    "/usr/local/opt/zig@0.15/bin/zig",
  ].filter((c): c is string => !!c);
  for (const zig of candidates) {
    if (!zigVersion(zig)?.startsWith("0.15.")) continue;
    if (zig.includes("/")) return resolve(zig, "..");
    const found = spawnSync("sh", ["-c", "command -v zig"], { encoding: "utf8" }).stdout.trim();
    if (found) return resolve(found, "..");
  }
  return undefined;
}

/**
 * The env to build the `ghostty` feature with (Zig 0.15 first on PATH, the cached sources and
 * packages), or why not: no Zig 0.15, or the cache is not prepared.
 */
export function ghosttyEnv(): { env: Record<string, string> } | { missing: string } {
  const zig = zig015Dir();
  if (!zig) return { missing: "no Zig 0.15 (`brew install zig@0.15`, or ZIG=<path>)" };
  const { source, packages } = ghosttyCache();
  if (!existsSync(join(source, "build.zig")) || !existsSync(packages)) {
    return { missing: "Ghostty's sources are not prepared (`bun apps/desktop-nsh/scripts/ghostty.ts`)" };
  }
  return {
    env: {
      PATH: `${zig}:${process.env.PATH ?? ""}`,
      GHOSTTY_SOURCE_DIR: source,
      GHOSTTY_ZIG_SYSTEM_DIR: packages,
    },
  };
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return spawnSync(command, args, { cwd, stdio: "inherit", env }).status === 0;
}

/** Clones Ghostty at the pinned commit and fetches its Zig packages, unless they are there. */
export function prepareGhostty(): void {
  const zig = zig015Dir();
  if (!zig) throw new Error("no Zig 0.15: `brew install zig@0.15`, or set ZIG");
  const { source, packages } = ghosttyCache();
  if (!existsSync(join(source, "build.zig"))) {
    // Fetched into a scratch directory and moved into place, so a stopped clone is never taken for one.
    const scratch = `${source}.partial`;
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const ok =
      run("git", ["init", "--quiet"], scratch) &&
      run("git", ["remote", "add", "origin", REPOSITORY], scratch) &&
      run("git", ["fetch", "--quiet", "--depth", "1", "origin", GHOSTTY.commit], scratch) &&
      run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], scratch);
    if (!ok) throw new Error(`fetching Ghostty ${GHOSTTY.commit} failed`);
    renameSync(scratch, source);
  }
  if (!existsSync(packages)) {
    const cache = resolve(packages, "..");
    const fetch = ["build", "--fetch=all", "--global-cache-dir", cache];
    // Zig 0.15's client fails through an HTTP proxy (400): straight first, then through it.
    const direct = { ...process.env };
    for (const name of PROXIES) delete direct[name];
    console.log(`ghostty: fetching Ghostty's Zig packages into ${cache}`);
    if (!run(join(zig, "zig"), fetch, source, direct) && !run(join(zig, "zig"), fetch, source)) {
      rmSync(packages, { recursive: true, force: true });
      throw new Error("fetching Ghostty's Zig packages failed");
    }
  }
}

if (import.meta.main) {
  if (!process.argv.includes("--check")) prepareGhostty();
  const ready = ghosttyEnv();
  if ("missing" in ready) {
    console.error(`ghostty: ${ready.missing}`);
    process.exit(1);
  }
  const shell = process.argv.includes("--shell");
  for (const [name, value] of Object.entries(ready.env)) {
    if (shell) console.log(`export ${name}='${value.replaceAll("'", "'\\''")}'`);
    else console.log(`${name}=${name === "PATH" ? value.split(":")[0] + ":…" : value}`);
  }
}
