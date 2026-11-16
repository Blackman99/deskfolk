/**
 * Packages the NSH app on macOS.
 *
 * **Release** (`--release`): `Deskfolk.app` and `Deskfolk_<version>_<arch>.dmg`, the asset name the
 * update check of every Deskfolk since 0.1 looks for (`updates.rs` `pick_dmg`) and the bundle id and
 * version its installer verifies (`installer.rs` `verify_bundle`), so a Mac on the Tauri app updates
 * to this one in place. The shell is built with `DESKFOLK_RELEASE` (`host/src/config.rs`): it is
 * Deskfolk itself (`com.real-bot.desktop`, the standard data directory, 17890) and starts the daemon
 * compiled into `Contents/Resources/native/` with the Tauri app's `build-native.ts` (the daemon, the
 * pty, runtime and WebRTC helpers and the credentials library, each signed there), where the Tauri
 * app kept them. The version is the release's, `tauri.conf.json`'s.
 *
 * **Dev build** (default): `build/release/Deskfolk Dev.app` and a dmg, beside the installed stable
 * Deskfolk: its own bundle id, data directory and port (dev-instance.ts). It starts its own dev
 * runtime when none answers (the command is baked into the binary, as the Tauri shell's debug build
 * runs the daemon from source), so it runs on this Mac only.
 *
 *   bun apps/desktop-nsh/scripts/package.ts [--release] [--target aarch64-apple-darwin|x86_64-apple-darwin]
 *                                           [--sign developer-id|adhoc] [--notarize <keychain profile>|env]
 *                                           [--native-from <dir>] [--out <dir>] [--smoke] [--measure <runs>]
 *
 * `--sign developer-id` signs with `APPLE_SIGNING_IDENTITY`, or this keychain's "Developer ID
 * Application" identity. `--notarize` sends the app, then the dmg, to Apple's notary service with
 * `xcrun notarytool` and staples both: by a keychain profile's name, or `env` for `APPLE_ID`,
 * `APPLE_PASSWORD` and `APPLE_TEAM_ID` (release.yml). `--native-from` copies an already built and
 * signed `native/` folder instead of building one (a quick local package). `--smoke` launches the
 * packaged release with its own daemon on a machine where no runtime answers yet (a CI runner): the
 * first snapshot, the daemon inside the app with its setup channel, a quit that stops it.
 * `--measure` launches the packaged app that many times (in the background, never activated) and
 * prints the time from launch to its first snapshot and its memory footprint.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ICON_FILE, DEV_APP_NAME, DEV_BUNDLE_ID, placeAppIcon } from "./dev-instance";
import { cargoPath, nshCli } from "./nsh-cli";

/** NSH's own floor (`nsh-cli` `MACOS_MINIMUM`: an `NSView` API new in macOS 14). */
export const MACOS_MINIMUM = "14.0";
export const RELEASE_APP_NAME = "Deskfolk";
export const RELEASE_BUNDLE_ID = "com.real-bot.desktop";

/** `aarch64` / `x64`: the Tauri app's dmg names, which the update check matches (`arch_tag_for`). */
export function archTag(triple: string): "aarch64" | "x64" {
  if (triple === "aarch64-apple-darwin") return "aarch64";
  if (triple === "x86_64-apple-darwin") return "x64";
  throw new Error(`a macOS triple is aarch64-apple-darwin or x86_64-apple-darwin, got ${triple}`);
}

export function dmgName(version: string, triple: string): string {
  return `Deskfolk_${version}_${archTag(triple)}.dmg`;
}

