import { describe, expect, test } from 'bun:test';
import { encode } from 'cborg';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64url, canonicalHash, concat, createUvChallenge, fromBase64url, parseCoseKey, registrationOperationDigest, u16, u32, utf8, verifyAssertion, verifyRegistration } from '../src/index.ts';
import type { AssertionResponse, OperationBinding, RegistrationResponse, StoredCredential, UvChallenge, WebAuthnContext } from '../src/index.ts';
import { deviceId, relayOrigin, sessionId } from './helpers.ts';

const binding: OperationBinding = { deviceId, sessionId, trustEpoch: 7, requestId: 'request-test', action: 'runtime.restart', targetId: 'host-test', operationDigest: canonicalHash({ force: false }) };
const rpId = 'relay.example.com';
function registrationContext(record: UvChallenge, pairingId = 'fixture-pair', existingCredentialId: string | null = null) {
  return { ...contextFor(record), existingCredentialId, pendingPair: { pairingId, deviceId: record.binding.deviceId,
    sessionId: record.binding.sessionId, trustEpoch: record.binding.trustEpoch, expiresAt: 1060 } };
}
const contextFor = (record: UvChallenge): WebAuthnContext => ({ record, expectedBinding: { ...record.binding }, nowUnix: 1001, relayOrigin, rpId });
async function credential(alg: -7 | -8 | -257) {
  const algorithm = alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : alg === -8 ? { name: 'Ed25519' }
    : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' };
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const values: [number, unknown][] = alg === -7 ? [[1, 2], [3, -7], [-1, 1], [-2, fromBase64url(jwk.x!)], [-3, fromBase64url(jwk.y!)]]
    : alg === -8 ? [[1, 1], [3, -8], [-1, 6], [-2, fromBase64url(jwk.x!)]]
      : [[1, 3], [3, -257], [-1, fromBase64url(jwk.n!)], [-2, fromBase64url(jwk.e!)]];
  const cosePublicKey = encode(new Map(values));
  const stored: StoredCredential = { credentialId: base64url(new Uint8Array(24).fill(alg & 255)), cosePublicKey, signCount: 0 };
  async function assertion(record: UvChallenge, flags = 5, count = 1, changes: Record<string, unknown> = {}): Promise<AssertionResponse> {
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge: record.challenge, origin: relayOrigin, crossOrigin: false, ...changes }));
    const authenticatorData = concat(sha256(utf8(rpId)), Uint8Array.of(flags), u32(count));
    const message = concat(authenticatorData, sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign(alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : algorithm, keys.privateKey, new Uint8Array(message)));
    const signature = alg === -7 ? p256.Signature.fromBytes(raw).toBytes('der') : raw;
    return { credentialId: stored.credentialId, clientDataJSON, authenticatorData, signature };
  }
  function registration(record: UvChallenge, flags = 0x45): RegistrationResponse {
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.create', challenge: record.challenge, origin: relayOrigin, crossOrigin: false }));
    const credentialId = fromBase64url(stored.credentialId);
    const authData = concat(sha256(utf8(rpId)), Uint8Array.of(flags), u32(0), new Uint8Array(16), u16(credentialId.length), credentialId, cosePublicKey);
    return { credentialId: stored.credentialId, clientDataJSON, attestationObject: encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])) };
  }
  return { stored, assertion, registration };
}

for (const alg of [-7, -8, -257] as const) {
  test(`real WebCrypto signatures verify with COSE algorithm ${alg}`, async () => {
    const c = await credential(alg), record = createUvChallenge(binding, 'assertion', 1000), response = await c.assertion(record);
    let consumed = false;
    const commit = (u: { signCount: number }) => { expect(u.signCount).toBe(1); if (consumed) return false; consumed = true; return true; };
    const auth = await verifyAssertion(response, c.stored, contextFor(record), commit);
    expect(auth.binding).toEqual(binding);
    await expect(verifyAssertion(response, c.stored, contextFor(record), commit)).rejects.toThrow('consumed');
    response.signature[0] ^= 1;
    await expect(verifyAssertion(response, c.stored, contextFor(record), () => true)).rejects.toThrow();
    const registrationRecord = createUvChallenge({ ...binding, action: 'webauthn.register' }, 'registration', 1000);
    expect(await verifyRegistration(c.registration(registrationRecord), registrationContext(registrationRecord), { kind: 'pending-pair', pairingId: 'fixture-pair' }, () => true)).toEqual(c.stored);
  });
}

