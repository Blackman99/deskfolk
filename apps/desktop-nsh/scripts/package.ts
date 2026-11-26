/**
 * Packages the NSH app on macOS.
 *
 * **Release** (`--release`): `Deskfolk.app` and `Deskfolk_<version>_<arch>.dmg`, the asset name the
 * update check of every Deskfolk since 0.1 looks for (`updates.rs` `pick_dmg`) and the bundle id and
 * version its installer verifies (`installer.rs` `verify_bundle`), so a Mac on the Tauri app updates
 * to this one in place. The shell is built with `DESKFOLK_RELEASE` (`host/src/config.rs`): it is
 * Deskfolk itself (`com.real-bot.desktop`, the standard data directory, 17890) and starts the daemon
 * compiled into `Contents/Resources/native/` with `build-native.ts` (the daemon, the pty, runtime
 * and WebRTC helpers and the credentials library, each signed there), where the Tauri app kept
 * them. The version is the release's, this package's `package.json` (`productVersion`).
 *
 * **Dev build** (default): `build/release/Deskfolk Dev.app` and a dmg, beside the installed stable
 * Deskfolk: its own bundle id, data directory and port (dev-instance.ts). It starts its own dev
 * runtime when none answers (the command is baked into the binary, as 0.4.0's debug build
 * runs the daemon from source), so it runs on this Mac only.
 *
 *   bun apps/desktop-nsh/scripts/package.ts [--release] [--target aarch64-apple-darwin|x86_64-apple-darwin]
 *                                           [--sign developer-id|adhoc] [--notarize <keychain profile>|env]
 *                                           [--native-from <dir>] [--out <dir>] [--smoke] [--upgrade-from <setup.exe>]
 *                                           [--stage-only | --from-stage <dir> | --smoke-only <setup.exe>]
 *                                           [--measure <runs>]
 *
 * `--sign developer-id` signs with `APPLE_SIGNING_IDENTITY`, or this keychain's "Developer ID
 * Application" identity. `--notarize` sends the app, then the dmg, to Apple's notary service with
 * `xcrun notarytool` and staples both: by a keychain profile's name, or `env` for `APPLE_ID`,
 * `APPLE_PASSWORD` and `APPLE_TEAM_ID` (release.yml). `--native-from` copies an already built and
 * signed `native/` folder instead of building one (a quick local package). `--smoke` launches the
 * packaged release with its own daemon on a machine where no runtime answers yet (a CI runner): the
 * first snapshot, the daemon inside the app with its setup channel, a quit that stops it. On Windows
 * it installs the installer silently first (over each `--upgrade-from <earlier setup.exe>` in turn,
 * installed before it in a folder of its own, when given) and uninstalls it at the end.
 * On Linux (x86_64) `--release` makes `Deskfolk_<version>_amd64.deb` and `Deskfolk_<version>_amd64.AppImage`
 * (the names `updates.rs` `pick_linux_package` matches) and `--smoke` installs the deb (over each
 * `--upgrade-from <earlier .deb>` first, started, when given), runs it, and removes it; run it under
 * `dbus-run-session -- xvfb-run -a` (release.yml).
 * `--measure` launches the packaged app that many times (in the background, never activated) and
 * prints the time from launch to its first snapshot and its memory footprint.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { windowsSignArgv } from "./build-native";
import { APP_ICON_FILE, DEV_APP_NAME, DEV_BUNDLE_ID, placeAppIcon } from "./dev-instance";
import { minimumMacOS } from "./native-package";
import { cargoPath, nshCli } from "./nsh-cli";

/** NSH's own floor (`nsh-cli` `MACOS_MINIMUM`: an `NSView` API new in macOS 14), kept in `native-package.ts` beside the native helpers' check. */
export const MACOS_MINIMUM = minimumMacOS;
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

/** The Windows installer's name, the one the update check matches (`updates.rs` `pick_windows_installer`). */
export function setupName(version: string): string {
  return `Deskfolk_${version}_x64-setup.exe`;
}

/** Relative paths under the Windows stage directory that carry Authenticode signatures. */
export const WINDOWS_SIGNABLE_BINARIES = [
  "Deskfolk.exe",
  "native/real-bot-daemon.exe",
  "native/real-bot-pty.exe",
  "native/real-bot-rtc.exe",
] as const;

export type WindowsPackageMode =
  | { kind: "full" }
  | { kind: "stage-only" }
  | { kind: "from-stage"; stageDir: string }
  | { kind: "smoke-only"; setupPath: string };

/**
 * Selects which phase of Windows release packaging to run: building the staged tree (`--stage-only`),
 * wrapping a (signed) stage into the NSIS installer (`--from-stage <dir>`), running smoke tests on
 * an already-built/signed installer (`--smoke-only <setup.exe>`), or all of them in one pass.
 */
export function windowsPackageMode(argv: string[]): WindowsPackageMode {
  const stageOnly = argv.includes("--stage-only");
  const fromStageIndex = argv.indexOf("--from-stage");
  const smokeOnlyIndex = argv.indexOf("--smoke-only");
  const selected = [stageOnly, fromStageIndex !== -1, smokeOnlyIndex !== -1].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("--stage-only, --from-stage and --smoke-only are mutually exclusive");
  }
  if (stageOnly) return { kind: "stage-only" };
  if (fromStageIndex !== -1) {
    const stageDir = argv[fromStageIndex + 1]?.trim();
    if (!stageDir || stageDir.startsWith("--")) throw new Error("--from-stage needs a directory");
    return { kind: "from-stage", stageDir };
  }
  if (smokeOnlyIndex !== -1) {
    const setupPath = argv[smokeOnlyIndex + 1]?.trim();
    if (!setupPath || setupPath.startsWith("--")) throw new Error("--smoke-only needs an installer path");
    return { kind: "smoke-only", setupPath };
  }
  return { kind: "full" };
}

/** An installer's four-part version (`VIProductVersion`): the release's numbers, a pre-release tag dropped. */
export function windowsFileVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(/[-+]/)[0]!.split(".");
  return `${major}.${minor}.${patch}.0`;
}

/** The Linux packages' names, the ones the update check matches (`updates.rs` `pick_linux_package`). */
export function debName(version: string): string {
  return `Deskfolk_${version}_amd64.deb`;
}

export function appImageName(version: string): string {
  return `Deskfolk_${version}_amd64.AppImage`;
}

/** dpkg's spelling of a version: a pre-release tag sorts before the release, which `~` does and `-` does not. */
export function debianVersion(version: string): string {
  return version.replace("-", "~");
}

/** The shell's file name, which the Tauri app's package used too: the 0.4.0 deb upgrades in place. */
export const LINUX_MAIN = "real-bot-desktop";
/** Where the package keeps the program: the shell, `app/` and `native/` side by side (`config.rs`, `runtime.rs`). */
export const LINUX_LIB = "usr/lib/Deskfolk";
export const LINUX_NATIVE = ["real-bot-daemon", "real-bot-pty", "real-bot-rtc"];
/** The desktop entry's name is the app id: NSH's notifications name it as their desktop entry. */
export const LINUX_DESKTOP_ENTRY = `${RELEASE_BUNDLE_ID}.desktop`;
export const LINUX_POLICY = `${RELEASE_BUNDLE_ID}.policy`;