/** The release's version: the Tauri app's `tauri.conf.json`, one of the release's version lines. */
export function productVersion(repo: string): string {
  const conf = JSON.parse(readFileSync(join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")) as { version?: string };
  if (!conf.version) throw new Error("tauri.conf.json has no version");
  return conf.version;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function infoPlist(p: { id: string; name: string; version: string; minimum: string }): string {
  const entry = (key: string, value: string) => `  <key>${key}</key><string>${escapeXml(value)}</string>\n`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
` +
    entry("CFBundleIdentifier", p.id) +
    entry("CFBundleName", p.name) +
    entry("CFBundleDisplayName", p.name) +
    entry("CFBundleExecutable", "deskfolk-nsh") +
    entry("CFBundleIconFile", APP_ICON_FILE) +
    entry("CFBundlePackageType", "APPL") +
    entry("CFBundleShortVersionString", p.version) +
    entry("CFBundleVersion", p.version) +
    entry("LSMinimumSystemVersion", p.minimum) +
    entry("LSApplicationCategoryType", "public.app-category.productivity") +
    `  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Voice input records what you say for the speech service you chose.</string>
</dict>
</plist>
`
  );
}

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function run(command: string, args: string[], env: Record<string, string> = {}, cwd = root): string {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function step(what: string) {
  console.log(`\n== ${what}`);
}

function hostTriple(): string {
  return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
}

function ptyHelper(): string {
  for (const dir of [repo, join(homedir(), "my-projects", "real-bot")]) {
    for (const path of ["apps/runtime-helper/.build/release/real-bot-pty", "apps/runtime-helper/.build/arm64-apple-macosx/debug/real-bot-pty"]) {
      if (existsSync(join(dir, path))) return join(dir, path);
    }
  }
  return "";
}

/** The Developer ID identity to sign with: the environment's (release.yml), or this keychain's. */
function developerIdentity(): string {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY;
  const found = run("security", ["find-identity", "-v", "-p", "codesigning"]).match(/"(Developer ID Application: [^"]+)"/);
  if (!found) throw new Error("no Developer ID Application identity in the keychain and no APPLE_SIGNING_IDENTITY");
  return found[1]!;
}

function notaryAuth(notarize: string): string[] {
  if (notarize !== "env") return ["--keychain-profile", notarize];
  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) throw new Error("--notarize env needs APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID");
  return ["--apple-id", APPLE_ID, "--password", APPLE_PASSWORD, "--team-id", APPLE_TEAM_ID];
}

function notarizeAndStaple(path: string, notarize: string, out: string) {
  let submit = path;
  if (path.endsWith(".app")) {
    submit = join(out, "notarize.zip");
    run("ditto", ["-c", "-k", "--keepParent", path, submit]);
  }
  const answer = run("xcrun", ["notarytool", "submit", submit, ...notaryAuth(notarize), "--wait"]);
  console.log(answer.trim());
  if (!/status:\s*Accepted/.test(answer)) throw new Error(`notarization of ${path} was not accepted`);
  console.log(run("xcrun", ["stapler", "staple", path]).trim());
  if (submit !== path) rmSync(submit, { force: true });
}

const size = (path: string) => spawnSync("du", ["-sh", path], { encoding: "utf8" }).stdout.split("\t")[0];

function packageRelease() {
  const triple = arg("--target") ?? hostTriple();
  archTag(triple);
  const version = productVersion(repo);
  const sign = arg("--sign") ?? "adhoc";
  const notarize = arg("--notarize");
  const identity = sign === "developer-id" ? developerIdentity() : "-";
  if (notarize && identity === "-") throw new Error("--notarize needs --sign developer-id");
  const out = resolve(arg("--out") ?? join(root, "build", `release-${archTag(triple)}`));
  const app = join(out, `${RELEASE_APP_NAME}.app`);
  const contents = join(app, "Contents");
  const nsh = nshCli({ build: true });
  const cargo = cargoPath();
  console.log(`Deskfolk ${version} for ${triple}, signed ${identity === "-" ? "ad hoc" : identity}${notarize ? ", notarized" : ""}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });

  step("the app's bundle (nsh build --release)");
  run(nsh, ["build", "app/App.tsx", "--release", "--out", join(out, "app")]);
  cpSync(join(out, "app"), join(contents, "Resources", "app"), { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  if (!existsSync(join(contents, "Resources", "app", "bundle.nshc"))) throw new Error("nsh build left no bundle.nshc");

  step("the daemon and its helpers");
  const native = join(contents, "Resources", "native");
  const from = arg("--native-from");
  if (from) {
    cpSync(resolve(from), native, { recursive: true });
  } else {
    // build-native.ts signs each one itself, with APPLE_SIGNING_IDENTITY (or ad hoc without it).
    const signing: Record<string, string> = identity === "-" ? {} : { APPLE_SIGNING_IDENTITY: identity };
    const built = join(repo, "apps/desktop/src-tauri/native");
    rmSync(built, { recursive: true, force: true });
    run(process.execPath, ["apps/desktop/scripts/build-native.ts"], { TAURI_ENV_TARGET_TRIPLE: triple, ...signing }, repo);
    cpSync(built, native, { recursive: true, filter: (p) => !p.endsWith(".gitkeep") });
  }
  for (const name of ["real-bot-daemon", "real-bot-pty", "real-bot-runtime-helper", "real-bot-rtc", "libRemoteCredentials.dylib"]) {
    if (!existsSync(join(native, name))) throw new Error(`native/${name} is missing`);
  }

  step("the shell (cargo build --release, DESKFOLK_RELEASE)");
  const target = triple === hostTriple() && !arg("--target") ? [] : ["--target", triple];
  run(cargo, ["build", "--release", "--locked", "-p", "deskfolk-nsh", ...target], {
    DESKFOLK_RELEASE: "1",
    MACOSX_DEPLOYMENT_TARGET: MACOS_MINIMUM,
  });
  const binary = join(root, "target", ...(target.length ? [triple] : []), "release", "deskfolk-nsh");
  cpSync(binary, join(contents, "MacOS", "deskfolk-nsh"));
  // What the shell says it is: Deskfolk, not the dev build, with no dev runtime baked in. An Intel
  // build on Apple silicon runs under Rosetta; where there is none, it is asked by its arm64 twin's
  // source instead (the same flags), so nothing is skipped silently.
  const intelHere = triple === "x86_64-apple-darwin" && process.arch === "arm64";
  const rosetta = intelHere && spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
  if (!intelHere || rosetta) {
    const said = JSON.parse(run(join(contents, "MacOS", "deskfolk-nsh"), ["--identity"])) as Record<string, unknown>;
    const expected = { name: RELEASE_APP_NAME, id: RELEASE_BUNDLE_ID, release: true, devRuntime: false };
    for (const [key, value] of Object.entries(expected)) {
      if (said[key] !== value) throw new Error(`the release shell is ${JSON.stringify(said)}`);
    }
  } else {
    console.log("no Rosetta here: the Intel shell's --identity is not run (its flags are the arm64 build's)");
  }

  placeAppIcon(app);
  writeFileSync(join(contents, "Info.plist"), infoPlist({ id: RELEASE_BUNDLE_ID, name: RELEASE_APP_NAME, version, minimum: MACOS_MINIMUM }));
  writeFileSync(join(contents, "PkgInfo"), "APPL????");

  step("signing");
  const signArgs = ["--force", "--options", "runtime", "--entitlements", join(repo, "apps/desktop/src-tauri/Entitlements.plist"), "--sign", identity];
  if (identity !== "-") signArgs.push("--timestamp");
  run("codesign", [...signArgs, app]);
  console.log(run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]).trim());
  if (notarize) notarizeAndStaple(app, notarize, out);

  step("the disk image");
  const stage = join(out, "dmg");
  mkdirSync(stage, { recursive: true });
  run("ditto", [app, join(stage, `${RELEASE_APP_NAME}.app`)]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = join(out, dmgName(version, triple));
  run("hdiutil", ["create", "-volname", RELEASE_APP_NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg]);
  rmSync(stage, { recursive: true, force: true });
  if (identity !== "-") run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
  if (notarize) notarizeAndStaple(dmg, notarize, out);

  const gatekeeper = spawnSync("spctl", ["-a", "-vv", "-t", "exec", app], { encoding: "utf8" });
  const verdict = (gatekeeper.stdout + gatekeeper.stderr).trim().replace(/\n/g, " | ");
  console.log(`gatekeeper: ${verdict}`);
  if (notarize) {
    // A notarized release opens with a double-click: Gatekeeper must say so, and both tickets hold.
    if (gatekeeper.status !== 0 || !verdict.includes("source=Notarized Developer ID")) throw new Error(`Gatekeeper does not accept ${app}: ${verdict}`);
    console.log(run("xcrun", ["stapler", "validate", app]).trim());
    console.log(run("xcrun", ["stapler", "validate", dmg]).trim());
  }
  console.log(`app ${size(app)}, ${dmg} ${size(dmg)}`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `dmg=${dmg}\napp=${app}\n`, { flag: "a" });
  return { app, dmg };
}

function packageDev() {
  const out = join(root, "build", "release");
  const app = join(out, `${DEV_APP_NAME}.app`);
  const dmg = join(out, "Deskfolk-Dev.dmg");
  const nsh = nshCli({ build: true });
  const cargo = cargoPath();
  const sign = arg("--sign") ?? "adhoc";
  const notarize = arg("--notarize");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  run(nsh, ["build", "app/App.tsx", "--release", "--out", join(out, "app")]);
  run(cargo, ["build", "--release", "-p", "deskfolk-nsh"], {
    DESKFOLK_BUN: process.execPath,
    DESKFOLK_DEV_RUNTIME: join(root, "scripts", "dev-runtime.ts"),
    DESKFOLK_PTY_HELPER: ptyHelper(),
  });
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  cpSync(join(root, "target", "release", "deskfolk-nsh"), join(contents, "MacOS", "deskfolk-nsh"));
  cpSync(join(out, "app"), join(contents, "Resources", "app"), { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  placeAppIcon(app);
  writeFileSync(join(contents, "Info.plist"), infoPlist({ id: DEV_BUNDLE_ID, name: DEV_APP_NAME, version: "0.0.0", minimum: MACOS_MINIMUM }));
  const identity = sign === "developer-id" ? developerIdentity() : "-";
  const signArgs = ["--force", "--options", "runtime", "--sign", identity];
  if (identity !== "-") signArgs.push("--timestamp");
  run("codesign", [...signArgs, app]);
  console.log(run("codesign", ["--verify", "--strict", "--verbose=2", app]).trim());
  run("hdiutil", ["create", "-volname", DEV_APP_NAME, "-srcfolder", app, "-ov", "-format", "UDZO", dmg]);
  if (identity !== "-") run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
  if (notarize) notarizeAndStaple(dmg, notarize, out);
  const gatekeeper = spawnSync("spctl", ["-a", "-vv", "-t", "exec", app], { encoding: "utf8" });
  console.log(`gatekeeper: ${(gatekeeper.stdout + gatekeeper.stderr).trim().replace(/\n/g, " | ")}`);
  console.log(`app ${size(app)}, dmg ${size(dmg)}`);
  return { app, dmg };
}

/** Drains a shell's log as it comes (a full pipe would stall the shell) and keeps all of it. */
function drain(stream: ReadableStream<Uint8Array>, echo: boolean): { text: () => string; until: (pattern: RegExp, ms: number) => Promise<boolean> } {
  let log = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      log += text;
      if (echo) process.stdout.write(text);
    }
  })();
  return {
    text: () => log,
    until: async (pattern, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (pattern.test(log)) return true;
        await Bun.sleep(100);
      }
      return pattern.test(log);
    },
  };
}

