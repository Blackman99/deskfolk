import { createServer, type Server } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteController } from "./controller";
import { attachLocalSetup, dispatchLocalSetup } from "./local-setup";
import { DevRemoteNative } from "./dev-native";
import { deny } from "./trust";

/**
 * Dev-only replacement for the window's setup channel.
 *
 * The packaged window reaches the controller over an inherited socketpair that
 * the signed native helper authorizes, and `remote_local_setup` in the Tauri
 * side refuses a dev origin outright. During development there is no such
 * window, so `REAL_BOT_DEV_REMOTE=1` opens the same dispatcher on a 0600 unix
 * socket beside the database, plus two operations that stand in for the Touch
 * ID sheet. A compiled daemon never takes this path.
 */
export const DEV_REMOTE_DIR = "dev-remote";
export const DEV_REMOTE_SOCKET = "setup.sock";
/** macOS caps sun_path at 104 bytes; fail loudly rather than binding a truncated path. */
const PATH_LIMIT = 100;

export type DevRemoteRequest = { operation: "dev_describe"; challenge: string } | { operation: "dev_authenticate"; challenge: string };

export function devRemoteRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REAL_BOT_DEV_REMOTE === "1";
}
/** A compiled daemon runs its modules out of /$bunfs/; that build must only ever see the sealed provider. */
export function devRemoteAllowed(modulePath: string = import.meta.path, env: NodeJS.ProcessEnv = process.env): boolean {
  return devRemoteRequested(env) && !modulePath.startsWith("/$bunfs/");
}

export function devSocketPath(dataDir: string): string {
  const natural = join(dataDir, DEV_REMOTE_DIR, DEV_REMOTE_SOCKET);
  if (Buffer.byteLength(natural) <= PATH_LIMIT) return natural;
  // A long data directory must not stop the daemon booting: fall back to a
  // stable short path both sides can derive.
  const digest = createHash("sha256").update(dataDir).digest("hex").slice(0, 8);
  const short = join(tmpdir(), `real-bot-dev-remote-${digest}.sock`);
  if (Buffer.byteLength(short) > PATH_LIMIT) throw new Error("dev remote socket path too long");
  return short;
}

export function devDispatch(native: DevRemoteNative): (controller: RemoteController, input: unknown) => Promise<unknown> {
  return async (controller, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) deny();
    const value = input as DevRemoteRequest;
    if (value.operation !== "dev_describe" && value.operation !== "dev_authenticate") {
      return dispatchLocalSetup(controller, input);
    }
    if (Object.keys(value).sort().join() !== "challenge,operation" || typeof value.challenge !== "string") deny();
    if (value.operation === "dev_describe") {
      const display = native.describe(value.challenge);
      if (display === undefined) deny();
      return { display };
    }
    return { proof: native.authenticate(value.challenge) };
  };
}

/**
 * What the settings panel is allowed to drive in development. Pairing needs a person at the Mac
 * either way; changing the relay or resetting the identity stays on the unix socket, where it
 * takes the CLI and the prompt that goes with it.
 */
const PAIRING_OPS = new Set(["status", "open_pair", "prepare_pair", "confirm_pair", "dev_describe", "dev_authenticate"]);

export function devPairingDispatch(native: DevRemoteNative): (controller: RemoteController, input: unknown) => Promise<unknown> {
  const full = devDispatch(native);
  return async (controller, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) deny();
    const operation = (input as { operation?: unknown }).operation;
    if (typeof operation !== "string" || !PAIRING_OPS.has(operation)) deny();
    return full(controller, input);
  };
}

export type DevRemote = { native: DevRemoteNative; path: string; listen(controller: RemoteController): () => void };

/** Returns undefined unless this is a source-run daemon with the dev switch on. */
export function createDevRemote(dataDir: string, modulePath: string = import.meta.path): DevRemote | undefined {
  if (!devRemoteAllowed(modulePath)) return;
  const directory = join(dataDir, DEV_REMOTE_DIR), path = devSocketPath(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const native = new DevRemoteNative(directory);
  return {
    native,
    path,
    listen(controller: RemoteController): () => void {
      const dispatch = devDispatch(native);
      rmSync(path, { force: true });
      const server: Server = createServer(socket => { attachLocalSetup(socket, controller, undefined, dispatch); });
      server.listen(path, () => { try { chmodSync(path, 0o600); } catch { /* socket already gone */ } });
      server.on("error", () => { /* a second daemon on the same data dir keeps its own socket */ });
      return () => { server.close(); rmSync(path, { force: true }); };
    },
  };
}
