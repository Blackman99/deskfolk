import { ed25519 } from '@noble/curves/ed25519.js';
import { base64url, bytes, check, concat, field, fromBase64url, u64, uint, utf8 } from './bytes.ts';

export interface EnrollmentChallenge {
  role: 'host' | 'device';
  id: string;
  nonce_c: string;
  nonce_s: string;
  ts: number;
  relay_id: string;
}
export function encodeEnrollmentProof(challenge: EnrollmentChallenge): Uint8Array {
  check(challenge.role === 'host' || challenge.role === 'device', 'invalid enrollment role');
  check(utf8(challenge.id).length <= 256 && utf8(challenge.relay_id).length <= 256, 'enrollment identifier limit');
  return concat(field(challenge.role), field(challenge.id), fromBase64url(challenge.nonce_c, 16),
    fromBase64url(challenge.nonce_s, 16), u64(challenge.ts), field(challenge.relay_id));
}
export function signEnrollmentProof(challenge: EnrollmentChallenge, secret: Uint8Array): string {
  return base64url(ed25519.sign(encodeEnrollmentProof(challenge), bytes(secret, 32)));
}
export interface EnrollmentVerification {
  challenge: EnrollmentChallenge;
  signature: string;
  enrolledPublicKey: Uint8Array;
  nowUnix: number;
  consume: (challenge: EnrollmentChallenge) => boolean;
}
export function verifyEnrollmentProof(input: EnrollmentVerification): void {
  uint(input.nowUnix); uint(input.challenge.ts);
  check(input.nowUnix >= input.challenge.ts && input.nowUnix - input.challenge.ts < 10, 'expired enrollment challenge');
  check(ed25519.verify(fromBase64url(input.signature, 64), encodeEnrollmentProof(input.challenge),
    bytes(input.enrolledPublicKey, 32), { zip215: false }), 'invalid enrollment signature');
  check(input.consume({ ...input.challenge }) === true, 'unknown or consumed enrollment challenge');
}

export const PAIR_MAILBOX_CONTRACT = Object.freeze({
  path: '/v1/pair/mailbox',
  maximumEnvelopeBytes: 65_536,
  maximumLifetimeSeconds: 600,
  requiresDeviceEnrollment: false,
  permitsBusinessTraffic: false,
});
