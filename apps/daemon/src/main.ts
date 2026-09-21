import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import { defaultDataDir, pidAlive, readDescriptor } from "./descriptor";
import { startRuntime } from "./runtime";
import { bunKeyStore } from "./secrets";
import { remoteNative } from "./remote-native";
import { describeError, logStartup, startupLogPath } from "./startup-log";

if (process.argv.includes("--remote-native-capability")) {
  console.log(JSON.stringify(await remoteNative.capability()));
  process.exit(0);
}

const dataDir = process.env.REAL_BOT_DATA_DIR ?? defaultDataDir();

const already = await probeHealth();
if (already === "ours") {
  console.log(`${LOCAL_API_NAME} already listening on http://${LOCAL_API_BIND}`);
  process.exit(0);
}
if (already === "other") {
  fatal(`refused ${LOCAL_API_BIND}: port is taken`);
}

const holder = readDescriptor(dataDir);
if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) {
  console.log(`${LOCAL_API_NAME} holder pid ${holder.pid} is still alive; not starting a second runtime`);
  logStartup(dataDir, `holder pid ${holder.pid} is still alive; not starting a second runtime`);
  process.exit(0);
}

const standalone = process.argv.includes("--standalone");
if (standalone && process.argv.includes("--desktop-remote-channel")) {
  console.error(`${LOCAL_API_NAME} refused mixed window and standalone supervision`);
  process.exit(1);
}

// Everything that can stop the daemon before it listens ends up here. Without this the window's
// "can't reach the runtime" is the only trace left of, say, a database the schema cannot open.
let runtime;
try {
  runtime = await startRuntime({
    dataDir,
    bind: LOCAL_API_BIND,
    endpointKey: bunKeyStore,
    exitProcess: true,
    desktopRemoteChannel: process.argv.includes("--desktop-remote-channel"),
    supervisor: standalone ? "standalone" : process.argv.includes("--desktop-remote-channel") ? "window" : "none",
  });
} catch (error) {
  // An explicitly stopped standalone runtime is not a startup failure; it stays stopped.
  if (standalone && error instanceof Error && error.message === "runtime is stopped") process.exit(0);
  fatal(`failed to start: ${describeError(error)}`);
}

console.log(`${LOCAL_API_NAME} daemon listening on ${runtime.origin}`);
logStartup(dataDir, `listening on ${runtime.origin}`);

process.on("SIGINT", () => {
  void runtime.stop();
});
process.on("SIGTERM", () => {
  void runtime.stop();
});

function fatal(line: string): never {
  console.error(`${LOCAL_API_NAME} ${line}`);
  logStartup(dataDir, line);
  console.error(`${LOCAL_API_NAME} see ${startupLogPath(dataDir)}`);
  process.exit(1);
}

async function probeHealth(): Promise<"ours" | "other" | "free"> {
  try {
    const res = await fetch(`http://${LOCAL_API_BIND}/v1/health`, {
      signal: AbortSignal.timeout(400),
    });
    const body = (await res.json()) as { ok?: unknown; name?: unknown };
    if (body.ok === true && body.name === LOCAL_API_NAME) return "ours";
    return "other";
  } catch {
    return "free";
  }
}