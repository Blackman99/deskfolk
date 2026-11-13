/**
 * The `nsh` command line the scripts build and test with: the one built from the NSH commit the
 * shell's crates are pinned to (`rev` of `nsh-core` in `apps/desktop-nsh/Cargo.toml`). The bundle
 * format and the engine must match, and the CLI writes the glue the app's Rust crate is built
 * with, so the CLI and the crates come from one commit.
 *
 * It lives in a cache shared by every checkout (`~/.cache/deskfolk-nsh/<rev>`, or
 * `DESKFOLK_NSH_CACHE`): a shallow clone of that commit and `cargo build --release --locked -p
 * nsh-cli` in it, as NSH's own `install.sh --source` does, but never linked into `~/.local/bin`,
 * which other checkouts and the released CLI use. `NSH=<path>` still overrides it.
 *
 * Once built, `source/target` keeps the CLI alone (see `keepOnlyCli`), and each use stamps
 * `<rev>/last-used`, by which `trim-target.ts` removes the commits nothing has run for a while.
 *
 *   bun apps/desktop-nsh/scripts/nsh-cli.ts           builds it if missing, prints its path
 *   bun apps/desktop-nsh/scripts/nsh-cli.ts --check   prints its path, fails if it is not built
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const REPOSITORY = "https://github.com/longbridge/nsh.git";

/** The NSH commit `Cargo.toml` pins (`nsh-core = { git = …, rev = "…" }`). */
export function nshRev(manifest = join(root, "Cargo.toml")): string {
  const text = readFileSync(manifest, "utf8");
  const line = text.split("\n").find((l) => /^nsh-core\s*=/.test(l.trim()));
  const rev = line?.match(/rev\s*=\s*"([0-9a-f]{7,40})"/)?.[1];
  if (!rev) throw new Error(`${manifest}: nsh-core has no git rev`);
  return rev;
}

/** The cache every NSH commit's CLI is built in, one directory per commit. */
export function nshCacheRoot(): string {
  return process.env.DESKFOLK_NSH_CACHE ?? join(homedir(), ".cache", "deskfolk-nsh");
}

function cacheDir(rev: string): string {
  return join(nshCacheRoot(), rev);
}

/** Where the CLI for `rev` is once built. */
export function nshCliPath(rev = nshRev()): string {
  return join(cacheDir(rev), "source", "target", "release", process.platform === "win32" ? "nsh.exe" : "nsh");
}

/** Stamps `rev`'s CLI as used now; `trim-target.ts` keeps the commits used lately. */
function markUsed(rev: string): void {
  try {
    writeFileSync(join(cacheDir(rev), "last-used"), "");
  } catch {
    // A read-only cache still runs.
  }
}

/**
 * Removes all of `source/target` but the CLI and its symbols: the rest (about 2 GB a commit) is
 * what cargo compiled to link it, and nothing reads it afterwards. The desktop app's hosts and web
 * runtime build in the app's own workspace (`app/target`), not here; a command that does build in
 * this checkout has cargo compile what it needs again. CI saves this directory as its cache, too.
 */
export function keepOnlyCli(source: string): void {
  const target = join(source, "target");
  const release = join(target, "release");
  for (const entry of readdirSync(target)) {
    if (entry !== "release") rmSync(join(target, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(release)) {
    if (!/^nsh(\.exe|\.pdb)?$/.test(entry)) rmSync(join(release, entry), { recursive: true, force: true });
  }
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

/** Clones `rev` (shallow) and builds its CLI, unless it is there already. */
export function buildNshCli(rev = nshRev()): string {
  const bin = nshCliPath(rev);
  if (existsSync(bin)) {
    markUsed(rev);
    return bin;
  }
  const dir = cacheDir(rev);
  const source = join(dir, "source");
  if (!existsSync(join(source, ".git"))) {
    // Fetched into a scratch directory and moved into place, so a stopped clone is never taken
    // for a checkout.
    const scratch = join(dir, "source.partial");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    run("git", ["init", "--quiet"], scratch);
    run("git", ["remote", "add", "origin", REPOSITORY], scratch);
    run("git", ["fetch", "--quiet", "--depth", "1", "origin", rev], scratch);
    run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], scratch);
    renameSync(scratch, source);
  }
  console.log(`nsh: building the CLI of ${rev.slice(0, 12)} in ${source} (once per NSH commit; several minutes)`);
  const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", "cargo");
  // Its own target directory, whatever the caller's CARGO_TARGET_DIR says: the path above is where it is looked for.
  const result = spawnSync(cargo, ["build", "--release", "--locked", "-p", "nsh-cli"], {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: join(source, "target") },
  });
  if (result.status !== 0) throw new Error(`building nsh-cli at ${rev} failed`);
  if (!existsSync(bin)) throw new Error(`no CLI at ${bin} after the build`);
  keepOnlyCli(source);
  markUsed(rev);
  return bin;
}

/**
 * The CLI to run: `NSH` when set, else the pinned commit's, built first when `build` is set and
 * it is missing.
 */
export function nshCli(options: { build?: boolean } = {}): string {
  if (process.env.NSH) return process.env.NSH;
  const rev = nshRev();
  const bin = nshCliPath(rev);
  if (existsSync(bin)) {
    markUsed(rev);
    return bin;
  }
  if (options.build) return buildNshCli(rev);
  throw new Error(`no nsh CLI for NSH ${nshRev().slice(0, 12)}: run \`bun apps/desktop-nsh/scripts/nsh-cli.ts\` (or set NSH)`);
}

/** The directory the CLI is in, for a PATH entry. */
export function nshCliDir(options: { build?: boolean } = {}): string {
  return dirname(nshCli(options));
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  console.log(check ? nshCli() : buildNshCli());
}
