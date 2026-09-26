export { REMOTE_RPC_VERSION, REMOTE_FILE_STREAMS, parseRemoteRequest } from './rpc.ts';
export type { RemoteRequest, RemoteResponse, RemoteReady, PairingQr, AssertionWire, RegistrationWire } from './rpc.ts';
export { NOISE_PROTOCOL, MAX_NOISE_MESSAGE } from './noise.ts';
export { base64url, fromBase64url, hex, unhex, utf8, text, randomBytes } from './bytes.ts';
export { canonicalize, canonicalBytes, canonicalHash, sha256Hex, normalizeAttachmentDigests, requestDigestBytes, requestDigest } from './canonical.ts';
export type { AttachmentDigest, ConditionalHeaders, RequestDigestInput, CanonicalEncoder } from './canonical.ts';
export {
  PROTOCOL_VERSION, MAX_PLAINTEXT, TRANSPORT_HEADER, MAX_BODY, FRAGMENT_HEADER,
  MAX_FRAGMENT_CHUNK, MAX_LOGICAL_MESSAGE, REASSEMBLY_TTL_MS, MAX_FILE_CHUNK,
  encodePrologue, encodeFrame, decodeFrame, encodeFragment, decodeFragment,
  fragmentMessage, Reassembler, encodeFileChunk, decodeFileChunk,
} from './codec.ts';
export type { FrameType, LogicalType, SessionBinding, TransportFrame, Fragment, FileChunk } from './codec.ts';
export { encodeEnrollmentProof, signEnrollmentProof, verifyEnrollmentProof, PAIR_MAILBOX_CONTRACT } from './enrollment.ts';
export type { EnrollmentChallenge, EnrollmentVerification } from './enrollment.ts';
export { MAX_PAIRING_ENVELOPE, sealPairing, openPairing, sealPairingGrant, openPairingGrant, encodeGrant, decodeGrant, signGrant, verifyGrant } from './pairing.ts';
export { PAIRING_CODE_PREFIX, encodePairingCode, decodePairingCode, ulidToBytes, ulidFromBytes } from './pairing-code.ts';
export type { PairingContext, PairingRequest, DeviceGrant, SignedDeviceGrant } from './pairing.ts';
export { REMOTE_DEFAULT_ENABLED, generateIdentity, identityPublic, DeviceSession, HostSession } from './session.ts';
export type { IdentitySecrets, IdentityPublic, ReplayClaim, SessionOptions, HostSessionOptions } from './session.ts';
export {
  WEBAUTHN_ALGORITHMS, parseCoseKey, verifyCredentialSignature, createUvChallenge,
  verifyAssertion, registrationOperationDigest, verifyRegistration,
} from './webauthn.ts';
export type {
  CredentialKey, OperationBinding, UvChallenge, WebAuthnContext, StoredCredential,
  AssertionResponse, VerifiedUv, RegistrationResponse, RegistrationAuthority, RegistrationContext,
} from './webauthn.ts';
