import { DeviceSession, HostSession, base64url, hex, identityPublic } from '../src/index.ts';
import type { IdentitySecrets, ReplayClaim, SessionBinding } from '../src/index.ts';

export const hostId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const deviceId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const pairingId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
export const relayOrigin = 'https://relay.example.com';
export const binding: SessionBinding = { hostId, deviceId, trustEpoch: 7, protocolVersion: 1, relayOrigin };
export const fakeIdentity = (n: number): IdentitySecrets => ({ dh: new Uint8Array(32).fill(n), signing: new Uint8Array(32).fill(n + 1), enrollment: new Uint8Array(32).fill(n + 2) });
export const hostKeys = fakeIdentity(1), deviceKeys = fakeIdentity(11);
export const hostPublic = identityPublic(hostKeys), devicePublic = identityPublic(deviceKeys);
export const sessionId = base64url(new Uint8Array(16).fill(42));
export function replayStore(): (claim: ReplayClaim) => boolean {
  const used = new Set<string>();
  return claim => {
    const ephemeral = claim.deviceId + ':' + hex(claim.ephemeralPublic), session = hex(claim.sessionId);
    if (used.has(ephemeral) || used.has(session)) return false;
    used.add(ephemeral); used.add(session); return true;
  };
}
export function sessions() {
  const device = new DeviceSession({ binding, identity: deviceKeys, peer: hostPublic });
  let trusted = true;
  const claimReplay = replayStore();
  const options = { binding, identity: hostKeys, peer: devicePublic, isTrusted: () => trusted, claimReplay, recentRttMs: 50 };
  const host = new HostSession(options);
  return { device, host, options, revoke: () => { trusted = false; }, connect: () => device.accept(host.accept(device.start())) };
}