describe('WebAuthn negative verification', () => {
  test('type, origin, challenge, UP, UV, reserved/backup flags are signed but still rejected', async () => {
    const c = await credential(-7), record = createUvChallenge(binding, 'assertion', 1000);
    for (const fields of [{ type: 'webauthn.create' }, { origin: 'https://evil.example.com' }, { challenge: base64url(new Uint8Array(32)) }, { crossOrigin: true }, { topOrigin: relayOrigin }]) {
      await expect(verifyAssertion(await c.assertion(record, 5, 1, fields), c.stored, contextFor(record), () => true)).rejects.toThrow();
    }
    const duplicate = await c.assertion(record);
    duplicate.clientDataJSON = utf8('{"type":"webauthn.get","type":"webauthn.get"}');
    await expect(verifyAssertion(duplicate, c.stored, contextFor(record), () => true)).rejects.toThrow('repeat');
    for (const flags of [0, 1, 4, 7, 0x15, 0x45]) {
      await expect(verifyAssertion(await c.assertion(record, flags), c.stored, contextFor(record), () => true)).rejects.toThrow();
    }
  });
  test('RP, trust, request, session, target, params digest and TTL binding', async () => {
    const c = await credential(-7), record = createUvChallenge(binding, 'assertion', 1000), response = await c.assertion(record);
    for (const delta of [{ trustEpoch: 8 }, { requestId: 'other' }, { sessionId: base64url(new Uint8Array(16)) }, { targetId: 'other' }, { operationDigest: canonicalHash({ force: true }) }]) {
      await expect(verifyAssertion(response, c.stored, { ...contextFor(record), expectedBinding: { ...binding, ...delta } }, () => true)).rejects.toThrow('binding');
    }
    for (const delta of [{ nowUnix: 1060 }, { nowUnix: 999 }, { rpId: 'example.com' }, { relayOrigin: 'http://relay.example.com' }]) {
      await expect(verifyAssertion(response, c.stored, { ...contextFor(record), ...delta }, () => true)).rejects.toThrow();
    }
    const wrongRp = response.authenticatorData.slice(); wrongRp[0] ^= 1;
    await expect(verifyAssertion({ ...response, authenticatorData: wrongRp }, c.stored, contextFor(record), () => true)).rejects.toThrow('RP hash');
    await expect(verifyAssertion(response, { ...c.stored, credentialId: 'other' }, contextFor(record), () => true)).rejects.toThrow('credential');
  });
  test('counter zero/zero allowed, otherwise strictly increases; commit CAS can reject races', async () => {
    const c = await credential(-8), record = createUvChallenge(binding, 'assertion', 1000);
    await verifyAssertion(await c.assertion(record, 5, 0), c.stored, contextFor(record), () => true);
    for (const [previous, next] of [[1, 0], [1, 1], [8, 7], [0xffffffff, 0]]) {
      await expect(verifyAssertion(await c.assertion(record, 5, next), { ...c.stored, signCount: previous }, contextFor(record), () => true)).rejects.toThrow('counter');
    }
    await expect(verifyAssertion(await c.assertion(record), c.stored, contextFor(record), () => false)).rejects.toThrow('consumed');
  });
  test('malformed, duplicate CBOR, algorithm confusion, private fields, invalid points', () => {
    const encodeKey = (entries: [number, unknown][]) => encode(new Map(entries));
    for (const key of [new Uint8Array(), Uint8Array.of(0xa2, 1, 1, 1, 2),
      encodeKey([[1, 2], [3, -257], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]),
      encodeKey([[1, 2], [3, -7], [-1, 2], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]),
      encodeKey([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]),
      encodeKey([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)], [-4, new Uint8Array(32)]]),
      encodeKey([[1, 3], [3, -257], [-1, new Uint8Array(128)], [-2, Uint8Array.of(2)]])]) {
      expect(() => parseCoseKey(key)).toThrow();
    }
  });
});

