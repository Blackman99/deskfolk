/**
 * The NSH dev build's runtime: the real daemon from source, on the dev instance's port, data
 * directory and Keychain service (dev-instance.ts), so the installed stable Deskfolk runs beside it
 * untouched. No login item, no launchd agent, no keep-awake; the scheduler is off unless asked for,
 * so the two instances' Bots are not woken twice.
 *
 *   bun apps/desktop-nsh/scripts/dev-runtime.ts [--schedule] [--seed-from-stable]
 *   bun apps/desktop-nsh/scripts/dev-runtime.ts --stable-instance
 *
 * `--seed-from-stable` starts an empty dev data directory from a snapshot of the stable database
 * (SQLite `VACUUM INTO` through a read-only connection; the stable file is never written). Its Bots
 * still point at your real workspaces.
 *
 * `--stable-instance` runs it on the stable instance instead, in place of the installed app's
 * runtime: 17890, your own data directory and Keychain service, the scheduler and keep-awake on, and
 * remote access on the identity your phones are paired with (the data directory's
 * `dev-remote/credentials.json`, which a source runtime loads only with `REAL_BOT_DEV_REMOTE=1`;
 * pairing and removing a device are then confirmed in the settings panel rather than by Touch ID).
 * It refuses while the installed app's runtime holds the directory.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_API_NAME } from "../../../packages/protocol/src/index.ts";
import { pidAlive, readDescriptor } from "../../daemon/src/descriptor";
import { startRuntime } from "../../daemon/src/runtime";
import { bundledKeyStore, bunKeyStore, bunSecretBackend } from "../../daemon/src/secrets";
import { systemLanguage } from "../../daemon/src/system-language";
import {
  assertApartFromStable,
  chosenInstance,
  installedRuntime,
  originOf,
  sharedRemoteHost,
  STABLE_INSTANCE_FLAG,
  stableDataDir,
} from "./dev-instance";

const stable = process.argv.includes(STABLE_INSTANCE_FLAG);
const instance = chosenInstance();
if (!stable) assertApartFromStable(instance);
const origin = originOf(instance);

// The default Claude account is the one the app finds opened from Finder (`~/.claude`), not the one
// of whoever started this: a Bot's Claude Code runs with its own account's `CLAUDE_CONFIG_DIR`, and a
// dev runtime it started took that account for the default, listing it twice beside the same account
// added by hand. Other accounts are listed in Settings, as in the installed app.
if (process.env.CLAUDE_CONFIG_DIR) {
  console.warn(`not taking CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR} as the default Claude account; it stays ~/.claude`);
  delete process.env.CLAUDE_CONFIG_DIR;
}

const schedule = stable || process.argv.includes("--schedule");
const seed = process.argv.includes("--seed-from-stable");
if (stable && seed) {
  console.error(`${STABLE_INSTANCE_FLAG} runs on the stable data itself; there is nothing to seed`);
  process.exit(1);
}

const installed = stable ? installedRuntime(instance.dataDir) : undefined;
if (installed) {
  console.error(`the installed Deskfolk's runtime (pid ${installed.pid}) holds ${instance.dataDir}; quit Deskfolk first`);
  process.exit(1);
}
const already = await probe(origin);
if (already === "ours") {
  console.log(`${stable ? "stable-instance" : "dev"} runtime already listening on ${origin}`);
  process.exit(0);
}
if (already === "other") {
  console.error(`refused ${instance.bind}: the port is taken by something else; not connecting to it`);
  process.exit(1);
}
if (!stable && process.env.REAL_BOT_DEV_REMOTE) {
  const shared = sharedRemoteHost(instance.dataDir, stableDataDir());
  if (shared) {
    console.warn(`remote stays off: this dev database carries the stable instance's relay registration (host ${shared}), not its keys`);
    delete process.env.REAL_BOT_DEV_REMOTE;
  }
}
if (stable) {
  const holder = readDescriptor(instance.dataDir);
  if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) {
    console.error(`pid ${holder.pid} still holds ${instance.dataDir} without answering on ${origin}; not starting a second runtime`);
    process.exit(1);
  }
  // Your phones' pairing lives in this directory; a source runtime opens it only with the switch.
  process.env.REAL_BOT_DEV_REMOTE = "1";
}

mkdirSync(instance.dataDir, { recursive: true, mode: 0o700 });
const database = join(instance.dataDir, "state.sqlite");
if (seed) {
  if (existsSync(database)) {
    console.error(`--seed-from-stable: ${database} already exists; remove the dev data directory to seed again`);
    process.exit(1);
  }
  const source = new Database(join(stableDataDir(), "state.sqlite"), { readonly: true });
  try {
    source.run("VACUUM INTO ?", [database]);
  } finally {
    source.close();
  }
  console.warn("seeded from the stable database; its Bots still point at your real workspaces");
}

const runtime = await startRuntime({
  dataDir: instance.dataDir,
  bind: instance.bind,
  // The stable instance reads its keys the way the installed app's runtime does.
  endpointKey: stable ? bunKeyStore : bundledKeyStore(bunSecretBackend(instance.keychainService)),
  exitProcess: true,
  keepAwake: stable,
  schedule,
  systemLanguage,
  supervisor: "none",
});

// Read once, at boot; the Bots' commands (tests that start runtimes of their own) must not inherit it.
if (stable) delete process.env.REAL_BOT_DEV_REMOTE;
console.log(
  `${stable ? "stable-instance" : "dev"} runtime listening on ${runtime.origin} (data ${instance.dataDir}, scheduler ${schedule ? "on" : "off"}${stable ? ", remote on" : ""})`,
);
if (!stable) await ensureWorkspace();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runtime.stop();
  });
}

/**
 * A fresh dev instance gets a workspace of its own inside its data directory, so terminals and
 * Bots have somewhere to work that is not your real workspace.
 */
async function ensureWorkspace(): Promise<void> {
  const { token } = JSON.parse(readFileSync(join(instance.dataDir, "local-api.json"), "utf8")) as { token: string };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const settings = (await (await fetch(`${runtime.origin}/v1/settings`, { headers })).json()) as { workspace_path?: string | null };
  if (settings.workspace_path) return;
  const workspace = join(instance.dataDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const res = await fetch(`${runtime.origin}/v1/settings`, { method: "PATCH", headers, body: JSON.stringify({ workspace_path: workspace }) });
  console.log(res.ok ? `dev workspace ${workspace}` : `could not set the dev workspace: ${res.status}`);
}

async function probe(origin: string): Promise<"ours" | "other" | "free"> {
  try {
    const res = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(400) });
    const body = (await res.json()) as { ok?: unknown; name?: unknown };
    return body.ok === true && body.name === LOCAL_API_NAME ? "ours" : "other";
  } catch {
    return "free";
  }
}
