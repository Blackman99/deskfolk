import { decode, decodeFirst } from 'cborg';
import { decode as decodeJson } from 'cborg/json';
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64url, bytes, check, concat, equal, fromBase64url, origin, randomBytes, text, uint, utf8 } from './bytes.ts';
import { canonicalBytes, canonicalHash } from './canonical.ts';

export const WEBAUTHN_ALGORITHMS = [-7, -8, -257] as const;
const cborOptions = { useMaps: true, rejectDuplicateMapKeys: true, allowIndefinite: false,
  allowUndefined: false, allowInfinity: false, allowNaN: false, allowBigInt: false, strict: true };
const MAX_AUTH_BYTES = 16 * 1024;
function map(value: unknown): Map<unknown, unknown> { check(value instanceof Map, 'expected CBOR map'); return value; }
function cbor(input: Uint8Array): unknown { check(input.length <= MAX_AUTH_BYTES, 'CBOR limit'); return decode(input, cborOptions); }
function byteValue(value: unknown, length?: number): Uint8Array { check(value instanceof Uint8Array, 'expected CBOR bytes'); return bytes(value, length); }

export type CredentialKey =
  | { algorithm: -7; publicKey: Uint8Array }
  | { algorithm: -8; publicKey: Uint8Array }
  | { algorithm: -257; jwk: JsonWebKey };
