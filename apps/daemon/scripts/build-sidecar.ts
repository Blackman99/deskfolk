/**
 * Compiles the daemon into the standalone binary the desktop bundle ships beside the window.
 *
 * Packaging uses `pnpm --filter @real-bot/desktop build:native`, which compiles the same binary
 * into the bundle's native resource directory and signs it with the daemon entitlements. This
 * script stays for a standalone compile — a plain `real-bot-daemon` next to the window binary is
 * the fallback the Rust side accepts. `bun build --compile` embeds the Bun runtime, which is why
 * the artifact is ~60MB per arch.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Rust target triples this project ships, mapped to the Bun runtime to embed. The macOS release
 * matrix (`.github/workflows/release.yml`) packages the two Darwin triples; the Windows triples
 * exist so this script (and `tauri dev`'s `beforeDevCommand`, which always runs it) succeeds on a
 * Windows machine too — packaging a Windows build goes through `build:native` instead, not this
 * sidecar path. Bun 1.4.2 compiles both `bun-windows-x64` and `bun-windows-arm64`.
 */
export const BUN_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

/** The base name; `externalBin` in `tauri.conf.json` has to end with it. */
export const SIDECAR_NAME = "real-bot-daemon";

export function bunTargetFor(triple: string): string | null {
  return BUN_TARGETS[triple] ?? null;
}

/** Windows executables need the `.exe` suffix; every other platform ships an extensionless file. */
export function sidecarFileName(triple: string): string {
  const base = `${SIDECAR_NAME}-${triple}`;
  return triple.endsWith("-pc-windows-msvc") ? `${base}.exe` : base;
}

/** Explicit argument first, then the triple Tauri hands its build hooks, then this machine's. */
export function tripleFrom(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  host: () => string,
): string {
  return argv[0]?.trim() || env.TAURI_ENV_TARGET_TRIPLE?.trim() || host();
}

/** No `rustc` on PATH: guess from this process's own platform and architecture instead. */
export function fallbackHostTriple(platform: string, arch: string): string {
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
}

async function hostTriple(): Promise<string> {
  try {
    const proc = Bun.spawn(["rustc", "-vV"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const line = text.split("\n").find((row) => row.startsWith("host:"));
    if (line) return line.slice("host:".length).trim();
  } catch {
    // no rustc on PATH: fall back below
  }
  return fallbackHostTriple(process.platform, process.arch);
}

if (import.meta.main) {
  const daemonRoot = join(import.meta.dir, "..");
  const outDir = join(daemonRoot, "../desktop/src-tauri/binaries");
  const triple = tripleFrom(process.argv.slice(2), process.env, () => "");
  const resolved = triple || (await hostTriple());
  const target = bunTargetFor(resolved);
  if (!target) {
    console.error(
      `no Bun target for ${resolved}; known: ${Object.keys(BUN_TARGETS).join(", ")}`,
    );
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, sidecarFileName(resolved));
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${target}`,
      join(daemonRoot, "src/main.ts"),
      // A Worker the daemon starts is only inside the executable when it is an entrypoint too.
      join(daemonRoot, "src/acceptance-match-worker.ts"),
      "--outfile",
      outfile,
    ],
    { cwd: daemonRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await build.exited;
  if (code !== 0) process.exit(code);
  console.log(`sidecar ${resolved}: ${outfile}`);
}
