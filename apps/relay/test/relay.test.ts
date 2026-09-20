import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { base64url, canonicalize, DeviceSession, fromBase64url, generateIdentity, HostSession, identityPublic, openPairing, randomBytes, sealPairing, signEnrollmentProof, utf8 } from '@real-bot/remote';
import { authenticate, challenge, deadline, DEVICE, DEVICE2, fixture, HOST, ORIGIN, PAIR } from './helpers.ts';
import type { Json } from './helpers.ts';
import { Bucket, IpLimiter, LIMITS } from '../src/wire.ts';
import { Mailboxes } from '../src/mailbox.ts';
import { SlowPeer } from './slow-peer.ts';
import type { EnrollmentChallenge } from '@real-bot/remote';

const path = '/v1/relay/bootstrap';

describe('durable enrollment and admission', () => {
  test('bootstrap is atomic, one-use across restart, body-only, bounded, and stores no token', async () => {
    const f = await fixture();
    try {
      const attempts = await Promise.all([f.enroll(), f.enroll()]);
      expect(attempts.map(r => r.status).sort()).toEqual([201, 400]);
      expect(statSync(`${f.directory}/enrollment.sqlite`).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${f.directory}/enrollment.sqlite`).includes(Buffer.from(f.bootstrap))).toBe(false);
      await f.restart(); expect((await f.enroll()).status).toBe(400);
      const control = await f.host(); expect((await f.command(control, 'health')).devices).toBe(0);
      expect((await fetch(`http://127.0.0.1:${f.port}${path}?bootstrap=${f.bootstrap}`)).status).toBe(400);
      expect((await f.post('/v1/arbitrary/proxy', {})).status).toBe(404);
    } finally { await f.close(); }
  });
  test('default admission and public pairing are independently closed', async () => {
    const f = await fixture({ enabled: false });
    try {
      expect((await f.enroll()).status).toBe(503);
      expect(await (await fetch(`http://127.0.0.1:${f.port}/healthz`)).json()).toEqual({ enabled: false, status: 'ok' });
    } finally { await f.close(); }
    const g = await fixture({ pairingEnabled: false });
    try { expect((await g.enroll()).status).toBe(503); } finally { await g.close(); }
  });
  test('weak bootstrap, unknown identities, wrong role and supplied public key do not admit', async () => {
    await expect(fixture({ bootstrap: base64url(new Uint8Array(32)) })).rejects.toThrow();
    const f = await fixture();
    try {
      expect((await f.post(path, { ...f.bootstrapBody, bootstrap: base64url(new Uint8Array(32)) })).status).toBe(400);
      await f.enroll(); const control = await f.host(); await f.register(control);
      for (const [role, id, extra] of [
        ['device', HOST, {}], ['host', DEVICE, { mode: 'control' }],
        ['device', DEVICE2, {}], ['device', DEVICE, { public_key: base64url(identityPublic(f.deviceKeys).enrollment) }],
      ] as const) {
        const peer = f.peer(role); await peer.open();
        peer.text({ type: 'hello', id, nonce_c: base64url(randomBytes(16)), ...extra });
        await deadline(peer.closed);
      }
    } finally { await f.close(); }
  });
  test('stored-key signatures, fresh server nonces, role binding, replay and exact 10s expiry', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const p = f.peer('device'); await p.open(); const issued = await challenge(p, DEVICE);
      const signature = signEnrollmentProof(issued, f.deviceKeys.enrollment);
      p.text({ type: 'proof', signature: signEnrollmentProof(issued, f.hostKeys.enrollment) }); await deadline(p.closed);
      const q = f.peer('device'); await q.open(); const fresh = await challenge(q, DEVICE);
      expect(fresh.nonce_s).not.toBe(issued.nonce_s);
      q.text({ type: 'proof', signature }); await deadline(q.closed);
      const r = f.peer('device'); await r.open(); const wrongRole = await challenge(r, DEVICE);
      r.text({ type: 'proof', signature: signEnrollmentProof({ ...wrongRole, role: 'host' }, f.deviceKeys.enrollment) }); await deadline(r.closed);
      const s = f.peer('device'); await s.open(); const expires = await challenge(s, DEVICE);
      f.advance(10_000); s.text({ type: 'proof', signature: signEnrollmentProof(expires, f.deviceKeys.enrollment) }); await deadline(s.closed);
    } finally { await f.close(); }
  });
  test('device registration is durable and bounded to 16; revoke frees capacity without tombstone growth', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host();
      for (let i = 0; i < 16; i++) await f.register(control, `01ARZ3NDEKTSV4RRFFQ69G5F${i.toString(32).toUpperCase().padStart(2, '0')}`, generateIdentity());
      expect((await f.command(control, 'health')).devices).toBe(16);
      control.binary({ op: 'register_device', request_id: base64url(randomBytes(16)), device_id: DEVICE, enrollment_pk: base64url(identityPublic(f.deviceKeys).enrollment) });
      await deadline(control.closed);
      await f.restart(); const reconnected = await f.host(); expect((await f.command(reconnected, 'health')).devices).toBe(16);
      await f.command(reconnected, 'revoke_device', { device_id: '01ARZ3NDEKTSV4RRFFQ69G5F00' });
      await f.register(reconnected); expect((await f.command(reconnected, 'health')).devices).toBe(16);
    } finally { await f.close(); }
  });
});

