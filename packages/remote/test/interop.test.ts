import { expect, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { DeviceSession, HostSession, MAX_LOGICAL_MESSAGE, Reassembler, encodePrologue, fragmentMessage, hex, unhex } from '../src/index.ts';
import { binding, deviceKeys, devicePublic, hostKeys, hostPublic, replayStore } from './helpers.ts';

for (const rustInitiator of [false, true]) {
  test(`independent snow 0.10.0 ${rustInitiator ? 'initiator' : 'responder'} verifies real prologue + Hello and 1MiB duplex`, async () => {
    const peer = Bun.spawn([new URL('./snow/target/debug/snow-peer', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = peer.stdout.getReader();
    let buffer = '';
    async function read(): Promise<Record<string, unknown>> {
      while (!buffer.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('snow peer exited: ' + await new Response(peer.stderr).text());
        buffer += new TextDecoder().decode(chunk.value);
      }
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      return JSON.parse(line);
    }
    function write(value: unknown): void { peer.stdin.write(JSON.stringify(value) + '\n'); peer.stdin.flush(); }
    try {
      const local = rustInitiator ? deviceKeys : hostKeys, remote = rustInitiator ? hostPublic : devicePublic;
      const ephemeral = new Uint8Array(32).fill(rustInitiator ? 91 : 92);
      write({ initiator: rustInitiator, local: hex(local.dh), remote: hex(remote.dh), signing: hex(local.signing),
        peer_signing: hex(remote.signing), prologue: hex(encodePrologue(binding)), ephemeral: hex(ephemeral), ephemeral_public: hex(x25519.getPublicKey(ephemeral)) });
      const session = rustInitiator
        ? new HostSession({ binding, identity: hostKeys, peer: devicePublic, isTrusted: () => true, claimReplay: replayStore(), recentRttMs: 1 })
        : new DeviceSession({ binding, identity: deviceKeys, peer: hostPublic });
      if (session instanceof DeviceSession) {
        write({ message: hex(session.start()) });
        session.accept(unhex((await read()).message as string));
      } else write({ message: hex(session.accept(unhex((await read()).message as string))) });
      expect((await read()).ready).toBe(true);
      const plain = new Uint8Array(MAX_LOGICAL_MESSAGE).fill(0x5a), assembly = new Reassembler();
      let complete: Uint8Array | undefined;
      for (const [index, frame] of fragmentMessage(8, plain).entries()) {
        write({ message: hex(session.send(frame.type, frame.body)) });
        const response = await read();
        const decoded = session.receive(unhex(response.message as string));
        expect(decoded.seq).toBe(BigInt(index));
        complete = assembly.accept(decoded.body, index)?.body;
      }
      expect(complete).toEqual(plain);
      write({ quit: true }); peer.stdin.end();
      expect(await peer.exited).toBe(0);
    } finally { peer.kill(); }
  }, 30_000);
}
