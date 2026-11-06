/**
 * One command for the NSH dev build, beside the installed stable Deskfolk:
 *
 *   bun apps/desktop-nsh/scripts/dev.ts [--schedule] [--seed-from-stable]
 *
 * 1. The dev runtime (dev-runtime.ts) on 17990 with its own data directory, unless one already
 *    answers there.
 * 2. The shell (`cargo build`), wrapped in `build/Deskfolk Dev.app` so it has a bundle identity of
 *    its own (`com.real-bot.desktop.nsh-dev`): Notification Center needs one, and the stable app's
 *    permissions and window state stay apart.
 * 3. The app (`nsh build`), built again on every save under `app/`; the shell reloads it.
 *    `DESKFOLK_STORY=<name>` builds `Story.tsx` instead and opens that one screen (stories/index.ts).
 *
 * Quitting the shell stops what this script started, and only that.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LOCAL_API_NAME } from "../../../packages/protocol/src/index.ts";
import { DEV_APP_NAME, DEV_BUNDLE_ID, DEV_ORIGIN, devInstance } from "./dev-instance";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");
const build = join(root, "build");
const story = process.env.DESKFOLK_STORY;
const appBuild = join(build, story ? "story" : "app");
const bundleApp = join(build, `${DEV_APP_NAME}.app`);
const executable = join(bundleApp, "Contents", "MacOS", "deskfolk-nsh");
const nsh = process.env.NSH ?? join(homedir(), ".local", "bin", "nsh");
const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", "cargo");
const instance = devInstance();
const children: ChildProcess[] = [];

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

async function runtimeUp(): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_ORIGIN}/v1/health`, { signal: AbortSignal.timeout(400) });
    const body = (await res.json()) as { ok?: unknown; name?: unknown };
    return body.ok === true && body.name === LOCAL_API_NAME;
  } catch {
    return false;
  }
}

function ptyHelper(): string | undefined {
  if (process.env.REAL_BOT_PTY_HELPER) return process.env.REAL_BOT_PTY_HELPER;
  for (const dir of [repo, join(homedir(), "my-projects", "real-bot")]) {
    for (const config of ["release", "debug"]) {
      for (const triple of ["", "arm64-apple-macosx"]) {
        const path = join(dir, "apps/runtime-helper/.build", triple, config, "real-bot-pty");
        if (existsSync(path)) return path;
      }
    }
  }
  return undefined;
}

async function startRuntime(): Promise<void> {
  if (await runtimeUp()) {
    console.log(`dev runtime already on ${DEV_ORIGIN}`);
    return;
  }
  const args = [join(root, "scripts", "dev-runtime.ts"), ...process.argv.slice(2)];
  const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "" };
  const helper = ptyHelper();
  if (helper) env.REAL_BOT_PTY_HELPER = helper;
  else console.warn("no real-bot-pty build found; terminals will not open (swift build in apps/runtime-helper)");
  const child = spawn(process.execPath, args, { cwd: repo, stdio: "inherit", env });
  children.push(child);
  for (let i = 0; i < 60 && !(await runtimeUp()); i++) await Bun.sleep(250);
  if (!(await runtimeUp())) throw new Error("the dev runtime did not come up");
}

function buildShell(): void {
  run(cargo, ["build", "-p", "deskfolk-nsh"], root);
  mkdirSync(dirname(executable), { recursive: true });
  copyFileSync(join(root, "target", "debug", "deskfolk-nsh"), executable);
  writeFileSync(join(bundleApp, "Contents", "Info.plist"), infoPlist());
  // Ad hoc, like `nsh package`: enough for this Mac's Notification Center.
  run("codesign", ["--force", "--sign", "-", bundleApp], root);
}

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
  <key>NSMicrophoneUsageDescription</key><string>Voice input records what you say for the speech service you chose.</string>
</dict>
</plist>
`;
}

function buildApp(): boolean {
  const result = spawnSync(nsh, ["build", story ? "Story.tsx" : "App.tsx", "--out", appBuild], { cwd: join(root, "app"), stdio: "inherit" });
  return result.status === 0;
}

function watchApp(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(join(root, "app"), { recursive: true }, (_event, file) => {
    if (!file || file.startsWith(".nsh") || file.startsWith("build") || !/\.(tsx?|json)$/.test(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      buildApp();
    }, 80);
  });
}

function stopAll(): void {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(code);
  });
}

await startRuntime();
buildShell();
if (!buildApp()) throw new Error("nsh build failed");
watchApp();
const shellArgs = ["--bundle", join(appBuild, "bundle.js"), "--data-dir", instance.dataDir, "--watch"];
if (process.env.DESKFOLK_BACKGROUND === "1") shellArgs.push("--background");
if (process.env.DESKFOLK_SNAPSHOTS) shellArgs.push("--snapshots", process.env.DESKFOLK_SNAPSHOTS);
if (process.env.DESKFOLK_OPEN_SESSION) shellArgs.push("--open-session", process.env.DESKFOLK_OPEN_SESSION);
if (process.env.DESKFOLK_PANE) shellArgs.push("--pane", process.env.DESKFOLK_PANE);
if (process.env.DESKFOLK_PDF) shellArgs.push("--pdf", process.env.DESKFOLK_PDF);
if (process.env.DESKFOLK_FPS === "1") shellArgs.push("--fps");
if (process.env.DESKFOLK_SCROLL_PROBE === "1") shellArgs.push("--scroll-probe");
if (process.env.DESKFOLK_TERMINAL) shellArgs.push("--terminal", process.env.DESKFOLK_TERMINAL);
if (story) shellArgs.push("--story", story);
const shell = spawn(process.env.DESKFOLK_SHELL ?? executable, shellArgs, {
  cwd: root,
  stdio: "inherit",
});
children.push(shell);
shell.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});
