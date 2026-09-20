import { expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import * as api from '../src/index.ts';
import { concat, equal, Reader, u16, u32, u64 } from '../src/bytes.ts';
import { CipherState, NoiseIK } from '../src/noise.ts';
import { binding, deviceKeys, devicePublic, hostKeys, hostPublic, replayStore } from './helpers.ts';

function offsetBuffer(input: Uint8Array): Buffer {
  const owner = Buffer.alloc(input.length + 24, 0x77);
  owner.set(input, 8);
  return owner.subarray(8, 8 + input.length);
}
const inputs: Record<string, (b: Uint8Array) => Uint8Array> = { array: (b: Uint8Array) => new Uint8Array(b), buffer: (b: Uint8Array) => Buffer.from(b), offsetBuffer };
function wrapIdentity(keys: api.IdentitySecrets, wrap: (b: Uint8Array) => Uint8Array): api.IdentitySecrets {
  return { dh: wrap(keys.dh), signing: wrap(keys.signing), enrollment: wrap(keys.enrollment) };
}

for (const [name, wrap] of Object.entries(inputs)) {
  test(`${name} identities survive failed/successful/closed concurrent sessions and reconnect`, () => {
    const host = wrapIdentity(hostKeys, wrap), device = wrapIdentity(deviceKeys, wrap);
    const hostBefore = wrapIdentity(host, b => new Uint8Array(b)), deviceBefore = wrapIdentity(device, b => new Uint8Array(b));
    const options = { binding, identity: host, peer: devicePublic, isTrusted: () => true, claimReplay: replayStore(), recentRttMs: 1 };
    class InspectHost extends api.HostSession { get ownedSigning(): Uint8Array { return this.signing; } }
    const bad = new InspectHost(options), pending = new InspectHost(options);
    const failedSigning = bad.ownedSigning, successfulSigning = pending.ownedSigning;
    expect(failedSigning.buffer).not.toBe(host.signing.buffer);
    expect(() => bad.accept(wrap(new Uint8Array()))).toThrow('invalid initiator Hello');
    expect(host).toEqual(hostBefore); expect(failedSigning).toEqual(new Uint8Array(32));
    const client = new api.DeviceSession({ binding, identity: device, peer: hostPublic });
    client.accept(wrap(pending.accept(wrap(client.start()))));
    expect(pending.receive(wrap(client.send(1, api.utf8('{}')))).body).toEqual(api.utf8('{}'));
    expect(host).toEqual(hostBefore); expect(device).toEqual(deviceBefore);
    expect(successfulSigning).toEqual(new Uint8Array(32));
    const explicitlyClosed = new InspectHost(options), closedSigning = explicitlyClosed.ownedSigning;
    explicitlyClosed.close(); expect(closedSigning).toEqual(new Uint8Array(32));
    client.close(); pending.close();
    const closed = new api.DeviceSession({ binding, identity: device, peer: hostPublic }); closed.close();
    const failed = new api.DeviceSession({ binding, identity: device, peer: hostPublic });
    failed.start(); expect(() => failed.accept(wrap(new Uint8Array()))).toThrow('Hello');
    expect(host).toEqual(hostBefore); expect(device).toEqual(deviceBefore);
    const reconnect = new api.DeviceSession({ binding, identity: device, peer: hostPublic }), server = new api.HostSession(options);
    reconnect.accept(wrap(server.accept(wrap(reconnect.start()))));
    expect(reconnect.ready && server.ready).toBe(true);
    reconnect.close(); server.close();
    expect(host).toEqual(hostBefore); expect(device).toEqual(deviceBefore);
  });

  test(`${name} caller key/pin mutation cannot change a constructed session`, () => {
    const host = wrapIdentity(hostKeys, wrap), device = wrapIdentity(deviceKeys, wrap);
    const pinnedHost = { dh: wrap(hostPublic.dh), signing: wrap(hostPublic.signing) };
    const pinnedDevice = { dh: wrap(devicePublic.dh), signing: wrap(devicePublic.signing) };
    const d = new api.DeviceSession({ binding, identity: device, peer: pinnedHost });
    const h = new api.HostSession({ binding, identity: host, peer: pinnedDevice, isTrusted: () => true, claimReplay: replayStore(), recentRttMs: 1 });
    for (const value of [...Object.values(host), ...Object.values(device), ...Object.values(pinnedHost), ...Object.values(pinnedDevice)]) value.fill(0);
    d.accept(wrap(h.accept(wrap(d.start()))));
    expect(h.receive(wrap(d.send(1, api.utf8('{}')))).type).toBe(1);
    d.close(); h.close();
  });

  test(`${name} all binary decoders respect view bounds and return owned arrays`, () => {
    const frame = { sessionId: new Uint8Array(16).fill(3), seq: 5000000000n, type: 1 as const, body: api.utf8('{}') };
    const fragment = { originalType: 8 as const, messageId: new Uint8Array(16).fill(4), index: 1, count: 2, chunk: api.utf8('end') };
    const file = { streamId: 42, offset: 5000000000n, eof: true, chunk: api.utf8('chunk') };
    const grant = { hostId: binding.hostId, deviceId: binding.deviceId, deviceSigningPublic: devicePublic.signing, deviceDhPublic: devicePublic.dh,
      enrollmentPublic: devicePublic.enrollment, trustEpoch: 0x12345678, protocolVersion: 1, relayOrigin: binding.relayOrigin, issuedAt: 5000000000 };
    const encoded = [api.encodeFrame(frame), api.encodeFragment(fragment), api.encodeFileChunk(file), api.encodeGrant(grant)].map(wrap);
    const decoded = [api.decodeFrame(encoded[0]), api.decodeFragment(encoded[1]), api.decodeFileChunk(encoded[2]), api.decodeGrant(encoded[3])];
    encoded.forEach(b => b.fill(0));
    expect(decoded).toEqual([frame, fragment, file, grant]);
    for (const result of decoded) for (const value of Object.values(result)) if (value instanceof Uint8Array) expect(value.constructor).toBe(Uint8Array);
    const r = new Reader(wrap(concat(u16(0x1234), u32(0x12345678), u64(5000000000n))));
    expect([r.u16(), r.u32(), r.u64()]).toEqual([0x1234, 0x12345678, 5000000000n]); r.end();
    for (const decode of [api.decodeFrame, api.decodeFragment, api.decodeFileChunk, api.decodeGrant]) expect(() => decode(wrap(new Uint8Array(1)))).toThrow();
    const direct = wrap(api.utf8('body')), emitted = api.fragmentMessage(1, direct); direct.fill(0);
    expect(emitted[0].body).toEqual(api.utf8('body'));
    const chunks = api.fragmentMessage(8, new Uint8Array(api.MAX_BODY + 1).fill(19)), assembly = new api.Reassembler();
    const first = wrap(chunks[0].body); assembly.accept(first, 0); first.fill(0);
    expect(assembly.accept(wrap(chunks[1].body), 1)?.body).toEqual(new Uint8Array(api.MAX_BODY + 1).fill(19));
  });
}

test('Noise cleanup wipes owned static, ephemeral and cipher copies, not Buffer sources', () => {
  const staticSecret = offsetBuffer(hostKeys.dh), ephemeral = offsetBuffer(new Uint8Array(32).fill(67)), cipherKey = offsetBuffer(new Uint8Array(32).fill(89));
  const originals = [staticSecret, ephemeral, cipherKey], snapshots = originals.map(b => new Uint8Array(b));
  const wiped: Uint8Array[] = [];
  const fill = Uint8Array.prototype.fill;
  const spy = spyOn(Uint8Array.prototype, 'fill').mockImplementation(function(this: Uint8Array, value: number, start?: number, end?: number) {
    if (value === 0 && snapshots.some(b => equal(b, this))) wiped.push(this);
    return fill.call(this, value, start, end);
  });
  try {
    const noise = new NoiseIK(false, staticSecret, api.utf8('test'), undefined, ephemeral);
    const cipher = new CipherState(cipherKey);
    noise.destroy(); cipher.destroy();
    expect(wiped.length).toBe(3);
    wiped.forEach((owned, index) => {
      expect(owned.constructor).toBe(Uint8Array);
      expect(originals.some(source => source.buffer === owned.buffer)).toBe(false);
      expect(owned).toEqual(new Uint8Array(32));
      expect(new Uint8Array(originals[index])).toEqual(snapshots[index]);
    });
  } finally { spy.mockRestore(); }
});

test('retained Noise ephemeral and getter outputs are independent of Buffer websocket messages', () => {
  const p = api.encodePrologue(binding), i = new NoiseIK(true, deviceKeys.dh, p, hostPublic.dh), r = new NoiseIK(false, hostKeys.dh, p);
  const m1 = offsetBuffer(i.writeMessage(api.utf8('one')));
  expect(r.readMessage(m1)).toEqual(api.utf8('one')); m1.fill(0);
  r.remoteEphemeral!.fill(0); r.remoteStatic!.fill(0); r.handshakeHash.fill(0);
  expect(i.readMessage(r.writeMessage(api.utf8('two')))).toEqual(api.utf8('two'));
  const ti = i.split(), tr = r.split();
  expect(tr.receive.decrypt(ti.send.encrypt(api.utf8('secret')))).toEqual(api.utf8('secret'));
});

test('public barrel excludes internal validators, readers, pairing KDF and raw Noise', () => {
  for (const internal of ['Reader', 'check', 'bytes', 'field', 'uint', 'origin', 'id', 'EMPTY', 'U64_MAX', 'concat', 'u16', 'u32', 'u64', 'pairingKey', 'pairingAssociatedData', 'NoiseIK', 'CipherState']) {
    expect(Object.hasOwn(api, internal)).toBe(false);
  }
  expect(api.hex(api.unhex('Aa00'))).toBe('aa00'); expect(api.unhex('')).toEqual(new Uint8Array());
  for (const invalid of ['a', 'gg', 'a ', '0x12']) expect(() => api.unhex(invalid)).toThrow();
});