/** The hicolor icon sizes and the file each is made from (`assets/linux/icons`). */
export function linuxIcons(): { size: number; from: string; to: string }[] {
  return [32, 64, 128, 256, 512].map((size) => ({
    size,
    from: `${size}x${size}.png`,
    to: `usr/share/icons/hicolor/${size}x${size}/apps/${RELEASE_BUNDLE_ID}.png`,
  }));
}

/** What the deb needs besides what `dpkg-shlibdeps` finds: libraries the shell opens at run time. */
export const DEB_DEPENDS = [
  "libgtk-4-1 (>= 4.14)",
  "libsecret-1-0",
  "libwebkitgtk-6.0-4",
  "gstreamer1.0-plugins-base",
  "libasound2t64 | libasound2",
  "polkitd | policykit-1",
];
export const DEB_RECOMMENDS = [
  "gnome-keyring | kwalletmanager",
  "xdg-desktop-portal-gtk | xdg-desktop-portal-gnome | xdg-desktop-portal-kde",
  "gstreamer1.0-plugins-good",
];
export const DEB_SUGGESTS = ["gnome-shell-extension-appindicator", "x11vnc", "fonts-noto-cjk"];

/**
 * The two dependency lists joined, one entry per package: where both name a package, the second
 * list's wins (it is the stricter, written by hand: `libgtk-4-1 (>= 4.14)` over what the linker saw).
 */
export function mergeDepends(found: string, wanted: string[]): string {
  const key = (entry: string) => entry.replace(/\s*\(.*?\)/g, "").replace(/\s+/g, "");
  const kept = new Map<string, string>();
  for (const entry of found.split(",").map((e) => e.trim()).filter(Boolean)) kept.set(key(entry), entry);
  for (const entry of wanted) kept.set(key(entry), entry);
  return [...kept.values()].join(", ");
}

export function controlFile(p: { version: string; depends: string; installedSizeKb?: number }): string {
  return (
    [
      "Package: deskfolk",
      `Version: ${debianVersion(p.version)}`,
      "Architecture: amd64",
      "Section: utils",
      "Priority: optional",
      "Maintainer: Deskfolk contributors <noreply@deskfolk.invalid>",
      ...(p.installedSizeKb ? [`Installed-Size: ${p.installedSizeKb}`] : []),
      `Depends: ${p.depends}`,
      `Recommends: ${DEB_RECOMMENDS.join(", ")}`,
      `Suggests: ${DEB_SUGGESTS.join(", ")}`,
      "Description: A desk for you and your Bots",
      " Deskfolk runs your Bots, their conversations and their terminals on your computer,",
      " and lets a paired phone reach them.",
    ].join("\n") + "\n"
  );
}

/**
 * Stops a running Deskfolk before its files are replaced, as the Windows installer's STOP_DESKFOLK
 * does: the app is asked to quit first (it stops its daemon on the way out), then whatever is left
 * is killed. The shell's name is longer than the 15 characters `pkill -x` compares (it would match
 * nothing), so it is found by the start of its command line instead; this also finds the Tauri
 * app's process of 0.4.0, which had the same name. Never fails the install.
 */
export function preinstScript(): string {
  const shell = "^([^ ]*/)?real-bot-desktop( |$)";
  const helpers = ["real-bot-daemon", "real-bot-pty", "real-bot-rtc"];
  return `#!/bin/sh
set -e
case "$1" in
  install|upgrade)
    pkill -TERM -f '${shell}' || true
    i=0
    while [ "$i" -lt 10 ]; do
      pgrep -f '${shell}' >/dev/null 2>&1 || pgrep -x real-bot-daemon >/dev/null 2>&1 || break
      sleep 0.5
      i=$((i + 1))
    done
    pkill -KILL -f '${shell}' || true
${helpers.map((name) => `    pkill -KILL -x ${name} || true`).join("\n")}
    ;;
esac
exit 0
`;
}

/** The AppImage's entry point: the AppDir's hooks (linuxdeploy-plugin-gtk's environment), then the shell. */
export function appRunScript(): string {
  return `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
APPDIR="\${APPDIR:-$HERE}"
export APPDIR
for hook in "$APPDIR"/apprun-hooks/*.sh; do
  [ -f "$hook" ] && . "$hook"
done
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APPDIR/${LINUX_LIB}/${LINUX_MAIN}" "$@"
`;
}

/** The release's version: this package's `package.json`, the one place it is kept (the host reads the same file). */
export function productVersion(repo: string): string {
  const conf = JSON.parse(readFileSync(join(repo, "apps/desktop-nsh/package.json"), "utf8")) as { version?: string };
  if (!conf.version) throw new Error("apps/desktop-nsh/package.json has no version");
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
  <key>NSLocalNetworkUsageDescription</key><string>Deskfolk connects your paired phone straight to this Mac's screen when both are on the same network.</string>
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

/**
 * A compressed disk image of `source`, sized from what it holds. Left to size itself from
 * `-srcfolder`, hdiutil made the volume too small on a release runner (macos-26-arm64, 2026-11-17:
 * "No space left on device" copying the daemon in), though the same build had fit that morning.
 * The free space is printed first, so a runner whose own disk is full shows as that.
 */
function createDmg(volume: string, source: string, dmg: string): void {
  const kb = Number(spawnSync("du", ["-sk", source], { encoding: "utf8" }).stdout.split("\t")[0]) || 0;
  const mb = Math.ceil((kb * 1.25) / 1024) + 64;
  console.log(`disk image: ${Math.round(kb / 1024)} MB in a ${mb} MB volume; ${spawnSync("df", ["-h", dirname(dmg)], { encoding: "utf8" }).stdout.trim().split("\n").pop()}`);
  run("hdiutil", ["create", "-volname", volume, "-srcfolder", source, "-size", `${mb}m`, "-ov", "-format", "UDZO", dmg]);
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
    const built = join(repo, "apps/desktop-nsh/build/native");
    rmSync(built, { recursive: true, force: true });
    run(process.execPath, ["apps/desktop-nsh/scripts/build-native.ts", "--target", triple], { ...signing }, repo);
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
    checkIdentity(join(contents, "MacOS", "deskfolk-nsh"));
  } else {
    console.log("no Rosetta here: the Intel shell's --identity is not run (its flags are the arm64 build's)");
  }

  placeAppIcon(app);
  writeFileSync(join(contents, "Info.plist"), infoPlist({ id: RELEASE_BUNDLE_ID, name: RELEASE_APP_NAME, version, minimum: MACOS_MINIMUM }));
  writeFileSync(join(contents, "PkgInfo"), "APPL????");

  step("signing");
  const signArgs = ["--force", "--options", "runtime", "--entitlements", join(repo, "apps/desktop-nsh/assets/Entitlements.plist"), "--sign", identity];
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
  createDmg(RELEASE_APP_NAME, stage, dmg);
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

/** The release's identity check: the shell must say it is Deskfolk, with no dev runtime baked in. */
function checkIdentity(shell: string) {
  const said = JSON.parse(run(shell, ["--identity"])) as Record<string, unknown>;
  const expected = { name: RELEASE_APP_NAME, id: RELEASE_BUNDLE_ID, release: true, devRuntime: false };
  for (const [key, value] of Object.entries(expected)) {
    if (said[key] !== value) throw new Error(`the release shell is ${JSON.stringify(said)}`);
  }
}

/**
 * The Windows shell's version information (`host/build.rs`): the product's name and version, as
 * Explorer's Details tab reads them. It goes in with the rest of the exe's resources (its icon, its
 * manifest), so an exe that says them has those too.
 */
function checkVersionInfo(exe: string, version: string) {
  const script = "$i = (Get-Item -LiteralPath $env:DESKFOLK_EXE).VersionInfo; @{ name = $i.ProductName; version = $i.ProductVersion } | ConvertTo-Json -Compress";
  const asked = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, DESKFOLK_EXE: exe },
    encoding: "utf8",
  });
  if (asked.status !== 0) throw new Error(`reading ${exe}'s version information failed:\n${asked.stdout}${asked.stderr}`);
  const said = JSON.parse(asked.stdout.trim()) as { name?: string | null; version?: string | null };
  if (said.name !== RELEASE_APP_NAME || said.version !== version) {
    throw new Error(`${exe} says it is ${JSON.stringify(said)}, not ${RELEASE_APP_NAME} ${version}: its resources did not go in (host/build.rs)`);
  }
}

