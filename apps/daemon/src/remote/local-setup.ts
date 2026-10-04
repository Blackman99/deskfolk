import { closeSync, createReadStream, createWriteStream } from "node:fs";
import { Duplex } from "node:stream";
import { RemoteController } from "./controller";
import { deny } from "./trust";
import { HttpError } from "../errors";
import { remoteNative } from "../remote-native";
import type { FileRemoteNative } from "./file-native";
import type { RelayConfig } from "./relay";

export type LocalSetupRequest =
  | { operation: "status" }
  | { operation: "initialize"; config: RelayConfig; bootstrap?: string }
  | { operation: "open_pair" }
  | { operation: "list_devices" }
  | { operation: "prepare_remove_device"; deviceId: string }
  | { operation: "confirm_remove_device"; proof: string }
  | { operation: "prepare_change"; change: import("./local-actions").TrustChange }
  | { operation: "confirm_change"; proof: string }
  | { operation: "prepare_uv_renewal"; deviceId: string }
  | { operation: "confirm_uv_renewal"; proof: string }
  | { operation: "prepare_recovery" }
  | { operation: "confirm_recovery"; proof: string }
  | { operation: "prepare_pair"; pairingId: string }
  | { operation: "confirm_pair"; pairingId: string; proof: string };

/** Only the inherited socketpair reaches this dispatcher; HTTP and tools have no bridge. */
export async function dispatchLocalSetup(controller: RemoteController, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) deny();
  const value = input as LocalSetupRequest;
  const fields = Object.keys(value).sort().join();
  switch (value.operation) {
    case "status": if (fields !== "operation") deny(); return controller.status();
    case "initialize":
      if (fields !== "config,operation" && fields !== "bootstrap,config,operation") deny();
      if (!value.config || Object.keys(value.config).sort().join() !== "hostId,origin,relayId") deny();
      await controller.initialize(value.config, value.bootstrap); return controller.status();
    case "open_pair": if (fields !== "operation") deny(); return controller.openPair();
    case "list_devices": if (fields !== "operation") deny(); return { items: await controller.listDevices() };
    case "prepare_remove_device": if (fields !== "deviceId,operation") deny(); return controller.prepareRemoveDevice(value.deviceId);
    case "confirm_remove_device": if (fields !== "operation,proof") deny(); await controller.confirmRemoveDevice(value.proof); return { removed: true };
    case "prepare_change":
      if (fields !== "change,operation" || !value.change || typeof value.change !== "object") deny();
      if (value.change.kind === "change_workspace") {
        if (Object.keys(value.change).sort().join() !== "kind,path") deny();
      } else if (!["reset_identity", "change_relay"].includes(value.change.kind) || Object.keys(value.change).sort().join() !== "config,kind") deny();
      return controller.prepareChange(value.change);
    case "confirm_change": if (fields !== "operation,proof") deny(); return controller.confirmChange(value.proof);
    case "prepare_uv_renewal": if (fields !== "deviceId,operation") deny(); return controller.prepareUvRenewal(value.deviceId);
    case "confirm_uv_renewal": if (fields !== "operation,proof") deny(); await controller.confirmUvRenewal(value.proof); return { renewed: true };
    case "prepare_recovery": if (fields !== "operation") deny(); return controller.prepareRecovery();
    case "confirm_recovery": if (fields !== "operation,proof") deny(); await controller.confirmRecovery(value.proof); return controller.status();
    case "prepare_pair": if (fields !== "operation,pairingId") deny(); return controller.preparePair(value.pairingId);
    case "confirm_pair": if (fields !== "operation,pairingId,proof") deny(); return controller.confirmPair(value.pairingId, value.proof);
    default: deny();
  }
}

/** What the window may tell apart; everything else stays one redacted refusal. */
const REASONS = new Set(["relay_unreachable", "relay_bootstrap"]);
function reason(error: unknown): string {
  return error instanceof HttpError && REASONS.has(error.code) ? error.code : "remote_setup_denied";
}

/**
 * The packaged window's dispatcher over the file credential store: setup, plus the two steps of a
 * confirmation. The window shows `challenge_display` on its LocalAuthentication sheet and asks for
 * `challenge_proof` only after the person passed it. Its webview cannot send either: Tauri's
 * `remote_local_setup` forwards setup operations only.
 */
