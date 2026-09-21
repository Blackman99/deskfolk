import { fromBase64url, sha256Hex } from "@real-bot/remote";

/** Full SHA-256 of the pinned host signing public key; never truncated in UI. */
export function hostSigningFingerprint(hostSigningPublic: string): string {
  return sha256Hex(fromBase64url(hostSigningPublic, 32));
}

export function formatFingerprint(hex: string): string {
  return hex.toLowerCase().replace(/(.{4})(?=.)/g, "$1 ");
}
