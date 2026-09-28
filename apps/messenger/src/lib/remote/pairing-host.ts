/**
 * The Mac side of pairing, as the settings panel sees it.
 *
 * Pairing is deliberately not on the loopback API in production: the packaged window reaches the
 * daemon's setup channel over the socketpair it spawned the daemon with, and the confirmation is a
 * Touch ID sheet the window shows itself (ADR 0033). A source build has neither, so with the
 * development switch on the daemon exposes the same pairing operations on the loopback API and
 * answers the confirmation from the terminal prompt's stand-in. Both shapes are behind this module
 * so the card above it does not care which one it is talking to.
 */
import { encodePairingCode, type PairingQr } from "@real-bot/remote";
import { ApiError } from "../api.ts";
import { readTauriInternals } from "../tauri.ts";
import type { LocalApi } from "../local-api.ts";
import { hostSigningFingerprint } from "./fingerprint.ts";
import { ulid } from "./ids.ts";

export type PairingOffer = { pairingId: string; code: string; expiresUnix: number; fingerprint: string };
export type PairingWait =
  | { phase: "pending" }
  | { phase: "confirm"; name: string; fingerprint: string; challenge: string };
export type HostDevice = { id: string; name: string; lastActiveAt: number | null };

/** What the window or its daemon said no with, in the shape the card already reads. */
function refused(code: string): ApiError {
  return new ApiError(403, code, code);
}

/**
 * A development window is still a Tauri window, and `remote_local_setup` refuses one: the command
 * only answers the packaged main document. So the window channel is attempted and that refusal
 * falls through to the development route rather than surfacing as "pairing is broken". Anything
 * the packaged window answers, it answers for good: its daemon has no loopback route to retry on.
 */
async function setup(api: LocalApi, request: Record<string, unknown>): Promise<unknown> {
  const internals = readTauriInternals();
  if (internals?.invoke) {
    let reply: { ok?: boolean; value?: unknown; error?: string } | undefined;
    try {
      reply = (await internals.invoke("remote_local_setup", { request })) as typeof reply;
    } catch (error) {
      // The window's daemon was already running when it opened, so it has no channel to it.
      if (error === "desktop_channel_unavailable") throw refused(error);
      reply = undefined;
    }
    if (reply && typeof reply === "object" && "ok" in reply) {
      if (reply.ok) return reply.value;
      throw refused(String(reply.error ?? "remote_setup_denied"));
    }
  }
  return api.remoteSetup(request);
}

export type HostRelay = { origin: string; relayId: string; bootstrap: string };
export type HostRelayField = keyof HostRelay;

/**
 * Reads the connect form the way the daemon checks it, so a typo is named before the one-time
 * token is spent. A pasted address keeps working with a trailing slash.
 */
export function parseHostRelay(form: HostRelay): { relay: HostRelay } | { invalid: HostRelayField } {
  let origin: string;
  try {
    const url = new URL(form.origin.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return { invalid: "origin" };
    }
    origin = url.origin;
  } catch {
    return { invalid: "origin" };
  }
  const relayId = form.relayId.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(relayId)) return { invalid: "relayId" };
  // 32 random bytes, unpadded base64url: what the relay's bootstrap file holds.
  const bootstrap = form.bootstrap.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrap)) return { invalid: "bootstrap" };
  return { relay: { origin, relayId, bootstrap } };
}

/**
 * Registers this Mac with a relay the person runs, spending its one-time bootstrap token. The host
 * id is new each time: a failed attempt leaves nothing on the Mac or the relay to collide with.
 */
export async function initializeHost(api: LocalApi, relay: HostRelay): Promise<RemoteHostStatus> {
  return (await setup(api, {
    operation: "initialize",
    config: { origin: relay.origin, relayId: relay.relayId, hostId: ulid() },
    bootstrap: relay.bootstrap,
  })) as RemoteHostStatus;
}
export type RemoteHostStatus = { state: string; diagnostic: string | null; devices: number };

export async function listHostDevices(api: LocalApi): Promise<HostDevice[]> {
  const reply = (await setup(api, { operation: "list_devices" })) as { items?: HostDevice[] };
  return Array.isArray(reply.items) ? reply.items : [];
}

/** Opens a ten-minute window and returns what the person carries to the device. */
export async function openPairing(api: LocalApi): Promise<PairingOffer> {
  const qr = (await setup(api, { operation: "open_pair" })) as PairingQr;
  return {
    pairingId: qr.pairingId,
    code: encodePairingCode(qr),
    expiresUnix: qr.expiresUnix,
    fingerprint: hostSigningFingerprint(qr.hostSigningPublic),
  };
}

/** `pending` until the device submits; after that the person compares what it says it is. */
export async function readPairing(api: LocalApi, pairingId: string): Promise<PairingWait> {
  const reply = (await setup(api, { operation: "prepare_pair", pairingId })) as
    | { pending?: true }
    | { challenge: string; name: string; fingerprint: string };
  if ((reply as { pending?: true }).pending === true) return { phase: "pending" };
  const ready = reply as { challenge: string; name: string; fingerprint: string };
  return { phase: "confirm", name: ready.name, fingerprint: ready.fingerprint, challenge: ready.challenge };
}

/**
 * Touch ID, when this is the packaged app it belongs to; null means ask the stand-in instead. A
 * sheet the person dismissed throws `cancelled`, and nothing was spent: approving again works.
 */
async function nativeProof(challenge: string): Promise<string | null> {
  const internals = readTauriInternals();
  if (!internals?.invoke) return null;
  let confirmation: { ok?: boolean; proof?: string; diagnostic?: string } | undefined;
  try {
    confirmation = (await internals.invoke("remote_native_confirmation", {
      operation: "confirm",
      challenge,
    })) as typeof confirmation;
  } catch {
    // Refused before any sheet: a development window, which the stand-in answers.
    return null;
  }
  if (confirmation?.ok && confirmation.proof) return confirmation.proof;
  throw refused(confirmation?.diagnostic ?? "unavailable");
}

export async function removeHostDevice(api: LocalApi, deviceId: string): Promise<void> {
  const prepared = (await setup(api, { operation: "prepare_remove_device", deviceId })) as { challenge: string };
  const proof = (await nativeProof(prepared.challenge)) ??
    ((await setup(api, { operation: "dev_authenticate", challenge: prepared.challenge })) as { proof: string }).proof;
  await setup(api, { operation: "confirm_remove_device", proof });
}

/** The proof comes from Touch ID in a packaged app and from the development stand-in otherwise. */
export async function confirmPairing(api: LocalApi, pairingId: string, challenge: string): Promise<string> {
  const proof = (await nativeProof(challenge)) ??
    ((await setup(api, { operation: "dev_authenticate", challenge })) as { proof: string }).proof;
  const paired = (await setup(api, { operation: "confirm_pair", pairingId, proof })) as { deviceId: string };
  return paired.deviceId;
}
