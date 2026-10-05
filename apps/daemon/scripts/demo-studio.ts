/**
 * An empty, isolated daemon for filming the promo: its own data dir and port, an in-memory
 * keystore (never the macOS Keychain), and nothing seeded, so the film can start from the first-run
 * wizard. The scheduler runs: from engine level 4 the supervisor, a hand-over waiting for the next
 * tick and a media job the daemon polls all run in its tick, and the demo has no routines for it
 * to fire. Its model endpoint and MCP server are scripts/demo-tape.ts,
 * which the wizard and the film's director point it at.
 *
 * Start it with HOME set to a throwaway home (the orchestrator does): shells and terminals the
 * daemon opens inherit it, so the recording shows that home's clean prompt instead of yours, and
 * the wizard's recommended folder (~/deskfolk-workspace) lands inside it.
 *
 *   HOME=/tmp/demo/home REAL_BOT_DATA_DIR=/tmp/demo/data bun apps/daemon/scripts/demo-studio.ts
 *
 * Env: REAL_BOT_DATA_DIR (required), REAL_BOT_DEMO_BIND (default 127.0.0.1:17957),
 * REAL_BOT_DEMO_CURLRC=1 writes a ~/.curlrc sending curl to demo-tape's media server (replay),
 * REAL_BOT_DEMO_CONTROL (default 127.0.0.1:17958) where demo-tape asks for a render's poll now.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/runtime";
import { memoryKeyStore } from "../src/secrets";

const dataDir = process.env.REAL_BOT_DATA_DIR;
if (!dataDir) {
  console.error("set REAL_BOT_DATA_DIR to a throwaway directory");
  process.exit(1);
}
const home = homedir();
if (home === process.env.REAL_BOT_REAL_HOME) {
  console.error("HOME is your own home; start the studio with HOME set to a throwaway directory");
  process.exit(1);
}
const bind = process.env.REAL_BOT_DEMO_BIND ?? "127.0.0.1:17957";

mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, ".zshrc"),
  ["PROMPT='%F{cyan}%~%f %F{magenta}❯%f '", "RPROMPT=''", "unsetopt BEEP", "export LANG=en_US.UTF-8", ""].join("\n"),
);
writeFileSync(join(home, ".zprofile"), "");
// Long listings name the file owner, which is you: show the numeric id instead. The orchestrator
// puts ~/bin first on the PATH the daemon's shells inherit.
mkdirSync(join(home, "bin"), { recursive: true });
writeFileSync(
  join(home, "bin", "ls"),
  ['#!/bin/sh', 'for a in "$@"; do case "$a" in -*l*) exec /bin/ls -n "$@";; esac; done', 'exec /bin/ls "$@"', ""].join("\n"),
  { mode: 0o755 },
);
if (process.env.REAL_BOT_DEMO_CURLRC === "1") {
  // Quoted: curl 8 reads the leading colons of an unquoted "::host:port" as the separator, and
  // the rule it is left with sends nothing to the tape.
  writeFileSync(join(home, ".curlrc"), ['connect-to = "::127.0.0.1:8443"', "insecure", ""].join("\n"));
}

const handle = await startRuntime({ dataDir, bind, endpointKey: memoryKeyStore(), supervisor: "none" });
console.log(`demo daemon on ${handle.origin} (data ${dataDir}, home ${home})`);

// A replay hands a render's end out where the shoot heard it (demo-tape-order.ts), and asks for the
// poll then instead of waiting out the backoff the shoot's own clock set: due at the next tick.
const [controlHost, controlPort] = (process.env.REAL_BOT_DEMO_CONTROL ?? "127.0.0.1:17958").split(":");
const control = Bun.serve({
  hostname: controlHost,
  port: Number(controlPort),
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/poll-now") return new Response("not found", { status: 404 });
    const { request_id } = (await req.json()) as { request_id?: unknown };
    const { changes } = handle.store.db.run(
      "UPDATE external_jobs SET next_poll_at = ? WHERE request_id = ? AND state = 'pending'",
      [new Date().toISOString(), String(request_id)],
    );
    return Response.json({ changed: changes });
  },
});

const stop = async () => {
  control.stop(true);
  await handle.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
