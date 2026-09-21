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

/** Rust target triples this project ships, mapped to the Bun runtime to embed. */
export const BUN_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
};

/** The base name; `externalBin` in `tauri.conf.json` has to end with it. */
export const SIDECAR_NAME = "real-bot-daemon";

export function bunTargetFor(triple: string): string | null {
  return BUN_TARGETS[triple] ?? null;
}

export function sidecarFileName(triple: string): string {
  return `${SIDECAR_NAME}-${triple}`;
}

/** Explicit argument first, then the triple Tauri hands its build hooks, then this machine's. */
export function tripleFrom(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  host: () => string,
): string {
  return argv[0]?.trim() || env.TAURI_ENV_TARGET_TRIPLE?.trim() || host();
}

async function hostTriple(): Promise<string> {
  try {
    const proc = Bun.spawn(["rustc", "-vV"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const line = text.split("\n").find((row) => row.startsWith("host:"));
    if (line) return line.slice("host:".length).trim();
  } catch {
    // no rustc on PATH: fall back to this process's architecture
  }
  return process.arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
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
      "--outfile",
      outfile,
    ],
    { cwd: daemonRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await build.exited;
  if (code !== 0) process.exit(code);
  console.log(`sidecar ${resolved}: ${outfile}`);
}