function makensis(): string {
  for (const candidate of [process.env.MAKENSIS, "C:\\Program Files (x86)\\NSIS\\makensis.exe", "C:\\Program Files\\NSIS\\makensis.exe"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (spawnSync("makensis", ["-VERSION"]).status === 0) return "makensis";
  throw new Error("no makensis: install NSIS (choco install nsis) or set MAKENSIS");
}

function signWindowsFile(file: string) {
  const sign = process.env.REAL_BOT_WINDOWS_SIGN_COMMAND?.trim();
  if (!sign) return;
  const argv = windowsSignArgv(sign, file);
  run(argv[0]!, argv.slice(1), {}, repo);
}

/**
 * Builds the Windows staging tree (`stage/app`, `stage/native`, `stage/Deskfolk.exe`, `stage/icon.ico`)
 * so an external signer such as SignPath can sign the inner `.exe` files before `makensis` packs them.
 */
function stageReleaseWindows(out: string) {
  const triple = "x86_64-pc-windows-msvc";
  const version = productVersion(repo);
  const stage = join(out, "stage");
  const nsh = nshCli({ build: true });
  const cargo = cargoPath();
  console.log(`Deskfolk ${version} for ${triple}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  step("the app's bundle (nsh build --release)");
  run(nsh, ["build", "app/App.tsx", "--release", "--out", join(out, "app")]);
  cpSync(join(out, "app"), join(stage, "app"), { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  if (!existsSync(join(stage, "app", "bundle.nshc"))) throw new Error("nsh build left no bundle.nshc");

  step("the daemon and its helpers");
  const built = join(repo, "apps/desktop-nsh/build/native");
  rmSync(built, { recursive: true, force: true });
  run(process.execPath, ["apps/desktop-nsh/scripts/build-native.ts", "--target", triple], {}, repo);
  cpSync(built, join(stage, "native"), { recursive: true, filter: (p) => !p.endsWith(".gitkeep") });
  for (const name of ["real-bot-daemon.exe", "real-bot-pty.exe", "real-bot-rtc.exe"]) {
    if (!existsSync(join(stage, "native", name))) throw new Error(`native\\${name} is missing`);
  }

  step("the shell (cargo build --release, DESKFOLK_RELEASE)");
  run(cargo, ["build", "--release", "--locked", "-p", "deskfolk-nsh"], { DESKFOLK_RELEASE: "1" });
  cpSync(join(root, "target", "release", "deskfolk-nsh.exe"), join(stage, "Deskfolk.exe"));
  checkIdentity(join(stage, "Deskfolk.exe"));
  checkVersionInfo(join(stage, "Deskfolk.exe"), version);
  signWindowsFile(join(stage, "Deskfolk.exe"));
  cpSync(join(repo, "apps/desktop-nsh/assets/icons/icon.ico"), join(stage, "icon.ico"));

  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `stage=${stage}\n`, { flag: "a" });
  return { stage, version };
}

/**
 * Packs a staged Windows tree into `Deskfolk_<version>_x64-setup.exe` (`scripts/installer.nsi`).
 */
function packWindowsInstaller(stage: string, out: string) {
  const version = productVersion(repo);
  for (const rel of ["app/bundle.nshc", "icon.ico", ...WINDOWS_SIGNABLE_BINARIES]) {
    if (!existsSync(join(stage, rel))) throw new Error(`stage is missing ${rel}`);
  }
  mkdirSync(out, { recursive: true });

  step("the installer (makensis)");
  const setup = join(out, setupName(version));
  run(makensis(), [
    `/DVERSION=${version}`,
    `/DFILEVERSION=${windowsFileVersion(version)}`,
    `/DSTAGE=${stage}`,
    `/DOUTFILE=${setup}`,
    join(root, "scripts", "installer.nsi"),
  ]);
  signWindowsFile(setup);
  console.log(`${setup} ${size(setup)}`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `setup=${setup}\n`, { flag: "a" });
  return { setup, version };
}

/**
 * Windows: `Deskfolk_<version>_x64-setup.exe` (scripts/installer.nsi), installing the shell as the
 * Tauri app's main program, the bundle in `app\` and the daemon with its helpers in `native\`.
 */
function packageReleaseWindows(out: string = resolve(arg("--out") ?? join(root, "build", "release-windows"))) {
  const { stage } = stageReleaseWindows(out);
  return packWindowsInstaller(stage, out);
}

/** A tool the Linux packaging needs: its path from the environment variable, or from `PATH`. */
function linuxTool(command: string, envName: string, hint: string): string {
  const named = process.env[envName];
  if (named) {
    if (!existsSync(named)) throw new Error(`${envName} is ${named}, which does not exist`);
    return named;
  }
  if (spawnSync("sh", ["-c", `command -v ${command}`]).status === 0) return command;
  throw new Error(`no ${command} on PATH (or ${envName}): ${hint}`);
}

/** The shared libraries the shell and the helpers link, as `dpkg-shlibdeps` names their packages. */
function shlibsDepends(files: string[]): string {
  const scratch = join(root, "build", "shlibdeps");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "debian"), { recursive: true });
  // dpkg-shlibdeps reads a source tree's debian/control; this stub is the least it accepts.
  writeFileSync(join(scratch, "debian", "control"), "Source: deskfolk\n\nPackage: deskfolk\nArchitecture: amd64\n");
  const said = run("dpkg-shlibdeps", ["-O", "--ignore-missing-info", ...files.map((f) => `-e${f}`)], {}, scratch);
  const found = said.match(/^shlibs:Depends=(.*)$/m)?.[1];
  if (found === undefined) throw new Error(`dpkg-shlibdeps named no dependencies:\n${said}`);
  rmSync(scratch, { recursive: true, force: true });
  return found;
}

/**
 * Linux (x86_64): `Deskfolk_<version>_amd64.deb` and `Deskfolk_<version>_amd64.AppImage`, one `usr/`
 * tree in both. The shell is `usr/lib/Deskfolk/real-bot-desktop` with `app/` and `native/` beside it
 * (`config.rs` `packaged_bundle_for`, `runtime.rs` `daemon_path_for`); `usr/bin/real-bot-desktop`
 * links to it. The deb upgrades the Tauri app's 0.4.0 one in place (same package and file names).
 */
function packageReleaseLinux() {
  const triple = "x86_64-unknown-linux-gnu";
  const version = productVersion(repo);
  const out = resolve(arg("--out") ?? join(root, "build", "release-linux"));
  const stage = join(out, "stage");
  const lib = join(stage, LINUX_LIB);
  const nsh = nshCli({ build: true });
  const cargo = cargoPath();
  console.log(`Deskfolk ${version} for ${triple}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(lib, { recursive: true });

  step("the app's bundle (nsh build --release)");
  run(nsh, ["build", "app/App.tsx", "--release", "--out", join(out, "app")]);
  cpSync(join(out, "app"), join(lib, "app"), { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  if (!existsSync(join(lib, "app", "bundle.nshc"))) throw new Error("nsh build left no bundle.nshc");

  step("the daemon and its helpers");
  const built = join(repo, "apps/desktop-nsh/build/native");
  rmSync(built, { recursive: true, force: true });
  run(process.execPath, ["apps/desktop-nsh/scripts/build-native.ts", "--target", triple], {}, repo);
  cpSync(built, join(lib, "native"), { recursive: true, filter: (p) => !p.endsWith(".gitkeep") });
  for (const name of LINUX_NATIVE) {
    if (!existsSync(join(lib, "native", name))) throw new Error(`native/${name} is missing`);
    chmodSync(join(lib, "native", name), 0o755);
  }

  step("the shell (cargo build --release, DESKFOLK_RELEASE)");
  run(cargo, ["build", "--release", "--locked", "-p", "deskfolk-nsh"], { DESKFOLK_RELEASE: "1" });
  cpSync(join(root, "target", "release", "deskfolk-nsh"), join(lib, LINUX_MAIN));
  chmodSync(join(lib, LINUX_MAIN), 0o755);
  checkIdentity(join(lib, LINUX_MAIN));

  step("the files around it (launcher, entry, icons, polkit policy)");
  mkdirSync(join(stage, "usr", "bin"), { recursive: true });
  symlinkSync(`../lib/Deskfolk/${LINUX_MAIN}`, join(stage, "usr", "bin", LINUX_MAIN));
  const assets = join(root, "assets", "linux");
  mkdirSync(join(stage, "usr/share/applications"), { recursive: true });
  cpSync(join(assets, LINUX_DESKTOP_ENTRY), join(stage, "usr/share/applications", LINUX_DESKTOP_ENTRY));
  for (const icon of linuxIcons()) {
    mkdirSync(join(stage, icon.to, ".."), { recursive: true });
    cpSync(join(assets, "icons", icon.from), join(stage, icon.to));
  }
  mkdirSync(join(stage, "usr/share/polkit-1/actions"), { recursive: true });
  cpSync(join(assets, LINUX_POLICY), join(stage, "usr/share/polkit-1/actions", LINUX_POLICY));

  step("the deb (dpkg-deb)");
  const deb = join(out, debName(version));
  const debRoot = join(out, "deb");
  cpSync(stage, debRoot, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
  const depends = mergeDepends(
    shlibsDepends([join(lib, LINUX_MAIN), ...LINUX_NATIVE.map((name) => join(lib, "native", name))]),
    DEB_DEPENDS,
  );
  const installedSize = Number(spawnSync("du", ["-sk", stage], { encoding: "utf8" }).stdout.split("\t")[0]) || undefined;
  writeFileSync(join(debRoot, "DEBIAN", "control"), controlFile({ version, depends, installedSizeKb: installedSize }));
  writeFileSync(join(debRoot, "DEBIAN", "preinst"), preinstScript(), { mode: 0o755 });
  chmodSync(join(debRoot, "DEBIAN", "preinst"), 0o755);
  run("dpkg-deb", ["--root-owner-group", "--build", debRoot, deb]);
  rmSync(debRoot, { recursive: true, force: true });
  console.log(run("dpkg-deb", ["--info", deb]).trim());

  step("the AppImage (linuxdeploy, appimagetool)");
  const appImage = join(out, appImageName(version));
  buildAppImage(stage, out, appImage);

  console.log(`${deb} ${size(deb)}, ${appImage} ${size(appImage)}`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `deb=${deb}\nappimage=${appImage}\n`, { flag: "a" });
  return { deb, appImage, version };
}

/**
 * An AppDir of the same `usr/` tree with the GTK 4 libraries bundled by linuxdeploy's GTK plugin
 * (`DEPLOY_GTK_VERSION=4`), made into an AppImage by appimagetool. Both tools are downloaded and
 * pinned by release.yml; run inside a container without FUSE, they need `APPIMAGE_EXTRACT_AND_RUN=1`.
 * An AppImage cannot install the polkit policy (`assets/linux/com.real-bot.desktop.policy` belongs
 * in `/usr/share/polkit-1/actions`), so pairing a phone there answers `confirm_not_configured`
 * until the policy is installed by hand.
 */
function buildAppImage(stage: string, out: string, appImage: string) {
  const linuxdeploy = linuxTool("linuxdeploy", "LINUXDEPLOY", "download linuxdeploy-x86_64.AppImage (github.com/linuxdeploy/linuxdeploy) and make it executable");
  const appimagetool = linuxTool("appimagetool", "APPIMAGETOOL", "download appimagetool-x86_64.AppImage (github.com/AppImage/appimagetool) and make it executable");
  // linuxdeploy finds its GTK plugin as `linuxdeploy-plugin-gtk` (or `.sh`) on PATH.
  const plugin = process.env.LINUXDEPLOY_PLUGIN_GTK;
  const onPath = spawnSync("sh", ["-c", "command -v linuxdeploy-plugin-gtk || command -v linuxdeploy-plugin-gtk.sh"]).status === 0;
  if (!plugin && !onPath) throw new Error("no linuxdeploy-plugin-gtk on PATH (or LINUXDEPLOY_PLUGIN_GTK): get linuxdeploy-plugin-gtk.sh from github.com/linuxdeploy/linuxdeploy-plugin-gtk");
  const pluginPath: Record<string, string> = plugin ? { PATH: `${resolve(plugin, "..")}:${process.env.PATH ?? ""}` } : {};
  const appDir = join(out, "AppDir");
  cpSync(stage, appDir, { recursive: true, verbatimSymlinks: true });
  const env = { APPIMAGE_EXTRACT_AND_RUN: "1", DEPLOY_GTK_VERSION: "4", ARCH: "x86_64", ...pluginPath };
  const lib = join(appDir, LINUX_LIB);
  run(linuxdeploy, [
    "--appdir", appDir,
    "--plugin", "gtk",
    "--executable", join(lib, LINUX_MAIN),
    "--desktop-file", join(appDir, "usr/share/applications", LINUX_DESKTOP_ENTRY),
    "--icon-file", join(appDir, "usr/share/icons/hicolor/512x512/apps", `${RELEASE_BUNDLE_ID}.png`),
  ], env);
  // The entry and icon at the top, as an AppImage wants them (linuxdeploy links them there).
  cpSync(join(appDir, "usr/share/applications", LINUX_DESKTOP_ENTRY), join(appDir, LINUX_DESKTOP_ENTRY));
  cpSync(join(appDir, "usr/share/icons/hicolor/512x512/apps", `${RELEASE_BUNDLE_ID}.png`), join(appDir, `${RELEASE_BUNDLE_ID}.png`));
  // linuxdeploy may have copied the shell into usr/bin; the launcher there is the link, as in the deb.
  rmSync(join(appDir, "usr", "bin", LINUX_MAIN), { force: true });
  symlinkSync(`../lib/Deskfolk/${LINUX_MAIN}`, join(appDir, "usr", "bin", LINUX_MAIN));
  // Ours, after linuxdeploy's: it runs the plugin's environment hooks, then the shell.
  rmSync(join(appDir, "AppRun"), { force: true });
  writeFileSync(join(appDir, "AppRun"), appRunScript(), { mode: 0o755 });
  chmodSync(join(appDir, "AppRun"), 0o755);
  run(appimagetool, [appDir, appImage], env);
  chmodSync(appImage, 0o755);
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
  createDmg(DEV_APP_NAME, app, dmg);
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

/** A process's command line, as Windows has it, or "" when it is gone. */
function windowsCommandLine(pid: number): string {
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" });
  return ps.stdout.trim();
}

/** What the runtime says of itself (`GET /v1/runtime`), with the token its descriptor names. */
async function runtimeInfo(dataDir: string): Promise<{ mode?: string; restart?: string; stopped?: boolean }> {
  const { token } = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { token: string };
  const answer = await fetch("http://127.0.0.1:17890/v1/runtime", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
  return (await answer.json()) as { mode?: string; restart?: string; stopped?: boolean };
}

/** The pids of the processes named `image` (`real-bot-pty.exe`), as `tasklist` lists them. */
function windowsPids(image: string): number[] {
  const list = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return list.stdout
    .split("\n")
    .map((line) => Number(line.split(",")[1]?.replace(/"/g, "")))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function windowsProcessPath(pid: number): string {
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], { encoding: "utf8" });
  return ps.stdout.trim();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The window handle Windows gives a process as its main one: 0 while it has no visible window. */
function windowsMainWindow(pid: number): number {
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`], { encoding: "utf8" });
  return Number(ps.stdout.trim() || "0");
}

/**
 * Closes the process's main window as a person does: `SC_CLOSE` with no pointer, the window menu's
 * Close (NSH reports it as `menu`, and the app puts the window away). A bare `WM_CLOSE`, as
 * `taskkill` without `/F` sends, comes from outside the window: NSH reports it as `system`, the
 * way a log-off closes, and the app quits for that.
 */
function windowsPressClose(pid: number): void {
  const script = [
    `$sig = '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'`,
    `$user32 = Add-Type -MemberDefinition $sig -Name User32 -Namespace Smoke -PassThru`,
    `$window = (Get-Process -Id ${pid}).MainWindowHandle`,
    // WM_SYSCOMMAND, SC_CLOSE.
    `[void]$user32::PostMessage($window, 0x0112, [System.IntPtr]0xF060, [System.IntPtr]0)`,
  ].join("; ");
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`smoke: could not close the window: ${ps.stderr}`);
}

/**
 * The process's unowned `NshWindow`s in `EnumWindows` order: the order `win.rs`'s `nsh_window()`
 * meets them in, taking the first. On NSH's window model the engine's host is a window of that class
 * too, one that never shows, beside the window the app opens; the tray's Show, the Windows Hello
 * sheet's parent and the wheel all ask `nsh_window()`, so the app's window has to be the one it finds.
 */
function windowsNshWindows(pid: number): Array<{ hwnd: string; visible: boolean; title: string }> {
  const script = join(tmpdir(), `deskfolk-smoke-windows-${process.pid}.ps1`);
  writeFileSync(
    script,
    [
      "Add-Type -TypeDefinition @'",
      "using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;",
      "public static class SmokeNshWindows {",
      "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
      '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      "  public static List<string> Of(uint target) {",
      "    var rows = new List<string>();",
      "    EnumWindows((h, l) => {",
      "      uint pid; GetWindowThreadProcessId(h, out pid);",
      "      if (pid != target || GetWindow(h, 4) != IntPtr.Zero) return true;",
      "      var c = new StringBuilder(64); GetClassName(h, c, 64);",
      '      if (c.ToString() != "NshWindow") return true;',
      "      var t = new StringBuilder(256); GetWindowText(h, t, 256);",
      '      rows.Add(h.ToInt64() + "\\t" + (IsWindowVisible(h) ? 1 : 0) + "\\t" + t.ToString());',
      "      return true;",
      "    }, IntPtr.Zero);",
      "    return rows;",
      "  }",
      "}",
      "'@",
      `[SmokeNshWindows]::Of(${pid}) | ForEach-Object { $_ }`,
    ].join("\r\n"),
  );
  try {
    const ps = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    if (ps.status !== 0) throw new Error(`smoke: could not list the app's windows: ${ps.stderr}`);
    return ps.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const [hwnd = "", visible = "", title = ""] = line.split("\t");
        return { hwnd, visible: visible === "1", title };
      });
  } finally {
    rmSync(script, { force: true });
  }
}

/** The launch-at-login value (`win_login.rs`), or "" when there is none. */
function runValue(): string {
  const query = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Deskfolk"], { encoding: "utf8" });
  const line = query.stdout.split("\n").find((l) => l.includes("Deskfolk")) ?? "";
  return line.split(/REG_\w+/)[1]?.trim() ?? "";
}

async function healthyAt17890(): Promise<boolean> {
  return fetch("http://127.0.0.1:17890/v1/health", { signal: AbortSignal.timeout(500) }).then(
    (r) => r.ok,
    () => false,
  );
}

/**
 * Windows, on a machine where no runtime answers yet (a CI runner): the installer run silently,
 * the installed app's own daemon up from `native\` with its remote setup channel, the first
 * snapshot, the daemon killed and started again with the window reconnecting, a close that puts
 * the window away, `--quit` that ends the app and its daemon, an app ended outright taking its
 * daemon with it, and a silent uninstall that takes the program and its entry away and leaves the
 * data folder.
 */
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deskfolk";

/** A value of the uninstall entry, or "" when there is none. */
function uninstallValue(name: string): string {
  const query = spawnSync("reg", ["query", UNINSTALL_KEY, "/v", name], { encoding: "utf8" });
  const line = query.stdout.split("\n").find((l) => l.includes(name)) ?? "";
  return line.split(/REG_\w+/)[1]?.trim() ?? "";
}

async function smokeWindows(setup: string, upgradeFrom?: string) {
  if (await healthyAt17890()) throw new Error("--smoke needs a machine where nothing answers on 17890");
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("no LOCALAPPDATA");
  const defaultDir = join(local, "Deskfolk");
  const dataDir = join(local, "real-bot");
  // An earlier Deskfolk first, in a folder of its own choosing (the Tauri app let you pick one; for
  // 0.5.0 it is the Tauri app's installer): the new one must go over it, in that folder.
  let installDir = defaultDir;
  let mainName = "Deskfolk.exe";
  if (upgradeFrom) {
    installDir = join(local, "Programs", "DeskfolkElsewhere");
    const before = spawnSync(resolve(upgradeFrom), ["/S", `/D=${installDir}`], { encoding: "utf8" });
    if (before.status !== 0) throw new Error(`smoke: the earlier installer exited ${before.status}`);
    mainName = uninstallValue("MainBinaryName") || mainName;
    console.log(`smoke: ${upgradeFrom} installed ${uninstallValue("DisplayVersion")} as ${mainName} in ${installDir}`);
    if (!existsSync(join(installDir, mainName))) throw new Error(`smoke: the earlier install has no ${mainName}`);
  }
  const installed = spawnSync(setup, ["/S"], { encoding: "utf8" });
  if (installed.status !== 0) throw new Error(`smoke: the installer exited ${installed.status}`);
  if (upgradeFrom && existsSync(join(defaultDir, mainName))) throw new Error(`smoke: the installer made a second copy in ${defaultDir}`);
  const exe = join(installDir, mainName);
  for (const path of [exe, join(installDir, "app", "bundle.nshc"), join(installDir, "native", "real-bot-daemon.exe"), join(installDir, "uninstall.exe")]) {
    if (!existsSync(path)) throw new Error(`smoke: the install has no ${path}`);
  }
  if (uninstallValue("MainBinaryName") !== mainName) throw new Error(`smoke: the entry names ${uninstallValue("MainBinaryName")}, not ${mainName}`);
  checkIdentity(exe);
  // Over an earlier install too, whose program (0.5.0 and 0.5.1's) had no icon or version information.
  checkVersionInfo(exe, productVersion(repo));
  const shortcut = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Deskfolk.lnk");
  if (!existsSync(shortcut)) throw new Error(`smoke: no Start menu shortcut at ${shortcut}`);
  console.log(`smoke: installed ${uninstallValue("DisplayVersion")} as ${mainName}; the Start menu shortcut is there`);

  // The login launch: `--hidden`, as the `Run` value starts it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BUN_|NODE_OPTIONS|REAL_BOT_)/.test(k))) as Record<string, string>;
  const shell = Bun.spawn([exe, "--hidden"], { stdout: "pipe", stderr: "pipe", env });
  const log = drain(shell.stderr, true);
  if (!(await log.until(/ready: \d+ conversations/, 240_000))) {
    shell.kill();
    throw new Error("smoke: no first snapshot within 240 s");
  }
  const descriptor = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
  const daemon = windowsProcessPath(descriptor.pid);
  console.log(`smoke: the runtime is pid ${descriptor.pid}: ${daemon}`);
  if (daemon.toLowerCase() !== join(installDir, "native", "real-bot-daemon.exe").toLowerCase()) {
    throw new Error("smoke: the runtime is not the daemon the installer put in native\\");
  }
  if (windowsMainWindow(shell.pid) !== 0) throw new Error("smoke: --hidden showed the window");
  console.log("smoke: started hidden");
  // The runtime holds the remote setup channel (its stdin and stdout, `remote_setup.rs`), which
  // makes it window-supervised: pairing a phone from this computer works, and a phone can restart it.
  if (!windowsCommandLine(descriptor.pid).includes("--desktop-remote-channel")) {
    throw new Error("smoke: the runtime was started without the remote setup channel");
  }
  const supervised = await runtimeInfo(dataDir);
  if (supervised.mode !== "window" || supervised.restart !== "available") {
    throw new Error(`smoke: the runtime reports ${JSON.stringify(supervised)}, not a window-supervised one a phone can restart`);
  }
  console.log("smoke: the runtime has its setup channel and can be restarted from a phone");
  const expectedRun = `"${exe}" --hidden`;
  let run = "";
  for (let i = 0; i < 40 && run !== expectedRun; i++) {
    run = runValue();
    if (run !== expectedRun) await Bun.sleep(500);
  }
  if (run !== expectedRun) throw new Error(`smoke: launch at login reads ${JSON.stringify(run)}, not ${JSON.stringify(expectedRun)}`);
  console.log(`smoke: launch at login: ${run}`);

  // A second launch (the Start menu) shows the running copy's window and ends; the runtime stays.
  const second = Bun.spawn([exe], { stdout: "ignore", stderr: "ignore", env });
  const handedOver = await Promise.race([second.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!handedOver) {
    second.kill();
    throw new Error("smoke: a second launch did not hand itself to the running copy");
  }
  let shown = false;
  for (let i = 0; i < 40 && !shown; i++) {
    shown = windowsMainWindow(shell.pid) !== 0;
    if (!shown) await Bun.sleep(250);
  }
  if (!shown) throw new Error("smoke: the second launch did not show the running copy's window");
  await Bun.sleep(2000);
  if (!alive(descriptor.pid) || !(await healthyAt17890())) throw new Error("smoke: the second launch stopped the runtime");
  console.log("smoke: a second launch showed the window and left the runtime running");
  // The window `nsh_window()` finds is the app's, the one on screen, not the engine's unseen host.
  const shownWindows = windowsNshWindows(shell.pid);
  console.log(`smoke: NSH's windows, in the order nsh_window() meets them: ${JSON.stringify(shownWindows)}`);
  const appWindow = shownWindows[0];
  if (!appWindow?.visible) throw new Error("smoke: nsh_window() would find a window that is not the one on screen (the tray's Show would show the wrong one)");

  process.kill(descriptor.pid);
  let again = 0;
  for (let i = 0; i < 90 && !again; i++) {
    await Bun.sleep(500);
    try {
      const next = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
      if (next.pid !== descriptor.pid && (await healthyAt17890())) again = next.pid;
    } catch {
      // Not written yet.
    }
  }
  if (!again) throw new Error("smoke: the daemon was not started again after it died");
  console.log(`smoke: started again as pid ${again}`);
  if (!(await log.until(/reconnected/, 60_000))) throw new Error("smoke: the window did not reconnect to the daemon started again");
  console.log("smoke: the window reconnected");
  if (!windowsCommandLine(again).includes("--desktop-remote-channel") || (await runtimeInfo(dataDir)).mode !== "window") {
    throw new Error("smoke: the runtime started again has no setup channel");
  }
  console.log("smoke: the runtime started again has its setup channel");

  // Closing the window puts it away, as 0.4.0's did: the app stays in the notification area, the
  // runtime with it.
  windowsPressClose(shell.pid);
  await Bun.sleep(3000);
  if (!alive(shell.pid)) throw new Error("smoke: closing the window ended the app; it should stay in the notification area");
  if (windowsMainWindow(shell.pid) !== 0) throw new Error("smoke: the window still shows after its close button");
  if (!alive(again) || !(await healthyAt17890())) throw new Error("smoke: closing the window stopped the runtime");
  console.log("smoke: closing the window put it away; the runtime runs on");
  // Put away, it is still the one `nsh_window()` finds: the one the tray's Show brings back.
  const awayWindows = windowsNshWindows(shell.pid);
  console.log(`smoke: NSH's windows with the window put away: ${JSON.stringify(awayWindows)}`);
  if (awayWindows[0]?.hwnd !== appWindow.hwnd) throw new Error("smoke: with the window put away, nsh_window() would find another window (the tray's Show would show the wrong one)");

  // `--quit` asks the running copy to quit, as the tray's Quit does: the run ends, and the daemon
  // with it.
  const quit = Bun.spawn([exe, "--quit"], { stdout: "ignore", stderr: "ignore", env });
  await Promise.race([quit.exited, Bun.sleep(30_000)]);
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!exited) {
    shell.kill();
    throw new Error("smoke: --quit did not end the running copy");
  }
  for (let i = 0; i < 20 && alive(again); i++) await Bun.sleep(500);
  if (alive(again)) throw new Error(`smoke: the daemon (pid ${again}) outlived the app`);
  console.log("smoke: --quit ended the app and stopped the daemon");

  // An app that is ended outright (a crash, Task Manager) takes its runtime with it: the daemon is
  // in a job that ends with the app (`runtime.rs`), and the pty helper it started with it.
  const crashed = Bun.spawn([exe, "--hidden"], { stdout: "pipe", stderr: "pipe", env });
  if (!(await drain(crashed.stderr, true).until(/ready: \d+ conversations/, 240_000))) {
    crashed.kill();
    throw new Error("smoke: no first snapshot on the start after --quit");
  }
  const third = (JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number }).pid;
  spawnSync("taskkill", ["/F", "/PID", String(crashed.pid)]);
  await crashed.exited;
  for (let i = 0; i < 20 && alive(third); i++) await Bun.sleep(500);
  if (alive(third)) throw new Error(`smoke: the daemon (pid ${third}) outlived an app that was ended outright`);
  const ptys = windowsPids("real-bot-pty.exe");
  if (ptys.length > 0) throw new Error(`smoke: pty helpers ${ptys.join(", ")} outlived the app`);
  console.log("smoke: an app ended outright took its runtime with it");

  const removed = spawnSync(join(installDir, "uninstall.exe"), ["/S", `_?=${installDir}`], { encoding: "utf8" });
  if (removed.status !== 0) throw new Error(`smoke: the uninstaller exited ${removed.status}`);
  if (existsSync(exe) || existsSync(join(installDir, "native"))) throw new Error("smoke: the uninstaller left the program behind");
  const gone = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deskfolk"]);
  if (gone.status === 0) throw new Error("smoke: the uninstall entry is still there");
  if (runValue()) throw new Error("smoke: the uninstaller left launch at login behind");
  if (!existsSync(join(dataDir, "local-api.json")) && !existsSync(dataDir)) throw new Error("smoke: the uninstaller took the data folder");
  console.log("smoke: uninstalled; the data folder stays");
}

/** Pids whose command line starts with the shell's path (`pkill -x` stops at 15 characters, the name is 16). */
function shellPids(): number[] {
  const found = spawnSync("pgrep", ["-f", "^([^ ]*/)?real-bot-desktop( |$)"], { encoding: "utf8" });
  return found.stdout.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function helperPids(name: string): number[] {
  return spawnSync("pgrep", ["-x", name], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Runs `command` as root (the runner's user is not; apt and dpkg need it). */
function asRoot(command: string, args: string[]): string {
  return process.getuid?.() === 0 ? run(command, args) : run("sudo", [command, ...args]);
}

function linuxCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return "";
  }
}

function linuxExe(pid: number): string {
  return spawnSync("readlink", ["-f", `/proc/${pid}/exe`], { encoding: "utf8" }).stdout.trim();
}

/**
 * Linux, on a machine where no runtime answers yet (a CI runner, under `dbus-run-session -- xvfb-run
 * -a`): an earlier deb installed and started, then the new deb installed over the running copy; the
 * installed files; the app started hidden with its own daemon and its remote setup channel; a second
 * launch that hands itself over; the daemon killed and started again; `--quit` ending app and daemon;
 * the package removed with the data directory left; then the AppImage started and quit.
 */
async function smokeLinux(deb: string, appImage: string, upgradeFrom?: string) {
  if (await healthyAt17890()) throw new Error("--smoke needs a machine where nothing answers on 17890");
  const dataDir = join(process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share"), "real-bot");
  const exe = `/usr/lib/Deskfolk/${LINUX_MAIN}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BUN_|NODE_OPTIONS|REAL_BOT_)/.test(k))) as Record<string, string>;
  const gone = (pid: number) => !alive(pid);

  // An earlier deb (0.4.0's, the Tauri app) running: the upgrade has to stop it first (`preinst`).
  let earlier: ReturnType<typeof Bun.spawn> | undefined;
  if (upgradeFrom) {
    asRoot("apt-get", ["install", "-y", resolve(upgradeFrom)]);
    earlier = Bun.spawn([LINUX_MAIN, "--hidden"], { stdout: "ignore", stderr: "ignore", env });
    await Bun.sleep(8000);
    console.log(`smoke: ${upgradeFrom} installed and started (pid ${earlier.pid}${alive(earlier.pid) ? "" : ", already gone"})`);
  }
  const running = [...shellPids(), ...["real-bot-daemon", "real-bot-pty", "real-bot-rtc"].flatMap(helperPids)];
  asRoot("apt-get", ["install", "-y", resolve(deb)]);
  if (running.some((pid) => alive(pid))) {
    // A zombie the test itself has not reaped does not count: it holds no file.
    const left = running.filter((pid) => alive(pid) && !/^Z/.test(spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()));
    if (left.length) throw new Error(`smoke: the upgrade left ${left.join(", ")} of the earlier copy running`);
  }
  if (running.length) console.log(`smoke: the upgrade stopped the running copy (${running.join(", ")})`);

  const version = debianVersion(productVersion(repo));
  const status = run("dpkg", ["-s", "deskfolk"]);
  if (!status.includes(`Version: ${version}`)) throw new Error(`smoke: dpkg reports another version than ${version}:\n${status}`);
  if (existsSync("/usr/share/applications/Deskfolk.desktop")) throw new Error("smoke: the Tauri app's Deskfolk.desktop is still there");
  for (const path of [`/usr/share/applications/${LINUX_DESKTOP_ENTRY}`, `/usr/share/polkit-1/actions/${LINUX_POLICY}`, "/usr/lib/Deskfolk/app/bundle.nshc", "/usr/bin/real-bot-desktop"]) {
    if (!existsSync(path)) throw new Error(`smoke: the install has no ${path}`);
  }
  for (const name of [LINUX_MAIN, ...LINUX_NATIVE.map((n) => `native/${n}`)]) {
    const path = `/usr/lib/Deskfolk/${name}`;
    if (!existsSync(path) || (spawnSync("test", ["-x", path]).status !== 0)) throw new Error(`smoke: ${path} is missing or not executable`);
  }
  checkIdentity(exe);
  console.log(`smoke: installed ${version}; the entry, the policy and the program are there`);

  // The login launch: `--hidden`.
  const shell = Bun.spawn([exe, "--hidden"], { stdout: "pipe", stderr: "pipe", env });
  const log = drain(shell.stderr, true);
  if (!(await log.until(/ready: \d+ conversations/, 240_000))) {
    shell.kill();
    throw new Error("smoke: no first snapshot within 240 s");
  }
  const descriptor = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
  console.log(`smoke: the runtime is pid ${descriptor.pid}: ${linuxExe(descriptor.pid)}`);
  if (linuxExe(descriptor.pid) !== "/usr/lib/Deskfolk/native/real-bot-daemon") throw new Error("smoke: the runtime is not the daemon the package put in native/");
  if (!linuxCommandLine(descriptor.pid).includes("--desktop-remote-channel")) throw new Error("smoke: the runtime was started without the remote setup channel");
  const supervised = await runtimeInfo(dataDir);
  if (supervised.mode !== "window" || supervised.restart !== "available") {
    throw new Error(`smoke: the runtime reports ${JSON.stringify(supervised)}, not a window-supervised one a phone can restart`);
  }
  console.log("smoke: the runtime has its setup channel and can be restarted from a phone");

  // A second launch (the launcher) hands itself to the running copy and ends; the runtime stays.
  const second = Bun.spawn([exe], { stdout: "ignore", stderr: "ignore", env });
  const handedOver = await Promise.race([second.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!handedOver) {
    second.kill();
    throw new Error("smoke: a second launch did not hand itself to the running copy");
  }
  await Bun.sleep(2000);
  if (!alive(descriptor.pid) || !(await healthyAt17890())) throw new Error("smoke: the second launch stopped the runtime");
  console.log("smoke: a second launch handed over and left the runtime running");

  process.kill(descriptor.pid, "SIGKILL");
  let again = 0;
  for (let i = 0; i < 90 && !again; i++) {
    await Bun.sleep(500);
    try {
      const next = JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number };
      if (next.pid !== descriptor.pid && (await healthyAt17890())) again = next.pid;
    } catch {
      // Not written yet.
    }
  }
  if (!again) throw new Error("smoke: the daemon was not started again after it died");
  console.log(`smoke: started again as pid ${again}`);
  if (!(await log.until(/reconnected/, 60_000))) throw new Error("smoke: the window did not reconnect to the daemon started again");
  console.log("smoke: the window reconnected");

  const quit = Bun.spawn([exe, "--quit"], { stdout: "ignore", stderr: "ignore", env });
  await Promise.race([quit.exited, Bun.sleep(30_000)]);
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!exited) {
    shell.kill();
    throw new Error("smoke: --quit did not end the running copy");
  }
  for (let i = 0; i < 20 && !gone(again); i++) await Bun.sleep(500);
  if (!gone(again)) throw new Error(`smoke: the daemon (pid ${again}) outlived the app`);
  console.log("smoke: --quit ended the app and stopped the daemon");

  asRoot("apt-get", ["remove", "-y", "deskfolk"]);
  if (existsSync(exe) || existsSync(`/usr/share/applications/${LINUX_DESKTOP_ENTRY}`)) throw new Error("smoke: the removal left the program behind");
  if (!existsSync(dataDir)) throw new Error("smoke: the removal took the data directory");
  console.log("smoke: removed; the data directory stays");

  // The AppImage, extracted and run (no FUSE on a runner).
  chmodSync(appImage, 0o755);
  const image = Bun.spawn([appImage, "--appimage-extract-and-run", "--hidden"], { stdout: "pipe", stderr: "pipe", env });
  const imageLog = drain(image.stderr, true);
  if (!(await imageLog.until(/ready: \d+ conversations/, 240_000))) {
    image.kill();
    throw new Error("smoke: the AppImage reached no first snapshot within 240 s");
  }
  const imageDaemon = (JSON.parse(readFileSync(join(dataDir, "local-api.json"), "utf8")) as { pid: number }).pid;
  const imageQuit = Bun.spawn([appImage, "--appimage-extract-and-run", "--quit"], { stdout: "ignore", stderr: "ignore", env });
  await Promise.race([imageQuit.exited, Bun.sleep(30_000)]);
  if (!(await Promise.race([image.exited.then(() => true), Bun.sleep(30_000).then(() => false)]))) {
    image.kill();
    throw new Error("smoke: --quit did not end the AppImage");
  }
  for (let i = 0; i < 20 && !gone(imageDaemon); i++) await Bun.sleep(500);
  if (!gone(imageDaemon)) throw new Error(`smoke: the AppImage's daemon (pid ${imageDaemon}) outlived it`);
  console.log("smoke: the AppImage ran and quit");
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
  if (release && process.platform === "win32") {
    const mode = windowsPackageMode(process.argv);
    const out = resolve(arg("--out") ?? join(root, "build", "release-windows"));
    const earlier = process.argv.flatMap((a, i) => (a === "--upgrade-from" && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
    if (mode.kind === "stage-only") {
      stageReleaseWindows(out);
    } else if (mode.kind === "smoke-only") {
      const setup = resolve(mode.setupPath);
      if (!existsSync(setup)) throw new Error(`--smoke-only: ${setup} does not exist`);
      for (const from of earlier.length ? earlier : [undefined]) await smokeWindows(setup, from);
    } else {
      const { setup } =
        mode.kind === "from-stage"
          ? packWindowsInstaller(resolve(mode.stageDir), out)
          : packageReleaseWindows(out);
      if (process.argv.includes("--smoke")) {
        // Once over each earlier installer named (the latest release's, the last Tauri app's), or
        // once on a machine with none.
        for (const from of earlier.length ? earlier : [undefined]) await smokeWindows(setup, from);
      }
    }
  } else if (release && process.platform === "linux") {
    const { deb, appImage } = packageReleaseLinux();
    if (process.argv.includes("--smoke")) {
      // Once over each earlier deb named (0.4.0's, the last Tauri app), or once on a machine with none.
      const earlier = process.argv.flatMap((a, i) => (a === "--upgrade-from" && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
      if (earlier.length > 1) throw new Error("--upgrade-from: one deb on Linux (the smoke removes the package at its end)");
      await smokeLinux(deb, appImage, earlier[0]);
    }
  } else {
    const { app } = release ? packageRelease() : packageDev();
    if (release && process.argv.includes("--smoke")) await smoke(app);
    const runs = Number(arg("--measure") ?? 0);
    if (runs > 0) await measure(app, runs);
  }
}
