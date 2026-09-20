import { expect, test } from 'bun:test';
import { blake2s } from '@noble/hashes/blake2.js';
import { pairingKey } from '../src/pairing.ts';
import { sealPairingGrant, openPairingGrant, base64url, decodeGrant, encodeGrant, encodeEnrollmentProof, hex, openPairing, sealPairing, signEnrollmentProof, signGrant, verifyEnrollmentProof, verifyGrant, utf8 } from '../src/index.ts';
import { deviceId, devicePublic, hostId, hostKeys, hostPublic, pairingId, relayOrigin } from './helpers.ts';
const request = { device_id: deviceId, name: 'Test only 测试', ua_hint: 'fixture', device_e_pk: base64url(devicePublic.signing), device_s_pk: base64url(devicePublic.dh), enrollment_pk: base64url(devicePublic.enrollment) };
const context = { pairingId, hostId, expiresUnix: 1600 }, secret = new Uint8Array(32).fill(71);
const grant = { hostId, deviceId, deviceSigningPublic: devicePublic.signing, deviceDhPublic: devicePublic.dh,
  enrollmentPublic: devicePublic.enrollment, trustEpoch: 7, protocolVersion: 1, relayOrigin, issuedAt: 1000 };

test('pairing keyed BLAKE2s, XChaCha20Poly1305, JCS, random 24-byte nonce', () => {
  expect(pairingKey(secret)).toEqual(blake2s(utf8('rb-pair-v1'), { key: secret, dkLen: 32 }));
  const cipher = sealPairing(request, secret, context, 1000);
  expect(cipher).not.toEqual(sealPairing(request, secret, context, 1000));
  expect(openPairing(cipher, secret, context, 1000)).toEqual(request);
  for (const changed of [{ ...context, pairingId: deviceId }, { ...context, hostId: deviceId }, { ...context, expiresUnix: 1599 }]) {
    expect(() => openPairing(cipher, secret, changed, 1000)).toThrow();
  }
  expect(() => openPairing(cipher, secret, context, 1600)).toThrow('expired');
  expect(() => openPairing(cipher, new Uint8Array(32), context, 1000)).toThrow();
  cipher[24] ^= 1; expect(() => openPairing(cipher, secret, context, 1000)).toThrow();
  expect(() => sealPairing({ ...request, name: '' }, secret, context, 1000)).toThrow();
  expect(() => pairingKey(new Uint8Array(15))).toThrow();
});

test('RB-GRANT-v1 is exactly 11 bytes, strict signed layout and pinned pending request', () => {
  const encoded = encodeGrant(grant);
  expect(hex(encoded.subarray(0, 13))).toBe('000b52422d4752414e542d7631');
  expect(decodeGrant(encoded)).toEqual(grant);
  const signature = signGrant(grant, hostKeys.signing);
  verifyGrant(grant, signature, hostPublic.signing, grant);
  expect(() => verifyGrant({ ...grant, trustEpoch: 8 }, signature, hostPublic.signing, grant)).toThrow();
  signature[0] ^= 1; expect(() => verifyGrant(grant, signature, hostPublic.signing, grant)).toThrow();
  encoded[1] = 10; expect(() => decodeGrant(encoded)).toThrow('domain');
});

test('grant mailbox envelope rejects direction confusion, wrong pins, material and lengths', () => {
  const signed = { grant, signature: signGrant(grant, hostKeys.signing) };
  const reply = sealPairingGrant(signed, secret, context, 1000);
  expect(openPairingGrant(reply, secret, context, 1000, hostPublic.signing, grant)).toEqual(signed);
  expect(() => openPairing(reply, secret, context, 1000)).toThrow();
  const incoming = sealPairing(request, secret, context, 1000);
  expect(() => openPairingGrant(incoming, secret, context, 1000, hostPublic.signing, grant)).toThrow();
  expect(() => openPairingGrant(reply, secret, context, 1000, devicePublic.signing, grant)).toThrow();
  expect(() => openPairingGrant(reply, secret, context, 1000, hostPublic.signing, { ...grant, trustEpoch: 8 })).toThrow();
  expect(() => openPairingGrant(reply, secret, context, 1600, hostPublic.signing, grant)).toThrow();
  for (const bytes of [new Uint8Array(), reply.subarray(0, 103), new Uint8Array(65537)]) {
    expect(() => openPairingGrant(bytes, secret, context, 1000, hostPublic.signing, grant)).toThrow();
  }
  expect(() => sealPairingGrant({ ...signed, signature: new Uint8Array(63) }, secret, context, 1000)).toThrow();
});

test('enrollment uses canonical binary, pinned table key and atomic single-use server challenge', () => {
  const challenge = { role: 'host' as const, id: hostId, nonce_c: base64url(new Uint8Array(16).fill(1)), nonce_s: base64url(new Uint8Array(16).fill(2)), ts: 1000, relay_id: 'relay-fixture' };
  expect(encodeEnrollmentProof(challenge).subarray(0, 6)).toEqual(Uint8Array.of(0, 4, 104, 111, 115, 116));
  const signature = signEnrollmentProof(challenge, hostKeys.enrollment);
  let consumed = false;
  const input = { challenge, signature, enrolledPublicKey: hostPublic.enrollment, nowUnix: 1000,
    consume: () => { if (consumed) return false; consumed = true; return true; } };
  verifyEnrollmentProof(input); expect(() => verifyEnrollmentProof(input)).toThrow('consumed');
  for (const delta of [{ role: 'device' }, { id: deviceId }, { relay_id: 'evil' }, { nonce_c: base64url(new Uint8Array(16)) }]) {
    expect(() => verifyEnrollmentProof({ ...input, challenge: { ...challenge, ...delta } as typeof challenge })).toThrow();
  }
  expect(() => verifyEnrollmentProof({ ...input, nowUnix: 1010 })).toThrow('expired');
  expect(() => verifyEnrollmentProof({ ...input, nowUnix: 999 })).toThrow();
  expect(() => verifyEnrollmentProof({ ...input, signature: signature + '=' })).toThrow('base64url');
});
