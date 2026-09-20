import { encode } from 'cborg';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DeviceSession, HostSession, Reassembler, base64url, canonicalHash, concat, createUvChallenge, fragmentMessage, fromBase64url, generateIdentity, hex, identityPublic, u32, utf8, verifyAssertion } from '../../src/index.ts';

const output = document.querySelector('output')!;
const button = document.querySelector('button')!;
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const start = performance.now();
    const host = generateIdentity(), device = generateIdentity(), claimed = new Set<string>();
    const binding = { hostId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', deviceId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', trustEpoch: 7, protocolVersion: 1, relayOrigin: 'https://relay.example.com' };
    const d = new DeviceSession({ binding, identity: device, peer: identityPublic(host) });
    const h = new HostSession({ binding, identity: host, peer: identityPublic(device), recentRttMs: 1, isTrusted: () => true,
      claimReplay: c => { const k = hex(c.ephemeralPublic); if (claimed.has(k)) return false; claimed.add(k); return true; } });
    d.accept(h.accept(d.start()));
    const handshakeMs = performance.now() - start;
    const body = new Uint8Array(1024 * 1024).fill(31), toHost = new Reassembler(), toDevice = new Reassembler();
    let received: Uint8Array | undefined;
    for (const frame of fragmentMessage(8, body)) {
      const decoded = h.receive(d.send(frame.type, frame.body));
      received = toHost.accept(decoded.body, performance.now())?.body;
    }
    if (!received || canonicalHash(Array.from(received.subarray(0, 32))) !== canonicalHash(Array.from(body.subarray(0, 32)))) throw new Error('host reassembly');
    for (const frame of fragmentMessage(8, received)) {
      const decoded = d.receive(h.send(frame.type, frame.body));
      received = toDevice.accept(decoded.body, performance.now())?.body;
    }
    if (!received || received.length !== body.length || received.some(v => v !== 31)) throw new Error('device reassembly');
    const noiseMs = performance.now() - start;
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const cose = encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64url(jwk.x!)], [-3, fromBase64url(jwk.y!)]]));
    const operation = { deviceId: binding.deviceId, sessionId: base64url(new Uint8Array(16)), trustEpoch: 7,
      requestId: 'smoke', action: 'runtime.restart', targetId: binding.hostId, operationDigest: canonicalHash({ force: false }) };
    const record = createUvChallenge(operation, 'assertion', 1000);
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', origin: binding.relayOrigin, challenge: record.challenge }));
    const authenticatorData = concat(sha256(utf8('relay.example.com')), Uint8Array.of(5), u32(1));
    const signature = p256.Signature.fromBytes(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
      new Uint8Array(concat(authenticatorData, sha256(clientDataJSON)))))).toBytes('der');
    const credentialId = base64url(new Uint8Array(32));
    await verifyAssertion({ credentialId, clientDataJSON, authenticatorData, signature }, { credentialId, cosePublicKey: cose, signCount: 0 },
      { record, expectedBinding: operation, nowUnix: 1001, rpId: 'relay.example.com', relayOrigin: binding.relayOrigin }, () => true);
    const corrupt = d.send(1, utf8('{}')); corrupt[corrupt.length - 1] ^= 1;
    let rejected = false; try { h.receive(corrupt); } catch { rejected = true; }
    if (!rejected || h.ready) throw new Error('tamper not closed');
    output.textContent = JSON.stringify({ status: 'PASS', handshakeMs: +handshakeMs.toFixed(2), noiseRoundtrip1MiBMs: +noiseMs.toFixed(2),
      webCryptoES256: 'PASS (generated software key, not authenticator UV)', tamperClosed: true, realDevice: 'NOTRUN', externalAudit: 'NOTRUN' }, null, 2);
    output.dataset.status = 'PASS';
  } catch (e) { output.textContent = String(e); output.dataset.status = 'FAIL'; }
  finally { button.disabled = false; }
});