describe('authenticated routes and real Noise', () => {
  test('two simultaneous devices use separate host outbound links and actual duplex Noise sessions', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); const second = generateIdentity();
      await f.register(control); await f.register(control, DEVICE2, second);
      const a = await f.route(control), b = await f.route(control, DEVICE2, second);
      expect(a.routeId).not.toBe(b.routeId);
      const pairs = [[a, DEVICE, f.deviceKeys], [b, DEVICE2, second]] as const;
      for (const [route, deviceId, keys] of pairs) {
        const binding = { hostId: HOST, deviceId, trustEpoch: 1, protocolVersion: 1, relayOrigin: ORIGIN };
        const claims = new Set<string>();
        const device = new DeviceSession({ binding, identity: keys, peer: identityPublic(f.hostKeys) });
        const host = new HostSession({ binding, identity: f.hostKeys, peer: identityPublic(keys), recentRttMs: 0, isTrusted: () => true,
          claimReplay: claim => { const id = base64url(claim.sessionId); if (claims.has(id)) return false; claims.add(id); return true; } });
        route.device.binary(device.start());
        route.link.binary(host.accept(await route.link.next() as Uint8Array));
        device.accept(await route.device.next() as Uint8Array);
        const canary = utf8(`test-only-private-command-${deviceId}`);
        route.device.binary(device.send(1, canary));
        expect(host.receive(await route.link.next() as Uint8Array).body).toEqual(canary);
        route.link.binary(host.send(2, canary));
        expect(device.receive(await route.device.next() as Uint8Array).body).toEqual(canary);
        expect(JSON.stringify(f.logs)).not.toContain('test-only-private-command');
        device.close(); host.close();
      }
      await f.command(control, 'revoke_device', { device_id: DEVICE });
      await deadline(Promise.all([a.device.closed, a.link.closed]));
      b.device.binary(new Uint8Array([99])); expect(await b.link.next()).toEqual(new Uint8Array([99]));
      expect((await f.command(control, 'health')).routes).toBe(1);
      const revoked = f.peer('device'); await revoked.open(); revoked.text({ type: 'hello', id: DEVICE, nonce_c: base64url(randomBytes(16)) }); await deadline(revoked.closed);
    } finally { await f.close(); }
  });
  test('16 live device routes occupy exactly 32 data slots without cross-device delivery', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host();
      const routes = [];
      for (let i = 0; i < 16; i++) {
        if (i % 4 === 0) f.advance(60_000);
        const id = `01ARZ3NDEKTSV4RRFFQ69G5F${i.toString(32).toUpperCase().padStart(2, '0')}`;
        const keys = generateIdentity(); await f.register(control, id, keys);
        routes.push(await f.route(control, id, keys));
      }
      const health = await f.command(control, 'health');
      expect(health.routes * 2).toBe(LIMITS.slots); expect(health.sockets).toBe(33);
      for (let i = 0; i < routes.length; i++) routes[i].device.binary(new Uint8Array([i]));
      for (let i = 0; i < routes.length; i++) expect(await routes[i].link.next()).toEqual(new Uint8Array([i]));
    } finally { await f.close(); }
  });
  test('only the authenticated host can bind a pending route; mismatched and arbitrary recipients fail', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const device = f.peer('device'); await device.open(); await authenticate(device, DEVICE, f.deviceKeys);
      const pending = await control.json();
      for (const [routeId, deviceId] of [[pending.route_id, DEVICE2], [base64url(randomBytes(16)), DEVICE]]) {
        const link = f.peer('host'); await link.open();
        link.text({ type: 'hello', id: HOST, mode: 'link', nonce_c: base64url(randomBytes(16)), route_id: routeId, device_id: deviceId });
        await deadline(link.closed);
      }
      device.binary(new Uint8Array([1])); await deadline(device.closed);
      expect((await f.command(control, 'health')).routes).toBe(0);
    } finally { await f.close(); }
  });
  test('wrong text/binary phases and oversized frames close both route endpoints', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const preauth = f.peer('device'); await preauth.open(); preauth.binary(new Uint8Array([1])); await deadline(preauth.closed);
      const p = f.peer('device'); await p.open(); p.socket.send('x'.repeat(LIMITS.text + 1)); await deadline(p.closed);
      const a = await f.route(control); a.device.text({ type: 'proof', signature: 'again' }); await deadline(Promise.all([a.device.closed, a.link.closed]));
      await f.command(control, 'health');
      const b = await f.route(control); b.link.binary(new Uint8Array(LIMITS.frame + 1)); await deadline(Promise.all([b.device.closed, b.link.closed]));
      control.text({ op: 'health' }); await deadline(control.closed);
    } finally { await f.close(); }
  });
  test('host offline clears routes/mailboxes and never queues; reconnect requires new enrollment and Noise', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      await f.command(control, 'open_pair', { pairing_id: PAIR, expires_unix: Math.floor(f.now / 1_000) + 60 });
      const a = await f.route(control); control.close(); await deadline(Promise.all([control.closed, a.device.closed, a.link.closed]));
      expect((await f.post('/v1/pair/mailbox', { op: 'submit', pairing_id: PAIR, ciphertext: base64url(randomBytes(40)) })).status).toBe(503);
      const reconnect = await f.host(); const health = await f.command(reconnect, 'health');
      expect(health.routes).toBe(0); expect(health.mailboxes).toBe(0);
    } finally { await f.close(); }
  });
  test('idle challenge and host-link waiting deadlines remove orphan slots', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const idle = f.peer('device'); await idle.open();
      const waiting = f.peer('device'); await waiting.open(); await authenticate(waiting, DEVICE, f.deviceKeys); await control.json();
      f.advance(10_001); await deadline(Promise.all([idle.closed, waiting.closed]));
      expect((await f.command(control, 'health')).routes).toBe(0);
    } finally { await f.close(); }
  });
});

