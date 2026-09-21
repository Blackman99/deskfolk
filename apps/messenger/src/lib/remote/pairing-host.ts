/**
 * The Mac side of pairing, as the settings panel sees it.
 *
 * Pairing is deliberately not on the loopback API in production: the packaged window reaches the
 * daemon's setup channel over an inherited socketpair that the signed helper authorizes, and the
 * confirmation is a Touch ID sheet. A source build has neither, so with the development switch on
 * the daemon exposes the same pairing operations on the loopback API and answers the confirmation
 * from the terminal prompt's stand-in. Both shapes are behind this module so the card above it
 * does not care which one it is talking to.
 */
import { encodePairingCode, type PairingQr } from "@real-bot/remote";
import { readTauriInternals } from "../tauri.ts";
import type { LocalApi } from "../local-api.ts";
import { hostSigningFingerprint } from "./fingerprint.ts";

export type PairingOffer = { pairingId: string; code: string; expiresUnix: number; fingerprint: string };
export type PairingWait =
  | { phase: "pending" }
  | { phase: "confirm"; name: string; fingerprint: string; challenge: string };

async function setup(api: LocalApi, request: Record<string, unknown>): Promise<unknown> {
  const internals = readTauriInternals();
  if (internals?.invoke) {
    const reply = (await internals.invoke("remote_local_setup", { request })) as
      | { ok?: boolean; value?: unknown; error?: string }
      | undefined;
    if (!reply?.ok) throw new Error(String(reply?.error ?? "remote_setup_denied"));
    return reply.value;
  }
  return api.remoteSetup(request);
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

/** The proof comes from Touch ID in a packaged app and from the development stand-in otherwise. */
export async function confirmPairing(api: LocalApi, pairingId: string, challenge: string): Promise<string> {
  const internals = readTauriInternals();
  let proof: string;
  if (internals?.invoke) {
    const confirmation = (await internals.invoke("remote_native_confirmation", {
      operation: "confirm",
      challenge,
    })) as { ok?: boolean; proof?: string; diagnostic?: string };
    if (!confirmation?.ok || !confirmation.proof) throw new Error(String(confirmation?.diagnostic ?? "unavailable"));
    proof = confirmation.proof;
  } else {
    const answered = (await setup(api, { operation: "dev_authenticate", challenge })) as { proof: string };
    proof = answered.proof;
  }
  const paired = (await setup(api, { operation: "confirm_pair", pairingId, proof })) as { deviceId: string };
  return paired.deviceId;
}
