/**
 * Lets a data folder's engine level go up although an installed app that shares it predates the
 * version gate (ADR 0041). On a developer's own Mac the installed copy is often an older release,
 * and a source run then keeps holds, and every level after them, off in the one data folder that
 * developer actually works in. Accepting that means the installed app, opened without this daemon
 * running, would not honor a hold. Taking it back never lowers the level.
 *
 *   bun apps/daemon/scripts/engine-level.ts --accept-older-app [--data-dir <dir>]
 *   bun apps/daemon/scripts/engine-level.ts --clear [--data-dir <dir>]
 *
 * The data folder is `--data-dir`, else `REAL_BOT_DATA_DIR`, else the default one, as the daemon
 * picks it. When a daemon runs on it (its local-api.json names a live process), the script asks that
 * daemon (`POST` or `DELETE /v1/capabilities/raise`, with the token from local-api.json), which
 * raises at once. With none running, it writes the opt-in into the database itself, so the next
 * start raises. It never opens a `Store` for that: opening one migrates the database and marks the
 * run as a crash until it records a clean stop, which would make the next boot say it came back
 * from one. Either way it prints the capabilities as they then stand.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { CapabilitiesResponse, RaiseEngineLevelRequest } from "@real-bot/protocol";
import { defaultDataDir, pidAlive, readDescriptor, stateDbPath } from "../src/descriptor";
import { acceptOlderApp, capabilitiesOf, withdrawOlderAppOptIn } from "../src/store/schema-gate";

export const USAGE = "usage: bun apps/daemon/scripts/engine-level.ts (--accept-older-app | --clear) [--data-dir <dir>]";

export type EngineLevelArgs = { action: "accept" | "clear"; dataDir: string };

/** The action and the data folder, or why the arguments do not make one. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): EngineLevelArgs | { error: string } {
  const accept = argv.includes("--accept-older-app");
  const clear = argv.includes("--clear");
  if (accept === clear) return { error: USAGE };
  const at = argv.indexOf("--data-dir");
  const named = at === -1 ? undefined : argv[at + 1];
  if (at !== -1 && (!named || named.startsWith("--"))) return { error: USAGE };
  const known = new Set(["--accept-older-app", "--clear", "--data-dir"]);
  const stray = argv.find((arg, index) => !known.has(arg) && !(at !== -1 && index === at + 1));
  if (stray !== undefined) return { error: `unknown argument ${stray}\n${USAGE}` };
  return { action: accept ? "accept" : "clear", dataDir: named ?? env.REAL_BOT_DATA_DIR ?? defaultDataDir() };
}

type Io = { env: Record<string, string | undefined>; print: (line: string) => void; error: (line: string) => void };

/** Runs the script; resolves to its exit code (2: nothing to act on, 1: the running daemon said no or did not answer). */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const args = parseArgs(argv, io.env);
  if ("error" in args) {
    io.error(args.error);
    return 2;
  }
  const holder = readDescriptor(args.dataDir);
  if (holder && pidAlive(holder.pid)) return askDaemon(args, holder, io);
  return writeOptIn(args, io);
}

async function askDaemon(args: EngineLevelArgs, holder: { pid: number; port: number; token: string }, io: Io): Promise<number> {
  const body: RaiseEngineLevelRequest = { accept_older_app: true, by: "script" };
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${holder.port}/v1/capabilities/raise`, {
      method: args.action === "accept" ? "POST" : "DELETE",
      headers: { Authorization: `Bearer ${holder.token}`, "Content-Type": "application/json" },
      body: args.action === "accept" ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // A live process holds this data folder: writing its database from here instead could collide
    // with its own writes, so this stops rather than going round it.
    io.error(`the daemon on ${args.dataDir} (pid ${holder.pid}) did not answer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const text = await response.text();
  if (!response.ok) {
    // An installed app's own daemon from before this route answers 404: it has no opt-in to set.
    io.error(`the daemon on ${args.dataDir} (pid ${holder.pid}) answered ${response.status}: ${text}`);
    return 1;
  }
  io.print(
    args.action === "accept"
      ? `the daemon on ${args.dataDir} (pid ${holder.pid}) accepted an older installed app and raised the engine level now`
      : `the daemon on ${args.dataDir} (pid ${holder.pid}) took the opt-in back; the engine level stays where it is`,
  );
  io.print(JSON.stringify(JSON.parse(text) as CapabilitiesResponse, null, 2));
  return 0;
}

function writeOptIn(args: EngineLevelArgs, io: Io): number {
  const file = stateDbPath(args.dataDir);
  if (!existsSync(file)) {
    io.error(`no database at ${file}: start the app once, or pass --data-dir`);
    return 2;
  }
  const db = new Database(file, { strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) {
      io.error(`${file} has no settings yet: start the app once first`);
      return 2;
    }
    if (args.action === "accept") {
      acceptOlderApp(db, "script");
      io.print(`no daemon runs on ${args.dataDir}: wrote the opt-in, and the next start raises the engine level past an older installed app`);
    } else {
      withdrawOlderAppOptIn(db);
      io.print(`no daemon runs on ${args.dataDir}: took the opt-in back; the engine level stays where it is`);
    }
    io.print(JSON.stringify(capabilitiesOf(db), null, 2));
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2), { env: process.env, print: console.log, error: console.error }));
}