describe('unregistered opaque pairing mailbox', () => {
  test('host-authorized window avoids enrollment deadlock; actual pairing AEAD survives relay unchanged', async () => {
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host();
      const context = { pairingId: PAIR, hostId: HOST, expiresUnix: Math.floor(f.now / 1_000) + 60 };
      const secret = randomBytes(32), keys = identityPublic(f.deviceKeys);
      const request = { device_id: DEVICE, name: 'test-canary-secret-name', ua_hint: 'fixture', device_e_pk: base64url(keys.dh), device_s_pk: base64url(keys.signing), enrollment_pk: base64url(keys.enrollment) };
      const encrypted = sealPairing(request, secret, context, Math.floor(f.now / 1_000));
      const submit = { op: 'submit', pairing_id: PAIR, ciphertext: base64url(encrypted) };
      expect((await f.post('/v1/pair/mailbox', submit)).status).toBe(400);
      await f.command(control, 'open_pair', { pairing_id: PAIR, expires_unix: context.expiresUnix });
      expect((await f.post('/v1/pair/mailbox', submit)).status).toBe(202);
      expect((await f.post('/v1/pair/mailbox', submit)).status).toBe(400);
      const chunk = await f.command(control, 'read_pair', { pairing_id: PAIR, offset: 0 });
      expect(openPairing(fromBase64url(chunk.ciphertext), secret, context, Math.floor(f.now / 1_000))).toEqual(request);
      expect((await f.post('/v1/pair/mailbox', { op: 'poll', pairing_id: PAIR })).status).toBe(202);
      await f.register(control);
      // Echo a real AEAD envelope; grant construction stays in the host adapter.
      const sealedReply = sealPairing(request, secret, context, Math.floor(f.now / 1_000));
      for (let offset = 0; offset < sealedReply.length; offset += LIMITS.mailboxChunk) {
        await f.command(control, 'deliver_pair', { pairing_id: PAIR, offset, total: sealedReply.length, ciphertext: base64url(sealedReply.subarray(offset, offset + LIMITS.mailboxChunk)) });
      }
      const response = await f.post('/v1/pair/mailbox', { op: 'poll', pairing_id: PAIR });
      const returned = fromBase64url((await response.json() as Json).ciphertext);
      expect(returned).toEqual(sealedReply);
      expect(openPairing(returned, secret, context, Math.floor(f.now / 1_000))).toEqual(request);
      expect((await f.post('/v1/pair/mailbox', { op: 'poll', pairing_id: PAIR })).status).toBe(400);
      expect(JSON.stringify(f.logs)).not.toContain(request.name); expect(JSON.stringify(f.logs)).not.toContain(base64url(secret));
    } finally { await f.close(); }
  });
  test('mailbox has a total 64KiB allocation, sequential chunking, four windows and ten minute expiry', () => {
    const boxes = new Mailboxes();
    for (let i = 0; i < 4; i++) boxes.open(String(i), 600_000, 0);
    expect(() => boxes.open('extra', 1, 0)).toThrow();
    expect(() => boxes.submit('0', new Uint8Array(65_537), 0)).toThrow();
    boxes.submit('0', randomBytes(65_536), 0);
    expect(() => boxes.deliver('0', 0, 40, randomBytes(40), 0)).toThrow();
    for (let offset = 0; offset < 65_536; offset += LIMITS.mailboxChunk) expect(boxes.readRequest('0', offset, 0)!.offset).toBe(offset);
    expect(() => boxes.deliver('0', 1, 40, randomBytes(40), 0)).toThrow();
    boxes.deliver('0', 0, 40, randomBytes(40), 0); expect(boxes.poll('0', 0)!.length).toBe(40);
    boxes.expire(600_000); expect(boxes.size).toBe(0);
    expect(() => boxes.open('late', 600_001, 0)).toThrow();
  });
});

