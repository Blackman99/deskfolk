import { LOCAL_API_DISCOVERY_PATH } from "@real-bot/protocol/local-discovery";
import { join } from "node:path";
import { classifyMessengerDev, decideMessengerDev } from "../src/lib/dev-probe.ts";

const ORIGIN = "http://localhost:5173";
const PROBE_ORIGINS = [ORIGIN, "http://127.0.0.1:5173", "http://[::1]:5173"];

const probes = await Promise.all(PROBE_ORIGINS.map(probe));
const action = decideMessengerDev(probes);

if (action === "reuse") {
  console.log(`messenger already listening on ${ORIGIN}`);
  process.exit(0);
}
if (action === "refuse") {
  console.error(`messenger refused ${ORIGIN}: port is taken`);
  process.exit(1);
}

// `.bin/vite` is a shell shim (`vite.cmd` on win32) meant to be run by a shell; spawning vite's
// own JS entry with the current runtime instead needs no shell and works the same everywhere.
const vite = join(import.meta.dir, "../node_modules/vite/bin/vite.js");
const child = Bun.spawn([process.execPath, vite, "dev"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

process.exit(await child.exited);

async function probe(origin: string) {
  try {
    const res = await fetch(`${origin}${LOCAL_API_DISCOVERY_PATH}`, {
      signal: AbortSignal.timeout(400),
    });
    const body = await res.json().catch(() => null);
    return classifyMessengerDev(res.status, body);
  } catch {
    return classifyMessengerDev(null, null);
  }
}
