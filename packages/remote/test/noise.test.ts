import { describe, expect, test } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import cacophony from './fixtures/cacophony-ik.json';
import noiseC from './fixtures/noise-c-ik.json';
import { NoiseIK } from '../src/noise.ts';
import { DeviceSession, HostSession, MAX_BODY, concat, encodeFrame, encodePrologue, hex, randomBytes, unhex, utf8 } from '../src/index.ts';
import { binding, deviceKeys, devicePublic, fakeIdentity, hostKeys, hostPublic, sessions } from './helpers.ts';

test('official Noise registry Cacophony and noise-c IK vectors: handshake, h, nonce streams', () => {
  for (const v of [...cacophony, ...noiseC]) {
    const i = new NoiseIK(true, unhex(v.init_static), unhex(v.init_prologue), unhex(v.init_remote_static), unhex(v.init_ephemeral));
    const r = new NoiseIK(false, unhex(v.resp_static), unhex(v.resp_prologue), undefined, unhex(v.resp_ephemeral));
    const m1 = i.writeMessage(unhex(v.messages[0].payload));
    expect(hex(m1)).toBe(v.messages[0].ciphertext);
    expect(hex(r.readMessage(m1))).toBe(v.messages[0].payload);
    const m2 = r.writeMessage(unhex(v.messages[1].payload));
    expect(hex(m2)).toBe(v.messages[1].ciphertext);
    expect(hex(i.readMessage(m2))).toBe(v.messages[1].payload);
    expect(hex(i.handshakeHash)).toBe(v.handshake_hash);
    expect(hex(r.handshakeHash)).toBe(v.handshake_hash);
    const ti = i.split(), tr = r.split();
    for (let n = 2; n < v.messages.length; n++) {
      const sender = n % 2 === 0 ? ti : tr, receiver = n % 2 === 0 ? tr : ti;
      const message = sender.send.encrypt(unhex(v.messages[n].payload));
      expect(hex(message)).toBe(v.messages[n].ciphertext);
      expect(hex(receiver.receive.decrypt(message))).toBe(v.messages[n].payload);
    }
  }
});

test('pinned Hello sessions exchange actual AEAD traffic with increasing nonces', () => {
  const s = sessions();
  expect(() => s.device.authenticatedSessionId).toThrow('not authenticated');
  s.connect();
  const sid = s.device.authenticatedSessionId;
  expect(sid).toEqual(s.host.authenticatedSessionId); sid.fill(0);
  expect(s.device.authenticatedSessionId).not.toEqual(sid);
  for (let n = 0; n < 3; n++) {
    const cipher = s.device.send(1, utf8('secret'));
    expect(new TextDecoder().decode(cipher)).not.toContain('secret');
    expect(s.host.receive(cipher)).toMatchObject({ seq: BigInt(n), type: 1, body: utf8('secret') });
    expect(s.device.receive(s.host.send(2, utf8('response'))).seq).toBe(BigInt(n));
  }
  expect(s.host.receive(s.device.send(8, new Uint8Array(MAX_BODY))).body.length).toBe(MAX_BODY);
});

