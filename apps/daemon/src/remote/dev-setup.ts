import { createServer, type Server } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { RemoteController } from "./controller";
import { attachLocalSetup, dispatchLocalSetup } from "./local-setup";
import { FileRemoteNative, REMOTE_CREDENTIALS_DIR } from "./file-native";
import { isCompiledBinary } from "../platform";
import { deny } from "./trust";

/**
 * Dev-only replacement for the window's setup channel.
 *
 * The packaged window reaches the controller over the socketpair it spawned the
 * daemon with, and `remote_local_setup` in the Tauri side refuses a dev origin
 * outright. During development there is no such window, so
 * `REAL_BOT_DEV_REMOTE=1` opens the same dispatcher on a 0600 unix socket beside
 * the database (a named pipe on win32, which has no such thing as a filesystem
 * socket or file permission bits), plus two operations that stand in for the
 * Touch ID sheet. A compiled daemon never takes this path.
 */
export const DEV_REMOTE_DIR = REMOTE_CREDENTIALS_DIR;
export const DEV_REMOTE_SOCKET = "setup.sock";
/** macOS caps sun_path at 104 bytes; fail loudly rather than binding a truncated path. */
const PATH_LIMIT = 100;

export type DevRemoteRequest = { operation: "dev_describe"; challenge: string } | { operation: "dev_authenticate"; challenge: string };

export function devRemoteRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REAL_BOT_DEV_REMOTE === "1";
}
/** The stand-in confirmations below skip the person; a compiled daemon must never offer them. */
export function devRemoteAllowed(modulePath: string = import.meta.path, env: NodeJS.ProcessEnv = process.env): boolean {
  return devRemoteRequested(env) && !isCompiledBinary(modulePath);
}

/**
 * win32 has no unix domain sockets under the data directory; a named pipe is the equivalent and,
 * unlike a socket file, is not subject to `PATH_LIMIT` (it is not a filesystem path at all) or to
 * `chmodSync`/`rmSync` — the OS reclaims it when every handle closes. Scoped by username the same
 * way the short fallback below is scoped by a hash of the data directory: dev-only, one daemon.
 */
export function devSocketPath(
  dataDir: string,
  platform: string = process.platform,
  username: string = rawUsername(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\real-bot-dev-remote-${username.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  }
  const natural = join(dataDir, DEV_REMOTE_DIR, DEV_REMOTE_SOCKET);
  if (Buffer.byteLength(natural) <= PATH_LIMIT) return natural;
  // A long data directory must not stop the daemon booting: fall back to a
  // stable short path both sides can derive.
  const digest = createHash("sha256").update(dataDir).digest("hex").slice(0, 8);
  const short = join(tmpdir(), `real-bot-dev-remote-${digest}.sock`);
  if (Buffer.byteLength(short) > PATH_LIMIT) throw new Error("dev remote socket path too long");
  return short;
}

function rawUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

export function devDispatch(native: FileRemoteNative): (controller: RemoteController, input: unknown) => Promise<unknown> {
  return async (controller, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) deny();
    const value = input as DevRemoteRequest;
    if (value.operation !== "dev_describe" && value.operation !== "dev_authenticate") {
      return dispatchLocalSetup(controller, input);
    }
    if (Object.keys(value).sort().join() !== "challenge,operation" || typeof value.challenge !== "string") deny();
    if (value.operation === "dev_describe") {
      const pending = native.describe(value.challenge);
      if (pending === undefined) deny();
      return { display: pending.display };
    }
    return { proof: native.authenticate(value.challenge) };
  };
}

/**
 * What the settings panel is allowed to drive in development: the first registration with a relay
 * (its connect form), pairing and removing devices. Changing the relay or resetting the identity
 * stays on the unix socket, where it takes the CLI and the prompt that goes with it.
 */
const PAIRING_OPS = new Set(["status", "initialize", "open_pair", "prepare_pair", "confirm_pair", "list_devices", "prepare_remove_device", "confirm_remove_device", "dev_describe", "dev_authenticate"]);

export function devPairingDispatch(native: FileRemoteNative): (controller: RemoteController, input: unknown) => Promise<unknown> {
  const full = devDispatch(native);
  return async (controller, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) deny();
    const operation = (input as { operation?: unknown }).operation;
    if (typeof operation !== "string" || !PAIRING_OPS.has(operation)) deny();
    return full(controller, input);
  };
}

export type DevRemote = { native: FileRemoteNative; path: string; listen(controller: RemoteController): () => void };

/** Returns undefined unless this is a source-run daemon with the dev switch on. */
export function createDevRemote(
  dataDir: string,
  modulePath: string = import.meta.path,
  platform: string = process.platform,
): DevRemote | undefined {
  if (!devRemoteAllowed(modulePath)) return;
  const directory = join(dataDir, DEV_REMOTE_DIR), path = devSocketPath(dataDir, platform);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const native = new FileRemoteNative(directory);
  return {
    native,
    path,
    listen(controller: RemoteController): () => void {
      const dispatch = devDispatch(native);
      // A named pipe is not a file: nothing to unlink beforehand and no mode bits to set after.
      const isWin32 = platform === "win32";
      if (!isWin32) rmSync(path, { force: true });
      const server: Server = createServer(socket => { attachLocalSetup(socket, controller, undefined, dispatch); });
      server.listen(path, () => {
        if (isWin32) return;
        try { chmodSync(path, 0o600); } catch { /* socket already gone */ }
      });
      server.on("error", () => { /* a second daemon on the same data dir keeps its own socket */ });
      return () => {
        server.close();
        if (!isWin32) rmSync(path, { force: true });
      };
    },
  };
}