export function parseCoseKey(input: Uint8Array): CredentialKey {
  const m = map(cbor(input)), kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7) {
    check(m.size === 5 && [...m.keys()].every(k => [1, 3, -1, -2, -3].includes(k as number)), 'invalid EC2 fields');
    check(m.get(-1) === 1, 'ES256 requires P-256');
    const publicKey = concat(Uint8Array.of(4), byteValue(m.get(-2), 32), byteValue(m.get(-3), 32));
    p256.Point.fromBytes(publicKey).assertValidity();
    return { algorithm: -7, publicKey };
  }
  if (kty === 1 && alg === -8) {
    check(m.size === 4 && [...m.keys()].every(k => [1, 3, -1, -2].includes(k as number)), 'invalid OKP fields');
    check(m.get(-1) === 6, 'EdDSA requires Ed25519');
    const publicKey = byteValue(m.get(-2), 32);
    const point = ed25519.Point.fromBytes(publicKey);
    check(!point.isSmallOrder() && point.isTorsionFree(), 'invalid Ed25519 key');
    return { algorithm: -8, publicKey };
  }
  if (kty === 3 && alg === -257) {
    check(m.size === 4 && [...m.keys()].every(k => [1, 3, -1, -2].includes(k as number)), 'invalid RSA fields');
    const n = byteValue(m.get(-1)), e = byteValue(m.get(-2));
    check(n.length >= 256 && n.length <= 512 && n[0] >= 128 && (n[n.length - 1] & 1) === 1, 'RSA modulus must be 2048–4096 bits');
    check(e.length >= 1 && e.length <= 4 && e[0] !== 0, 'invalid RSA exponent');
    const exponent = e.reduce((a, b) => a * 256 + b, 0);
    check(exponent >= 3 && exponent % 2 === 1, 'invalid RSA exponent');
    return { algorithm: -257, jwk: { kty: 'RSA', n: base64url(n), e: base64url(e), alg: 'RS256', ext: true } };
  }
  throw new Error('unsupported COSE algorithm/key type');
}
export async function verifyCredentialSignature(cose: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<void> {
  const key = parseCoseKey(cose);
  check(signature.length > 0 && signature.length <= 512, 'invalid credential signature length');
  let valid: boolean;
  if (key.algorithm === -7) valid = p256.verify(signature, message, key.publicKey, { format: 'der', lowS: false });
  else if (key.algorithm === -8) valid = ed25519.verify(signature, message, key.publicKey, { zip215: false });
  else {
    const imported = await crypto.subtle.importKey('jwk', key.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, new Uint8Array(signature), new Uint8Array(message));
  }
  check(valid, 'invalid credential signature');
}

export interface OperationBinding {
  deviceId: string;
  sessionId: string;
  trustEpoch: number;
  requestId: string;
  action: string;
  targetId: string;
  operationDigest: string;
}
export interface UvChallenge {
  binding: OperationBinding;
  kind: 'assertion' | 'registration';
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  challenge: string;
}
function challengeMaterial(record: Omit<UvChallenge, 'challenge'>): Uint8Array {
  const b = record.binding;
  for (const s of [b.deviceId, b.requestId, b.action]) check(typeof s === 'string' && s.length > 0 && utf8(s).length <= 256, 'invalid operation binding');
  check(typeof b.targetId === 'string' && utf8(b.targetId).length <= 256, 'invalid operation target');
  fromBase64url(b.sessionId, 16); uint(b.trustEpoch, 0xffffffff);
  check(/^[0-9a-f]{64}$/.test(b.operationDigest), 'operation digest required');
  check(record.kind === 'assertion' || record.kind === 'registration', 'invalid challenge kind');
  fromBase64url(record.nonce, 32); uint(record.issuedAt); uint(record.expiresAt);
  check(record.expiresAt === record.issuedAt + 60, 'invalid challenge lifetime');
  return canonicalBytes({ domain: 'RB-UV-v1', ...record });
}
export function createUvChallenge(binding: OperationBinding, kind: UvChallenge['kind'], nowUnix: number): UvChallenge {
  const record = { binding: { ...binding }, kind, issuedAt: nowUnix, expiresAt: nowUnix + 60, nonce: base64url(randomBytes(32)) };
  return { ...record, challenge: base64url(sha256(challengeMaterial(record))) };
}
export interface WebAuthnContext {
  record: UvChallenge;
  expectedBinding: OperationBinding;
  nowUnix: number;
  relayOrigin: string;
  rpId: string;
}
function validateContext(context: WebAuthnContext, kind: UvChallenge['kind']): void {
  const { challenge, ...record } = context.record;
  uint(context.nowUnix);
  check(record.kind === kind && context.nowUnix >= record.issuedAt && context.nowUnix < record.expiresAt, 'expired or wrong challenge');
  check(challenge === base64url(sha256(challengeMaterial(record))), 'invalid challenge binding');
  check(canonicalHash(record.binding) === canonicalHash(context.expectedBinding), 'operation binding mismatch');
  const url = new URL(origin(context.relayOrigin));
  // An exact RP host avoids public-suffix and subdomain authorization ambiguity.
  check(context.rpId === url.hostname && !context.rpId.includes(':') && !/^\d+(\.\d+){3}$/.test(context.rpId), 'RP must equal pinned relay hostname');
}
function clientData(input: Uint8Array, context: WebAuthnContext, type: string): void {
  check(input.length > 0 && input.length <= MAX_AUTH_BYTES, 'client data limit');
  text(input);
  const data = map(decodeJson(input, { useMaps: true, rejectDuplicateMapKeys: true }));
  check(data.get('type') === type && data.get('origin') === context.relayOrigin && data.get('challenge') === context.record.challenge, 'invalid WebAuthn client data');
  check(!data.has('crossOrigin') || data.get('crossOrigin') === false, 'cross-origin WebAuthn forbidden');
  check(!data.has('topOrigin'), 'embedded WebAuthn forbidden');
}
interface AuthenticatorData { signCount: number; credentialId?: Uint8Array; cose?: Uint8Array }
function authenticatorData(input: Uint8Array, rpId: string, registration: boolean): AuthenticatorData {
  check(input.length >= 37 && input.length <= MAX_AUTH_BYTES, 'authenticator data length');
  check(equal(input.subarray(0, 32), sha256(utf8(rpId))), 'RP hash mismatch');
  const flags = input[32];
  check((flags & 1) !== 0 && (flags & 4) !== 0, 'UP and UV required');
  check((flags & 0x22) === 0 && (!(flags & 0x10) || !!(flags & 8)), 'invalid authenticator flags');
  check(!!(flags & 0x40) === registration, 'invalid attested credential flag');
  const signCount = new DataView(input.buffer, input.byteOffset).getUint32(33);
  let offset = 37;
  let credentialId: Uint8Array | undefined, cose: Uint8Array | undefined;
  if (registration) {
    check(input.length >= 55, 'truncated attested data');
    const length = new DataView(input.buffer, input.byteOffset).getUint16(53);
    check(length > 0 && length <= 1024 && 55 + length < input.length, 'invalid credential id');
    credentialId = input.slice(55, 55 + length); offset = 55 + length;
    const rest = input.subarray(offset);
    const [, remainder] = decodeFirst(rest, cborOptions);
    cose = rest.slice(0, rest.length - remainder.length); offset += cose.length;
    parseCoseKey(cose);
  }
  if (flags & 0x80) { map(cbor(input.subarray(offset))); offset = input.length; }
  check(offset === input.length, 'trailing authenticator data');
  return { signCount, credentialId, cose };
}
export interface StoredCredential { credentialId: string; cosePublicKey: Uint8Array; signCount: number }
export interface AssertionResponse { credentialId: string; clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array }
export interface VerifiedUv { readonly binding: OperationBinding; readonly credentialId: string }
const authorizations = new WeakMap<VerifiedUv, { bindingHash: string; expiresAt: number }>();
export async function verifyAssertion(
  response: AssertionResponse,
  credential: StoredCredential,
  context: WebAuthnContext,
  commit: (update: { challenge: string; credentialId: string; previousSignCount: number; signCount: number; binding: OperationBinding }) => boolean | Promise<boolean>,
): Promise<VerifiedUv> {
  context = { ...context, expectedBinding: { ...context.expectedBinding }, record: { ...context.record, binding: { ...context.record.binding } } };
  credential = { ...credential, cosePublicKey: credential.cosePublicKey.slice() };
  validateContext(context, 'assertion'); clientData(response.clientDataJSON, context, 'webauthn.get');
  check(response.credentialId === credential.credentialId, 'credential mismatch');
  check(response.credentialId.length > 0 && response.credentialId.length <= 1366, 'credential id length');
  fromBase64url(response.credentialId); uint(credential.signCount, 0xffffffff);
  const auth = authenticatorData(response.authenticatorData, context.rpId, false);
  check((credential.signCount === 0 && auth.signCount === 0) || auth.signCount > credential.signCount, 'signature counter did not advance');
  await verifyCredentialSignature(credential.cosePublicKey, response.signature, concat(response.authenticatorData, sha256(response.clientDataJSON)));
  const binding = Object.freeze({ ...context.expectedBinding });
  check(await commit({ challenge: context.record.challenge, credentialId: credential.credentialId,
    previousSignCount: credential.signCount, signCount: auth.signCount, binding }) === true, 'challenge consumed, revoked, or credential changed');
  const authorization = Object.freeze({ binding, credentialId: credential.credentialId });
  authorizations.set(authorization, { bindingHash: canonicalHash(binding), expiresAt: context.record.expiresAt });
  return authorization;
}
export interface RegistrationResponse { credentialId: string; clientDataJSON: Uint8Array; attestationObject: Uint8Array }
export function registrationOperationDigest(response: RegistrationResponse): string {
  check(response.clientDataJSON.length <= MAX_AUTH_BYTES && response.attestationObject.length <= MAX_AUTH_BYTES && response.credentialId.length <= 1366, 'registration size limit');
  return canonicalHash({ domain: 'RB-UV-REGISTER-v1', credentialId: response.credentialId,
    clientDataJSON: base64url(response.clientDataJSON), attestationObject: base64url(response.attestationObject) });
}
export type RegistrationAuthority =
  | { kind: 'pending-pair'; pairingId: string }
  | { kind: 'prior-uv'; authorization: VerifiedUv };
export interface RegistrationContext extends WebAuthnContext {
  existingCredentialId: string | null;
  pendingPair?: { pairingId: string; deviceId: string; sessionId: string; trustEpoch: number; expiresAt: number };
}
export async function verifyRegistration(
  response: RegistrationResponse,
  context: RegistrationContext,
  authority: RegistrationAuthority,
  commit: (update: { challenge: string; binding: OperationBinding; credential: StoredCredential;
    authority: { kind: 'pending-pair'; pairingId: string } | { kind: 'prior-uv'; credentialId: string } }) => boolean | Promise<boolean>,
): Promise<StoredCredential> {
  validateContext(context, 'registration');
  check(context.expectedBinding.action === 'webauthn.register', 'registration action required');
  let authorization: { kind: 'pending-pair'; pairingId: string } | { kind: 'prior-uv'; credentialId: string };
  if (authority.kind === 'prior-uv') {
    const verified = authorizations.get(authority.authorization);
    check(context.existingCredentialId === authority.authorization.credentialId, 'prior credential mismatch');
    check(verified && context.nowUnix < verified.expiresAt && verified.bindingHash === canonicalHash({
      ...context.expectedBinding, operationDigest: registrationOperationDigest(response),
    }), 'fresh prior UV bound to new credential required');
    authorizations.delete(authority.authorization);
    authorization = { kind: 'prior-uv', credentialId: authority.authorization.credentialId };
  } else {
    check(authority.kind === 'pending-pair' && typeof authority.pairingId === 'string' && authority.pairingId.length > 0, 'pending pair required');
    const pending = context.pendingPair, b = context.expectedBinding;
    check(context.existingCredentialId === null && pending && pending.pairingId === authority.pairingId &&
      pending.deviceId === b.deviceId && pending.sessionId === b.sessionId && pending.trustEpoch === b.trustEpoch &&
      Number.isSafeInteger(pending.expiresAt) && context.nowUnix < pending.expiresAt, 'first registration requires live pending pair and no existing credential');
    authorization = { kind: 'pending-pair', pairingId: authority.pairingId };
  }
  clientData(response.clientDataJSON, context, 'webauthn.create');
  const attestation = map(cbor(response.attestationObject));
  check(attestation.size === 3 && attestation.get('fmt') === 'none' && map(attestation.get('attStmt')).size === 0, 'only none attestation allowed');
  const auth = authenticatorData(byteValue(attestation.get('authData')), context.rpId, true);
  check(response.credentialId.length > 0 && response.credentialId.length <= 1366, 'credential id length');
  check(equal(fromBase64url(response.credentialId), auth.credentialId!), 'registration credential mismatch');
  const credential = { credentialId: response.credentialId, cosePublicKey: auth.cose!, signCount: auth.signCount };
  check(await commit({ challenge: context.record.challenge, binding: { ...context.expectedBinding },
    credential: { ...credential, cosePublicKey: credential.cosePublicKey.slice() }, authority: authorization }) === true, 'registration authority expired, consumed, or changed');
  return credential;
}
