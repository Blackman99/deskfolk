import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { bytes, check, concat, equal, field, fromBase64url, id, origin, randomBytes, Reader, text, u16, u32, u64, uint, utf8 } from './bytes.ts';
import { canonicalBytes } from './canonical.ts';
import { PROTOCOL_VERSION } from './codec.ts';

export const MAX_PAIRING_ENVELOPE = 64 * 1024;
export interface PairingContext { pairingId: string; hostId: string; expiresUnix: number }
export interface PairingRequest {
  device_id: string;
  name: string;
  ua_hint: string;
  device_e_pk: string;
  device_s_pk: string;
  enrollment_pk: string;
}
function validateRequest(value: unknown): asserts value is PairingRequest {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid pairing request');
  const v = value as PairingRequest;
  check(Object.keys(v).sort().join(',') === 'device_e_pk,device_id,device_s_pk,enrollment_pk,name,ua_hint', 'unexpected pairing fields');
  id(v.device_id);
  check(typeof v.name === 'string' && utf8(v.name).length >= 1 && utf8(v.name).length <= 256, 'invalid device name');
  check(typeof v.ua_hint === 'string' && utf8(v.ua_hint).length <= 512, 'invalid UA hint');
  const keys = [v.device_e_pk, v.device_s_pk, v.enrollment_pk].map(k => fromBase64url(k, 32));
  check(!equal(keys[0], keys[1]) && !equal(keys[0], keys[2]) && !equal(keys[1], keys[2]), 'identity keys must differ');
}
export function pairingKey(secret: Uint8Array): Uint8Array {
  check(secret.length >= 16 && secret.length <= 32, 'pairing secret must be 16–32 bytes');
  return blake2s(utf8('rb-pair-v1'), { key: secret, dkLen: 32 });
}
export function pairingAssociatedData(context: PairingContext): Uint8Array {
  return concat(field(id(context.pairingId)), field(id(context.hostId)), u64(context.expiresUnix));
}
function fresh(context: PairingContext, nowUnix: number): void {
  uint(nowUnix); uint(context.expiresUnix);
  check(nowUnix < context.expiresUnix && context.expiresUnix - nowUnix <= 600, 'expired or invalid pairing window');
}
export function sealPairing(request: PairingRequest, secret: Uint8Array, context: PairingContext, nowUnix: number): Uint8Array {
  fresh(context, nowUnix); validateRequest(request);
  const key = pairingKey(secret), nonce = randomBytes(24);
  try { return concat(nonce, xchacha20poly1305(key, nonce, pairingAssociatedData(context)).encrypt(canonicalBytes(request))); }
  finally { key.fill(0); }
}
export function openPairing(envelope: Uint8Array, secret: Uint8Array, context: PairingContext, nowUnix: number): PairingRequest {
  fresh(context, nowUnix);
  check(envelope.length >= 40 && envelope.length <= MAX_PAIRING_ENVELOPE, 'invalid pairing envelope');
  const key = pairingKey(secret);
  try {
    const plain = xchacha20poly1305(key, envelope.subarray(0, 24), pairingAssociatedData(context)).decrypt(envelope.subarray(24));
    const request: unknown = JSON.parse(text(plain)); validateRequest(request);
    check(equal(canonicalBytes(request), plain), 'pairing JSON must be JCS');
    return request;
  } finally { key.fill(0); }
}
export interface DeviceGrant {
  hostId: string;
  deviceId: string;
  deviceSigningPublic: Uint8Array;
  deviceDhPublic: Uint8Array;
  enrollmentPublic: Uint8Array;
  trustEpoch: number;
  protocolVersion: number;
  relayOrigin: string;
  issuedAt: number;
}
export function encodeGrant(grant: DeviceGrant): Uint8Array {
  check(grant.protocolVersion === PROTOCOL_VERSION, 'unsupported grant version');
  return concat(field('RB-GRANT-v1'), field(id(grant.hostId)), field(id(grant.deviceId)), bytes(grant.deviceSigningPublic, 32),
    bytes(grant.deviceDhPublic, 32), bytes(grant.enrollmentPublic, 32), u32(grant.trustEpoch), u16(grant.protocolVersion),
    field(origin(grant.relayOrigin)), u64(grant.issuedAt));
}
export function decodeGrant(input: Uint8Array): DeviceGrant {
  const r = new Reader(input);
  check(r.field() === 'RB-GRANT-v1', 'invalid grant domain');
  const grant = { hostId: r.field(), deviceId: r.field(), deviceSigningPublic: r.take(32), deviceDhPublic: r.take(32),
    enrollmentPublic: r.take(32), trustEpoch: r.u32(), protocolVersion: r.u16(), relayOrigin: r.field(), issuedAt: r.number64() };
  r.end(); encodeGrant(grant); return grant;
}
export function signGrant(grant: DeviceGrant, hostSigningSecret: Uint8Array): Uint8Array {
  return ed25519.sign(encodeGrant(grant), bytes(hostSigningSecret, 32));
}
export function verifyGrant(grant: DeviceGrant, signature: Uint8Array, hostSigningPublic: Uint8Array, expected: DeviceGrant): void {
  check(equal(encodeGrant(grant), encodeGrant(expected)), 'grant does not match pending pair');
  check(ed25519.verify(bytes(signature, 64), encodeGrant(grant), bytes(hostSigningPublic, 32), { zip215: false }), 'invalid grant signature');
}
