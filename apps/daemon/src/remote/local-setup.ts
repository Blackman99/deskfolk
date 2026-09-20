import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { RemoteController } from "./controller";
import { deny } from "./trust";
import { remoteNative } from "../remote-native";
import type { RelayConfig } from "./relay";

export type LocalSetupRequest =
  | { operation: "status" }
  | { operation: "initialize"; config: RelayConfig; bootstrap?: string }
  | { operation: "open_pair" }
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

export function attachLocalSetup(stream: Duplex, controller: RemoteController): () => void {
  let buffer = Buffer.alloc(0), busy = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { stopped = true; clearTimeout(timer); buffer.fill(0); buffer = Buffer.alloc(0); stream.destroy(); };
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
    void dispatchLocalSetup(controller, request).then(value => ({ ok: true, value }), () => ({ ok: false, error: "remote_setup_denied" })).then(response => {
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

export async function inheritedLocalSetup(controller: RemoteController): Promise<(() => void) | undefined> {
  if (!process.argv.includes("--desktop-remote-channel")) return;
  try {
    await remoteNative.authorizeDesktopChannel();
    return attachLocalSetup(new Socket({ fd: 3, readable: true, writable: true }), controller);
  } catch { return; }
}
