import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import { defaultDataDir } from "./descriptor";
import { startRuntime } from "./runtime";
import { bunKeyStore } from "./secrets";

const dataDir = process.env.REAL_BOT_DATA_DIR ?? defaultDataDir();

const already = await probeHealth();
if (already === "ours") {
  console.log(`${LOCAL_API_NAME} already listening on http://${LOCAL_API_BIND}`);
  process.exit(0);
}
if (already === "other") {
  console.error(`${LOCAL_API_NAME} refused ${LOCAL_API_BIND}: port is taken`);
  process.exit(1);
}

const runtime = await startRuntime({
  dataDir,
  bind: LOCAL_API_BIND,
  endpointKey: bunKeyStore,
  exitProcess: true,
});

console.log(`${LOCAL_API_NAME} daemon listening on ${runtime.origin}`);

process.on("SIGINT", () => {
  void runtime.stop();
});
process.on("SIGTERM", () => {
  void runtime.stop();
});

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