test('registration requires pending pair consumption; a stolen device key cannot replace UV', async () => {
  const c = await credential(-7), record = createUvChallenge({ ...binding, action: 'webauthn.register' }, 'registration', 1000), response = c.registration(record);
  let hasCredential = false;
  const commit = (u: { authority: { kind: string }; binding: OperationBinding }) => {
    expect(u.binding.sessionId).toBe(sessionId);
    if (u.authority.kind !== 'pending-pair' || hasCredential) return false;
    hasCredential = true; return true;
  };
  for (const delta of [{ existingCredentialId: c.stored.credentialId }, { pendingPair: undefined },
    { pendingPair: { ...registrationContext(record, 'pending-test').pendingPair, expiresAt: 1001 } },
    { pendingPair: { ...registrationContext(record, 'pending-test').pendingPair, sessionId: 'wrong' } }]) {
    await expect(verifyRegistration(response, { ...registrationContext(record, 'pending-test'), ...delta },
      { kind: 'pending-pair', pairingId: 'pending-test' }, () => true)).rejects.toThrow('live pending pair');
  }
  await verifyRegistration(response, registrationContext(record, 'pending-test'), { kind: 'pending-pair', pairingId: 'pending-test' }, commit);
  await expect(verifyRegistration(response, registrationContext(record, 'pending-test'), { kind: 'pending-pair', pairingId: 'pending-test' }, commit)).rejects.toThrow('authority');
  await expect(verifyRegistration(response, registrationContext(record, 'pending-test', c.stored.credentialId), { kind: 'prior-uv', authorization: { binding, credentialId: c.stored.credentialId } }, () => true)).rejects.toThrow('prior UV');
  await expect(verifyRegistration(c.registration(record, 0x41), registrationContext(record, 'pending-test'), { kind: 'pending-pair', pairingId: 'pending-test' }, () => true)).rejects.toThrow('UV');
});

test('replacement authorization is real fresh UV bound to exact new registration, single use', async () => {
  const old = await credential(-8), fresh = await credential(-7);
  const registrationBinding = { ...binding, action: 'webauthn.register' };
  const record = createUvChallenge(registrationBinding, 'registration', 1000), response = fresh.registration(record);
  const uvRecord = createUvChallenge({ ...registrationBinding, operationDigest: registrationOperationDigest(response) }, 'assertion', 1000);
  const authorization = await verifyAssertion(await old.assertion(uvRecord), old.stored, contextFor(uvRecord), () => true);
  await verifyRegistration(response, registrationContext(record, 'pending-test', old.stored.credentialId), { kind: 'prior-uv', authorization }, update => update.authority.kind === 'prior-uv' && update.authority.credentialId === old.stored.credentialId);
  await expect(verifyRegistration(response, registrationContext(record, 'pending-test', old.stored.credentialId), { kind: 'prior-uv', authorization }, () => true)).rejects.toThrow('prior UV');
  const unbound = createUvChallenge(registrationBinding, 'assertion', 1000);
  const wrongAuthorization = await verifyAssertion(await old.assertion(unbound), old.stored, contextFor(unbound), () => true);
  await expect(verifyRegistration(response, registrationContext(record, 'pending-test', old.stored.credentialId), { kind: 'prior-uv', authorization: wrongAuthorization }, () => true)).rejects.toThrow('prior UV');
});