describe('S1 fail closed', () => {
  for (const type of [1, 2, 3, 4, 5, 6, 7, 8, 255]) {
    test(`no transport type ${type} before Split`, () => {
      const s = sessions();
      expect(() => s.device.send(type as 1, new Uint8Array())).toThrow('before Split');
      expect(() => s.host.receive(concat(randomBytes(24), Uint8Array.of(type)))).toThrow('before Split');
      expect(() => s.device.start()).toThrow('closed');
    });
  }
  test('host owns message1 replay claim, no second response/session', () => {
    const s = sessions(), m1 = s.device.start(); s.host.accept(m1);
    expect(() => new HostSession(s.options).accept(m1)).toThrow('replayed');
  });
  test('revocation before and after handshake', () => {
    const s = sessions(); s.revoke(); expect(() => s.host.accept(s.device.start())).toThrow('revoked');
    const t = sessions(); t.connect(); t.revoke(); expect(() => t.host.receive(t.device.send(1, utf8('{}')))).toThrow('revoked');
  });
  test('replay, reorder, corruption, oversize terminate rather than resetting nonce', () => {
    for (const kind of ['replay', 'reorder', 'corrupt', 'oversize']) {
      const s = sessions(); s.connect(); const first = s.device.send(1, utf8('{}'));
      let bad = first;
      if (kind === 'replay') s.host.receive(first);
      if (kind === 'reorder') bad = s.device.send(1, utf8('{}'));
      if (kind === 'corrupt') bad[bad.length - 1] ^= 1;
      if (kind === 'oversize') bad = new Uint8Array(65536);
      expect(() => s.host.receive(bad)).toThrow(); expect(s.host.ready).toBe(false);
      expect(() => s.host.receive(first)).toThrow('closed');
    }
  });
  test('tampering prologue and pinned DH/signing identities', () => {
    for (const changes of [{ trustEpoch: 8 }, { relayOrigin: 'https://evil.example.com' }, { deviceId: binding.hostId }]) {
      const s = sessions(); const d = new DeviceSession({ binding: { ...binding, ...changes }, identity: deviceKeys, peer: hostPublic });
      expect(() => s.host.accept(d.start())).toThrow();
    }
    for (const peer of [{ ...hostPublic, dh: devicePublic.dh }, { ...hostPublic, signing: devicePublic.signing }]) {
      const s = sessions(); const d = new DeviceSession({ binding, identity: deviceKeys, peer });
      expect(() => d.accept(s.host.accept(d.start()))).toThrow();
    }
    const s = sessions(); const d = new DeviceSession({ binding, identity: fakeIdentity(70), peer: hostPublic });
    expect(() => s.host.accept(d.start())).toThrow('static identity');
  });
  test('valid Noise AEAD cannot bypass Hello signatures or application session/seq checks', () => {
    const prologue = encodePrologue(binding);
    const badInitiator = new NoiseIK(true, deviceKeys.dh, prologue, hostPublic.dh);
    const s = sessions();
    expect(() => s.host.accept(badInitiator.writeMessage(concat(randomBytes(16), devicePublic.signing, new Uint8Array(64))))).toThrow('Hello signature');
    const t = sessions(), responder = new NoiseIK(false, hostKeys.dh, prologue);
    responder.readMessage(t.device.start());
    expect(() => t.device.accept(responder.writeMessage(concat(hostPublic.signing, new Uint8Array(64))))).toThrow('Hello signature');
    for (const mismatch of ['session', 'seq', 'length']) {
      const u = sessions(), raw = new NoiseIK(true, deviceKeys.dh, prologue, hostPublic.dh), sessionId = randomBytes(16);
      const sig = ed25519.sign(concat(utf8('RB-HELLO-I'), prologue, raw.ephemeralPublic, sessionId), deviceKeys.signing);
      raw.readMessage(u.host.accept(raw.writeMessage(concat(sessionId, devicePublic.signing, sig))));
      const transport = raw.split();
      const plain = encodeFrame({ sessionId: mismatch === 'session' ? randomBytes(16) : sessionId,
        seq: mismatch === 'seq' ? 1n : 0n, type: 1, body: utf8('{}') });
      expect(() => u.host.receive(transport.send.encrypt(mismatch === 'length' ? new Uint8Array(32769) : plain))).toThrow();
      expect(u.host.ready).toBe(false);
    }
  });
  test('wrong roles, downgrade, extra frame and Hello tampering', () => {
    expect(() => new DeviceSession({ binding: { ...binding, protocolVersion: 0 }, identity: deviceKeys, peer: hostPublic })).toThrow('version');
    const s = sessions(); expect(() => s.device.accept(s.device.start())).toThrow();
    const t = sessions(); const m = t.device.start(); m[m.length - 1] ^= 1; expect(() => t.host.accept(m)).toThrow();
    const u = sessions(); expect(() => u.host.accept(concat(u.device.start(), new Uint8Array(1)))).toThrow();
  });
  test('raw IK cannot Split early, low order X25519 and app-prefix injection rejected', () => {
    const n = new NoiseIK(true, deviceKeys.dh, utf8('p'), hostPublic.dh);
    expect(() => n.split()).toThrow('Split');
    const s = sessions(); const m1 = s.device.start(); m1.fill(0, 0, 32); expect(() => s.host.accept(m1)).toThrow();
    const t = sessions(); expect(() => t.host.accept(encodeFrame({ sessionId: randomBytes(16), seq: 0n, type: 8, body: new Uint8Array(183) }))).toThrow();
  });
});
