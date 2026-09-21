import { expect, test } from 'bun:test';
import { base64url, randomBytes } from '../src/bytes.ts';
import { decodePairingCode, encodePairingCode, ulidFromBytes, ulidToBytes, PAIRING_CODE_PREFIX } from '../src/pairing-code.ts';
import type { PairingQr } from '../src/rpc.ts';

const ORIGIN = 'https://relay.example.test';
function offer(overrides: Partial<PairingQr> = {}): PairingQr {
  return {
    v: 1,
    pairingId: '01M31H1EA5SRS9KZ3ACSW65W28',
    hostId: '01M31F94895RD4N9WWKZDHM7Y2',
    issuedAt: 1789979048,
    expiresUnix: 1789979648,
    trustEpoch: 1,
    relayOrigin: ORIGIN,
    relayId: 'westlake1',
    secret: base64url(randomBytes(32)),
    hostDhPublic: base64url(randomBytes(32)),
    hostSigningPublic: base64url(randomBytes(32)),
    ...overrides,
  };
}

test('a round trip keeps every pinned field', () => {
  const qr = offer();
  const decoded = decodePairingCode(encodePairingCode(qr), ORIGIN);
  expect(decoded).toEqual(qr);
});

test('the code is about half the JSON it replaces', () => {
  const qr = offer();
  const code = encodePairingCode(qr);
  expect(code.startsWith(PAIRING_CODE_PREFIX)).toBe(true);
  // 96 of the packed bytes are the pairing secret and the two host keys, so this is the floor
  // for anything that still pins the host out of band.
  expect(code.length).toBeLessThan(JSON.stringify(qr).length * 0.55);
  expect(code.length).toBeLessThanOrEqual(210);
  // No separators, so a double-click selects the whole thing.
  expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('the relay origin comes from the reader, never from the code', () => {
  const code = encodePairingCode(offer());
  expect(decodePairingCode(code, 'https://other.example.test').relayOrigin).toBe('https://other.example.test');
});

test('ULIDs survive the byte packing, including the highest one', () => {
  for (const id of ['01M31H1EA5SRS9KZ3ACSW65W28', '00000000000000000000000000', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
    expect(ulidFromBytes(ulidToBytes(id))).toBe(id);
  }
  expect(() => ulidToBytes('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow('ULID overflows 128 bits');
  expect(() => ulidToBytes('01M31H1EA5SRS9KZ3ACSW65W2')).toThrow('expected a 26-character ULID');
  expect(() => ulidToBytes('01M31H1EA5SRS9KZ3ACSW65W2U')).toThrow('invalid ULID character');
});

test('a truncated, padded or mislabelled code is refused', () => {
  const code = encodePairingCode(offer());
  expect(() => decodePairingCode(code.slice(0, code.length - 4), ORIGIN)).toThrow();
  expect(() => decodePairingCode(`rb2${code.slice(3)}`, ORIGIN)).toThrow('not a pairing code');
  expect(() => decodePairingCode(`${code}AAAA`, ORIGIN)).toThrow();
  expect(() => decodePairingCode('', ORIGIN)).toThrow('not a pairing code');
});

test('surrounding whitespace from a paste is tolerated', () => {
  const qr = offer();
  expect(decodePairingCode(`  ${encodePairingCode(qr)}\n`, ORIGIN).pairingId).toBe(qr.pairingId);
});