export function windowDispatch(native: FileRemoteNative): (controller: RemoteController, input: unknown) => Promise<unknown> {
  return async (controller, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) deny();
    const value = input as { operation?: unknown; challenge?: unknown };
    if (value.operation !== "challenge_display" && value.operation !== "challenge_proof") return dispatchLocalSetup(controller, input);
    if (Object.keys(value).sort().join() !== "challenge,operation" || typeof value.challenge !== "string") deny();
    if (value.operation === "challenge_display") return native.describe(value.challenge) ?? deny();
    return { proof: native.authenticate(value.challenge) };
  };
}

/** `dispatch` is overridden by the dev-only channel and the packaged window's; the sealed channel uses the production dispatcher. */
export function attachLocalSetup(stream: Duplex, controller: RemoteController, onGone?: () => void,
  dispatch: (controller: RemoteController, input: unknown) => Promise<unknown> = dispatchLocalSetup): () => void {
  let buffer = Buffer.alloc(0), busy = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); buffer.fill(0); buffer = Buffer.alloc(0); stream.destroy();
    onGone?.();
  };
  stream.on("error", close);
  stream.on("close", close);
  stream.on("data", (bytes: Buffer) => {
    if (stopped || busy || buffer.length + bytes.length > 8196) { close(); return; }
    buffer = Buffer.concat([buffer, bytes]);
    timer ??= setTimeout(close, 10_000);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length === 0 || length > 8192 || buffer.length > length + 4) { close(); return; }
    if (buffer.length !== length + 4) return;
    clearTimeout(timer); timer = undefined;
    busy = true;
    let request: unknown;
    try { request = JSON.parse(buffer.subarray(4).toString("utf8")); } catch { close(); return; }
    buffer.fill(0); buffer = Buffer.alloc(0);
    void dispatch(controller, request).then(value => ({ ok: true, value }), error => ({ ok: false, error: reason(error) })).then(response => {
      if (stopped) return;
      const payload = Buffer.from(JSON.stringify(response));
      if (payload.length > 8192) { close(); return; }
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length);
      busy = false;
      stream.write(Buffer.concat([prefix, payload]));
    });
  });
  return close;
}

/**
 * With the sealed provider, the native library checks that FD 3 leads to the signed desktop before
 * anything is read from it. With the file store (`file`), the packaged daemon trusts it for what it
 * is: the socketpair the window made and handed only to the process it spawned. Another same-user
 * process could start a daemon with its own FD 3, but that daemon reads the same 0600 file anyway.
 *
 * A Windows window cannot hand a child a descriptor past the standard three, so there the channel
 * is the daemon's own stdin and stdout, two pipes the window made for it and nobody else holds
 * (ADR 0059); `main.ts` sends everything the daemon would print to stderr instead (`reserveStdout`).
 */
export async function inheritedLocalSetup(controller: RemoteController, onGone?: () => void, file?: FileRemoteNative,
  platform: string = process.platform): Promise<(() => void) | undefined> {
  if (!process.argv.includes("--desktop-remote-channel")) return;
  const channel = () => platform === "win32" ? inheritedChannel(0, 1) : inheritedChannel(3);
  try {
    if (file) return attachLocalSetup(channel(), controller, onGone, windowDispatch(file));
    await remoteNative.authorizeDesktopChannel();
    return attachLocalSetup(channel(), controller, onGone);
  } catch { return; }
}

/**
 * With the channel on stdin and stdout (a Windows window's, ADR 0059), nothing else may write to
 * stdout: what the daemon prints goes to stderr from here on. Called first thing in `main.ts`.
 */
export function reserveStdout(): void {
  for (const method of ["log", "info", "debug", "dir", "table"] as const) console[method] = console.error;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
}

/**
 * The inherited socketpair (or, on Windows, the stdin/stdout pipe pair) as a stream. Bun's
 * `new net.Socket({ fd })` ends it at once (the window read EOF before sending anything), which
 * went unnoticed while the sealed provider refused the channel before attaching; plain reads and
 * writes on the descriptor work. Destroying closes the descriptors, so the window reads EOF; the
 * window closing its end ends the stream here.
 */
export function inheritedChannel(fd: number, writeFd: number = fd): Duplex {
  const input = createReadStream("", { fd, autoClose: false, highWaterMark: 8192 });
  const output = createWriteStream("", { fd: writeFd, autoClose: false });
  let open = true;
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, done) { output.write(chunk, done); },
    destroy(error, done) {
      input.destroy(); output.destroy();
      if (open) {
        open = false;
        for (const each of new Set([fd, writeFd])) { try { closeSync(each); } catch { /* already gone */ } }
      }
      done(error);
    },
  });
  input.on("data", chunk => channel.push(chunk));
  input.on("end", () => channel.destroy());
  input.on("error", error => channel.destroy(error));
  output.on("error", error => channel.destroy(error));
  return channel;
}
