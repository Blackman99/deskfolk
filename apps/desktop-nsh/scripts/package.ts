/**
 * Packages the NSH dev build as `build/release/Deskfolk Dev.app` and a dmg, beside the installed
 * stable Deskfolk: its own bundle id, data directory and port (dev-instance.ts). It starts its own
 * dev runtime when none answers (the command is baked into the binary, as the Tauri shell's debug
 * build runs the daemon from source), so it runs on this Mac only.
 *
 *   bun apps/desktop-nsh/scripts/package.ts [--sign developer-id|adhoc] [--notarize <keychain profile>]
 *                                           [--measure <runs>]
 *
 * `--notarize` sends the dmg to Apple's notary service with `xcrun notarytool` and staples it.
 * `--measure` launches the packaged app that many times (in the background, never activated) and
 * prints the time from launch to its first snapshot and its memory footprint.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEV_APP_NAME, DEV_BUNDLE_ID } from "./dev-instance";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");
const out = join(root, "build", "release");
const app = join(out, `${DEV_APP_NAME}.app`);
const dmg = join(out, "Deskfolk-Dev.dmg");
const nsh = process.env.NSH ?? join(homedir(), ".local", "bin", "nsh");
const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", "cargo");
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const sign = arg("--sign") ?? "adhoc";
const notarize = arg("--notarize");
const measure = Number(arg("--measure") ?? 0);

function run(command: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function ptyHelper(): string {
  for (const dir of [repo, join(homedir(), "my-projects", "real-bot")]) {
    for (const path of ["apps/runtime-helper/.build/release/real-bot-pty", "apps/runtime-helper/.build/arm64-apple-macosx/debug/real-bot-pty"]) {
      if (existsSync(join(dir, path))) return join(dir, path);
    }
  }
  return "";
}

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
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${DEV_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${DEV_APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${DEV_APP_NAME}</string>
  <key>CFBundleExecutable</key><string>deskfolk-nsh</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
);

const identity = sign === "developer-id" ? "Developer ID Application" : "-";
const signArgs = ["--force", "--options", "runtime", "--sign", identity];
if (sign === "developer-id") signArgs.push("--timestamp");
run("codesign", [...signArgs, app]);
console.log(run("codesign", ["--verify", "--strict", "--verbose=2", app]).trim());
run("hdiutil", ["create", "-volname", DEV_APP_NAME, "-srcfolder", app, "-ov", "-format", "UDZO", dmg]);
if (sign === "developer-id") run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
if (notarize) {
  console.log(run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notarize, "--wait"]).trim());
  console.log(run("xcrun", ["stapler", "staple", dmg]).trim());
}
const gatekeeper = spawnSync("spctl", ["-a", "-vv", "-t", "exec", app], { encoding: "utf8" });
console.log(`gatekeeper: ${(gatekeeper.stdout + gatekeeper.stderr).trim().replace(/\n/g, " | ")}`);
const size = (path: string) => spawnSync("du", ["-sh", path], { encoding: "utf8" }).stdout.split("\t")[0];
console.log(`app ${size(app)}, dmg ${size(dmg)}`);

for (let i = 1; i <= measure; i++) {
  const started = performance.now();
  const shell = Bun.spawn([join(contents, "MacOS", "deskfolk-nsh"), "--background"], { stdout: "pipe", stderr: "pipe" });
  const reader = shell.stderr.getReader();
  let log = "";
  let ready = -1;
  while (ready < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    log += new TextDecoder().decode(value);
    if (log.includes("ready:")) ready = performance.now() - started;
  }
  await Bun.sleep(1500);
  const footprint = spawnSync("footprint", ["-p", String(shell.pid)], { encoding: "utf8" }).stdout;
  const mb = footprint.match(/phys_footprint:\s+([\d.]+ \w+)/)?.[1] ?? "?";
  console.log(`run ${i}: first snapshot ${ready.toFixed(0)} ms after launch, footprint ${mb}`);
  shell.kill("SIGTERM");
  await shell.exited;
}