describe('limits and redaction', () => {
  test('10/min per-IP admission ignores spoofed forwarding headers and limits total IP tracking', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 11; i++) {
        const response = await fetch(`http://127.0.0.1:${f.port}/v1/relay/host`, { headers: { 'x-real-ip': `192.0.2.${i}`, 'x-forwarded-for': `192.0.2.${i}` } });
        expect(response.status).toBe(i < 10 ? 400 : 429);
      }
      f.advance(60_000); expect((await fetch(`http://127.0.0.1:${f.port}/v1/relay/host`)).status).toBe(400);
      const limiter = new IpLimiter();
      for (let i = 0; i < LIMITS.ipEntries; i++) expect(limiter.take(String(i), 0)).toBe(true);
      expect(limiter.take('overflow', 0)).toBe(false); expect(limiter.take('overflow', 60_000)).toBe(true);
    } finally { await f.close(); }
  });
  test('bandwidth is a real 20Mbps token bucket and live overload closes paired sockets', async () => {
    const bucket = new Bucket(LIMITS.burstBytes, LIMITS.bytesPerSecond, 0);
    expect(bucket.take(LIMITS.burstBytes, 0)).toBe(true); expect(bucket.take(1, 0)).toBe(false);
    expect(bucket.take(2_500, 1)).toBe(true); expect(bucket.take(1, 1)).toBe(false);
    const f = await fixture();
    try {
      await f.enroll(); const control = await f.host(); await f.register(control); const a = await f.route(control);
      for (let i = 0; i < 8; i++) a.device.binary(new Uint8Array(LIMITS.frame));
      await deadline(Promise.all([a.device.closed, a.link.closed]));
      expect((await f.command(control, 'health')).routes).toBe(0);
    } finally { await f.close(); }
  });
  test('real paused TCP host link triggers backpressure termination without retaining a route', async () => {
    const f = await fixture(); let slow: SlowPeer | undefined;
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const device = f.peer('device'); await device.open(); await authenticate(device, DEVICE, f.deviceKeys);
      const pending = await control.json();
      slow = new SlowPeer(f.port); await slow.ready;
      slow.text({ type: 'hello', id: HOST, mode: 'link', route_id: pending.route_id, device_id: DEVICE, nonce_c: base64url(randomBytes(16)) });
      const { type, ...issued } = await slow.json();
      slow.text({ type: 'proof', signature: signEnrollmentProof(issued as EnrollmentChallenge, f.hostKeys.enrollment) });
      await slow.json(); await device.json(); slow.pause();
      for (let i = 0; i < 1_024 && device.socket.readyState === WebSocket.OPEN; i++) {
        f.advance(30); device.binary(new Uint8Array(65_536));
        await Bun.sleep(1);
      }
      await deadline(device.closed);
      expect(f.logs.some(entry => entry.event === 'socket_closed' && entry.code === 1013)).toBe(true);
      expect((await f.command(control, 'health')).routes).toBe(0);
    } finally { slow?.close(); await f.close(); }
  });
  test('32 pending admissions are bounded even across independently rate-limited IP windows', async () => {
    const f = await fixture();
    try {
      const peers = [];
      for (let i = 0; i < LIMITS.pending; i++) {
        if (i % 9 === 0) f.advance(60_000);
        const p = f.peer('host'); await p.open(); peers.push(p);
      }
      f.advance(60_000);
      expect((await fetch(`http://127.0.0.1:${f.port}/v1/relay/host`)).status).toBe(503);
      await deadline(Promise.all(peers.map(p => p.closed)));
    } finally { await f.close(); }
  });
  test('malformed JSON, bodies, paths, keys and canary plaintext never enter logs or responses', async () => {
    const f = await fixture();
    const canary = 'CANARY-private-text-/Users/fixture/secrets-sk-test';
    try {
      await f.enroll(); const control = await f.host(); await f.register(control);
      const response = await f.post(path, { ...f.bootstrapBody, bootstrap: canary });
      expect(await response.text()).not.toContain(canary);
      await fetch(`http://127.0.0.1:${f.port}/${canary}`);
      await fetch(`http://127.0.0.1:${f.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalize({ canary }).repeat(3_000) });
      const peer = f.peer('device'); await peer.open(); peer.socket.send(canary); await deadline(peer.closed);
      const phase = f.peer('device'); await phase.open(); phase.socket.send('{"type":"hello","type":"proof"}'); await deadline(phase.closed);
      expect((await fetch(`http://127.0.0.1:${f.port}/healthz`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
      expect(f.logs.length).toBeGreaterThan(2);
      const logs = JSON.stringify(f.logs);
      for (const forbidden of [canary, f.bootstrap, f.bootstrapBody.enrollment_pk, '/Users/', 'ciphertext', 'signature', 'nonce']) expect(logs).not.toContain(forbidden);
      for (const entry of f.logs) expect(Object.keys(entry).sort()).toEqual(['code', 'event']);
    } finally { await f.close(); }
  });
});
