/**
 * The desktop shell end to end, on whatever OS this runs: the dev runtime (its own port and data
 * directory), the shell with the built bundle, and the app's first snapshot from that runtime
 * ("ready:" on the shell's log) — a window opened, its TSX ran, and it reached the runtime.
 * Stops what it started, and only that. CI runs it on Windows and Linux (under Xvfb); it runs on a
 * Mac beside the stable app too.
 *
 *   bun apps/desktop-nsh/scripts/ci-smoke.ts <shell executable> <bundle.js> [--timeout <s>]
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { LOCAL_API_NAME } from "../../../packages/protocol/src/index.ts";
import { assertApartFromStable, DEV_ORIGIN, devInstance } from "./dev-instance";

const [shellPath, bundlePath] = process.argv.slice(2);
if (!shellPath || !bundlePath) {
  console.error("usage: ci-smoke.ts <shell executable> <bundle.js> [--timeout <s>]");
  process.exit(2);
}
const at = process.argv.indexOf("--timeout");
const timeout = (at >= 0 ? Number(process.argv[at + 1]) : 120) * 1000;
const root = resolve(import.meta.dir, "..");
const instance = devInstance();
assertApartFromStable(instance);

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_ORIGIN}/v1/health`, { signal: AbortSignal.timeout(500) });
    const body = (await res.json()) as { ok?: unknown; name?: unknown };
    return body.ok === true && body.name === LOCAL_API_NAME;
  } catch {
    return false;
  }
}

const started: ReturnType<typeof spawn>[] = [];
const stopAll = () => {
  for (const child of started.reverse()) if (child.exitCode === null) child.kill("SIGTERM");
};

let runtimeUp = await healthy();
if (!runtimeUp) {
  const runtime = spawn(process.execPath, [join(root, "scripts", "dev-runtime.ts")], { stdio: "inherit", env: { ...process.env, FORCE_COLOR: "" } });
  started.push(runtime);
  for (let i = 0; i < 120 && !(runtimeUp = await healthy()); i++) await Bun.sleep(500);
}
if (!runtimeUp) {
  console.error("smoke: the dev runtime did not come up");
  stopAll();
  process.exit(1);
}

// On a Mac the window stays beside the person's own work (no activation, out of Stage Manager).
const shellArgs = ["--bundle", resolve(bundlePath), "--data-dir", instance.dataDir, ...(process.platform === "darwin" ? ["--background"] : [])];
const shell = spawn(resolve(shellPath), shellArgs, { stdio: ["ignore", "pipe", "pipe"] });
started.push(shell);
let log = "";
const ready = new Promise<boolean>((done) => {
  const take = (chunk: Buffer) => {
    const text = chunk.toString();
    log += text;
    process.stderr.write(text);
    if (/ready: \d+ conversations/.test(log)) done(true);
  };
  shell.stdout!.on("data", take);
  shell.stderr!.on("data", take);
  shell.on("exit", () => done(false));
  setTimeout(() => done(false), timeout);
});
const ok = await ready;
console.log(ok ? "smoke: the shell opened, ran the app and reached the dev runtime" : "smoke: no first snapshot from the shell");
stopAll();
await Bun.sleep(500);
process.exit(ok ? 0 : 1);
