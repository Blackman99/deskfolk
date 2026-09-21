/**
 * The transferable form of a pairing offer.
 *
 * The JSON shape a host builds is 400 bytes once its keys are base64url'd, which is a lot to move
 * by hand onto a phone. The same fields pack into 150-odd bytes: ULIDs and keys as raw bytes, the
 * relay origin left out entirely because the device reading this is already served by that origin
 * and pins it from there — a pasted code therefore cannot aim a device at a different relay.
 *
 * Only the encoding changes. Every pinned value the pairing AEAD and the signed grant depend on —
 * the pairing secret, both host public keys, the trust epoch, the window — is still carried out of
 * band, and the device still shows the host fingerprint for the person to compare.
 */
import { base64url, bytes, check, concat, fromBase64url, utf8, text } from './bytes.ts';
import type { PairingQr } from './rpc.ts';

export const PAIRING_CODE_PREFIX = 'rb1';
/** 1 version + 16 + 16 ULID + 3 × u32 + 32 secret + 32 dh + 32 signing + 1 relay-id length. */
const FIXED = 1 + 16 + 16 + 4 + 4 + 4 + 32 + 32 + 32 + 1;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const U32_MAX = 0xffff_ffff;

/** ULIDs are 128 bits in Crockford base32; the wire carries the bits, not the spelling. */
export function ulidToBytes(value: string): Uint8Array {
  check(typeof value === 'string' && value.length === 26, 'expected a 26-character ULID');
  let carry = 0n;
  for (const char of value) {
    const digit = CROCKFORD.indexOf(char);
    check(digit >= 0, 'invalid ULID character');
    carry = (carry << 5n) | BigInt(digit);
  }
  check(carry >> 128n === 0n, 'ULID overflows 128 bits');
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(carry & 0xffn);
    carry >>= 8n;
  }
  return out;
}

export function ulidFromBytes(value: Uint8Array): string {
  bytes(value, 16);
  let carry = 0n;
  for (const byte of value) carry = (carry << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(carry & 0x1fn)] + out;
    carry >>= 5n;
  }
  return out;
}

function u32(value: number, what: string): Uint8Array {
  check(Number.isInteger(value) && value >= 0 && value <= U32_MAX, `invalid ${what}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function encodePairingCode(qr: PairingQr): string {
  check(qr.v === 1, 'unsupported pairing version');
  const relayId = utf8(qr.relayId);
  check(relayId.length >= 1 && relayId.length <= 64, 'invalid relay id');
  const packed = concat(
    new Uint8Array([1]),
    ulidToBytes(qr.pairingId),
    ulidToBytes(qr.hostId),
    u32(qr.issuedAt, 'issuedAt'),
    u32(qr.expiresUnix, 'expiresUnix'),
    u32(qr.trustEpoch, 'trustEpoch'),
    fromBase64url(qr.secret, 32),
    fromBase64url(qr.hostDhPublic, 32),
    fromBase64url(qr.hostSigningPublic, 32),
    new Uint8Array([relayId.length]),
    relayId,
  );
  return PAIRING_CODE_PREFIX + base64url(packed);
}

/**
 * `relayOrigin` comes from the caller — the origin the device is served from — never from the
 * code itself.
 */
export function decodePairingCode(code: string, relayOrigin: string): PairingQr {
  const trimmed = code.trim();
  check(trimmed.startsWith(PAIRING_CODE_PREFIX), 'not a pairing code');
  const packed = fromBase64url(trimmed.slice(PAIRING_CODE_PREFIX.length));
  check(packed.length >= FIXED, 'pairing code too short');
  check(packed[0] === 1, 'unsupported pairing version');
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const relayIdLength = packed[FIXED - 1]!;
  check(relayIdLength >= 1 && packed.length === FIXED + relayIdLength, 'pairing code length mismatch');
  const relayId = text(packed.subarray(FIXED));
  check(/^[A-Za-z0-9_-]{1,64}$/.test(relayId), 'invalid relay id');
  return {
    v: 1,
    pairingId: ulidFromBytes(packed.subarray(1, 17)),
    hostId: ulidFromBytes(packed.subarray(17, 33)),
    issuedAt: view.getUint32(33),
    expiresUnix: view.getUint32(37),
    trustEpoch: view.getUint32(41),
    secret: base64url(packed.subarray(45, 77)),
    hostDhPublic: base64url(packed.subarray(77, 109)),
    hostSigningPublic: base64url(packed.subarray(109, 141)),
    relayOrigin,
    relayId,
  };
}