function processOf(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

/**
 * The packaged release, launched where no runtime answers yet: its own daemon comes up from inside
 * the app with the setup channel, the window gets its first snapshot, and a quit stops the daemon.
 */
async function smoke(app: string) {
  const health = await fetch("http://127.0.0.1:17890/v1/health", { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  );
  if (health) throw new Error("--smoke needs a machine where nothing answers on 17890");
  const dataDir = join(homedir(), "Library", "Application Support", "real-bot");
  const checks = join(app, "..", "smoke-requests");
  rmSync(checks, { recursive: true, force: true });
  const shell = Bun.spawn([join(app, "Contents", "MacOS", "deskfolk-nsh"), "--background", "--snapshots", checks], {
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BUN_|NODE_OPTIONS|REAL_BOT_)/.test(k))) as Record<string, string>,
  });
  const log = drain(shell.stderr, true);
  if (!(await log.until(/ready: \d+ conversations/, 180_000))) {
    shell.kill("SIGKILL");
    throw new Error("smoke: no first snapshot within 180 s");
  }
  const descriptor = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
  const daemon = processOf(descriptor.pid);
  console.log(`smoke: the runtime is pid ${descriptor.pid}: ${daemon}`);
  if (!daemon.startsWith(join(app, "Contents", "Resources", "native", "real-bot-daemon"))) {
    throw new Error("smoke: the runtime is not the daemon inside the app");
  }
  if (!daemon.includes("--desktop-remote-channel")) throw new Error("smoke: the daemon has no setup channel");

  // Killed, the daemon is started again by the shell's watch.
  process.kill(descriptor.pid, "SIGKILL");
  let again = 0;
  for (let i = 0; i < 60 && !again; i++) {
    await Bun.sleep(500);
    try {
      const next = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
      const up = await fetch("http://127.0.0.1:17890/v1/health", { signal: AbortSignal.timeout(500) }).then(
        (r) => r.ok,
        () => false,
      );
      if (up && next.pid !== descriptor.pid) again = next.pid;
    } catch {
      // Not written yet.
    }
  }
  if (!again) throw new Error("smoke: the daemon was not started again after it died");
  console.log(`smoke: started again as pid ${again}`);
  // Its token is new (each start mints one); the window reads the endpoint again and reconnects.
  if (!(await log.until(/reconnected/, 60_000))) throw new Error("smoke: the window did not reconnect to the daemon started again");
  console.log("smoke: the window reconnected");

  // The menu's Quit: applicationWillTerminate stops the daemon it supervises.
  mkdirSync(checks, { recursive: true });
  writeFileSync(join(checks, "request"), "quit\n");
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(20_000).then(() => false)]);
  if (!exited) {
    shell.kill("SIGKILL");
    throw new Error("smoke: the shell did not quit");
  }
  await Bun.sleep(1000);
  if (processOf(again)) throw new Error(`smoke: the daemon (pid ${again}) outlived the quit`);
  console.log("smoke: quit stopped the daemon");
}

async function measure(app: string, runs: number) {
  for (let i = 1; i <= runs; i++) {
    const started = performance.now();
    const shell = Bun.spawn([join(app, "Contents", "MacOS", "deskfolk-nsh"), "--background"], { stdout: "pipe", stderr: "pipe" });
    let ready = -1;
    if (await drain(shell.stderr, false).until(/ready:/, 120_000)) ready = performance.now() - started;
    await Bun.sleep(1500);
    const footprint = spawnSync("footprint", ["-p", String(shell.pid)], { encoding: "utf8" }).stdout;
    const mb = footprint.match(/phys_footprint:\s+([\d.]+ \w+)/)?.[1] ?? "?";
    console.log(`run ${i}: first snapshot ${ready.toFixed(0)} ms after launch, footprint ${mb}`);
    shell.kill("SIGTERM");
    await shell.exited;
  }
}

if (import.meta.main) {
  const release = process.argv.includes("--release");
  const { app } = release ? packageRelease() : packageDev();
  if (release && process.argv.includes("--smoke")) await smoke(app);
  const runs = Number(arg("--measure") ?? 0);
  if (runs > 0) await measure(app, runs);
}
