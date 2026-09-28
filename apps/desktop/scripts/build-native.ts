/**
 * Compiles this platform's native resources into `apps/desktop/src-tauri/native/`, the directory
 * `tauri.conf.json`'s `bundle.resources` copies into the app bundle whole.
 *
 * macOS: the Swift runtime helper, pty helper and credentials library (built by `swift build`),
 * plus the daemon (`bun build --compile`) — all four get `codesign`'d with the daemon entitlements
 * the credential runtime needs, and `verifyNativeMinimum` checks every one was actually built for
 * the advertised macOS minimum. Windows has no notion of any of that: WebView2 doesn't gate a
 * credential runtime behind a signed helper the way Keychain access groups do, so there is no
 * Swift helper, no `codesign`, no minimum-OS check — just the daemon and the ConPTY helper
 * (`apps/conpty-helper`, built by Cargo) copied in as-is.
 *
 * The planning functions below (`resolveTriple`, `familyFor`, `daemonBuildPlan`, `conptyBuildPlan`)
 * are pure — no I/O — so a test can exercise the Windows branch without a Windows machine, Cargo,
 * or a built `conpty-helper`. Only the `import.meta.main` block actually spawns anything.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { minimumMacOS, verifyNativeMinimum } from "./native-package";

export type Family = "darwin" | "windows";

export function familyFor(triple: string): Family {
  if (triple.endsWith("-pc-windows-msvc")) return "windows";
  if (triple.endsWith("-apple-darwin")) return "darwin";
  throw new Error(`Native packaging supports macOS and Windows triples only, got: ${triple}`);
}

/**
 * `TAURI_ENV_TARGET_TRIPLE` wins (Tauri sets it for every build hook); otherwise this host's
 * default triple for its own OS and CPU architecture, macOS or Windows.
 */
export function resolveTriple(
  env: Record<string, string | undefined>,
  platform: string,
  arch: string,
): string {
  const explicit = env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (explicit) return explicit;
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
}

function bunArch(triple: string): "arm64" | "x64" {
  return triple.startsWith("aarch64") ? "arm64" : "x64";
}

const BUN_COMPILE_FLAGS = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
];

export interface DaemonBuildPlan {
  /** argv for `Bun.spawn`, run with `cwd` at the repo root. */
  args: string[];
  outfile: string;
}

/**
 * The `bun build --compile` invocation for the daemon. Same embed flags on every platform; Windows
 * additionally stamps executable metadata Explorer and Task Manager show — title and description,
 * not `--windows-hide-console`, because the window spawns the daemon with `CREATE_NO_WINDOW`
 * itself and a compiled-in hidden console would fight that.
 */
export function daemonBuildPlan(triple: string, nativeDir: string): DaemonBuildPlan {
  const family = familyFor(triple);
  const arch = bunArch(triple);
  const outfile = resolve(nativeDir, family === "windows" ? "real-bot-daemon.exe" : "real-bot-daemon");
  const args = [
    "bun",
    "build",
    "--compile",
    `--target=bun-${family}-${arch}`,
    ...BUN_COMPILE_FLAGS,
    ...(family === "windows"
      ? [
          "--windows-title=Deskfolk Daemon",
          "--windows-description=Deskfolk background daemon",
          "--windows-icon=apps/desktop/src-tauri/icons/icon.ico",
        ]
      : []),
    "apps/daemon/src/main.ts",
    "--outfile",
    outfile,
  ];
  return { args, outfile };
}

export interface ConptyBuildPlan {
  manifestPath: string;
  /** argv for `Bun.spawn`, run with `cwd` at the repo root. */
  args: string[];
  /** Where Cargo writes the binary, relative to the repo root. */
  builtPath: string;
  /** Where it's copied to in the native resource directory. */
  destPath: string;
}

/** Builds the Windows terminal helper (`apps/conpty-helper`) for `triple` and places it beside the daemon. */
export function conptyBuildPlan(triple: string, nativeDir: string): ConptyBuildPlan {
  const manifestPath = "apps/conpty-helper/Cargo.toml";
  return {
    manifestPath,
    args: ["cargo", "build", "--release", "--manifest-path", manifestPath, "--target", triple],
    // Left relative on purpose: `resolve` here would anchor it to the cwd pnpm runs this script
    // in (`apps/desktop`), not the repo root the caller joins it onto.
    builtPath: `apps/conpty-helper/target/${triple}/release/real-bot-pty.exe`,
    destPath: resolve(nativeDir, "real-bot-pty.exe"),
  };
}

async function run(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Native build failed: ${args[0]}`);
}

async function runCapture(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`Native build failed: ${args[0]}`);
  return text.trim();
}

async function buildDarwin(root: string, triple: string, output: string): Promise<void> {
  const arch = triple.startsWith("aarch64") ? "arm64" : "x86_64";
  const macTriple = `${arch}-apple-macosx${minimumMacOS}`;

  for (const product of ["real-bot-runtime-helper", "real-bot-pty", "RemoteCredentials"]) {
    await run(root, ["swift", "build", "--package-path", "apps/runtime-helper", "-c", "release", "--triple", macTriple, "--product", product]);
  }
  const bin = await runCapture(root, ["swift", "build", "--package-path", "apps/runtime-helper", "-c", "release", "--triple", macTriple, "--show-bin-path"]);
  for (const name of ["real-bot-runtime-helper", "real-bot-pty", "libRemoteCredentials.dylib"]) {
    await copyFile(resolve(bin, name), resolve(output, name));
  }

  const { args } = daemonBuildPlan(triple, output);
  await run(root, args);

  await verifyNativeMinimum(output);

  // Stock Bun is not a sealed credential principal. Never grant it the remote access group here.
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";
  for (const [file, id] of [
    ["real-bot-runtime-helper", "com.real-bot.runtime-helper"],
    // Signed like the rest, but it carries no access group: a pty is not a credential principal.
    ["real-bot-pty", "com.real-bot.pty"],
    ["libRemoteCredentials.dylib", "com.real-bot.remote-credentials"],
    ["real-bot-daemon", "com.real-bot.daemon"],
  ]) {
    const args = ["codesign", "--force", "--sign", identity, "--identifier", id!, "--options", "runtime"];
    // Notarization rejects a Developer ID signature without a secure timestamp; ad-hoc cannot carry one.
    if (identity !== "-") args.push("--timestamp");
    if (file === "real-bot-daemon") args.push("--entitlements", resolve(import.meta.dir, "../src-tauri/daemon-entitlements.plist"));
    args.push(resolve(output, file!));
    await run(root, args);
  }
  console.log(`Native resources built in ${dirname(output)}/native; remote credentials remain disabled (G-pack not verified).`);
}

async function buildWindows(root: string, triple: string, output: string): Promise<void> {
  const { args: daemonArgs } = daemonBuildPlan(triple, output);
  await run(root, daemonArgs);

  const conpty = conptyBuildPlan(triple, output);
  await run(root, conpty.args);
  await copyFile(resolve(root, conpty.builtPath), conpty.destPath);

  console.log(`Native resources built in ${dirname(output)}/native (unsigned: Windows has no codesign equivalent here).`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..");
  const triple = resolveTriple(process.env, process.platform, process.arch);
  const output = resolve(root, "apps/desktop/src-tauri/native");
  await mkdir(output, { recursive: true });

  const family = familyFor(triple);
  if (family === "darwin") {
    await buildDarwin(root, triple, output);
  } else {
    await buildWindows(root, triple, output);
  }
}
