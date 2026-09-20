import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytes, check, concat, equal, randomBytes, utf8 } from './bytes.ts';
import { decodeFrame, encodeFrame, encodePrologue } from './codec.ts';
import type { FrameType, SessionBinding, TransportFrame } from './codec.ts';
import { NoiseIK } from './noise.ts';
import type { CipherState } from './noise.ts';

export const REMOTE_DEFAULT_ENABLED = false;
export interface IdentitySecrets { dh: Uint8Array; signing: Uint8Array; enrollment: Uint8Array }
export interface IdentityPublic { dh: Uint8Array; signing: Uint8Array; enrollment: Uint8Array }
export function generateIdentity(): IdentitySecrets {
  return { dh: randomBytes(32), signing: randomBytes(32), enrollment: randomBytes(32) };
}
export function identityPublic(keys: IdentitySecrets): IdentityPublic {
  bytes(keys.dh, 32); bytes(keys.signing, 32); bytes(keys.enrollment, 32);
  check(!equal(keys.dh, keys.signing) && !equal(keys.dh, keys.enrollment) && !equal(keys.signing, keys.enrollment), 'identity keys must be independent');
  return { dh: x25519.getPublicKey(keys.dh), signing: ed25519.getPublicKey(keys.signing), enrollment: ed25519.getPublicKey(keys.enrollment) };
}
export interface ReplayClaim {
  deviceId: string;
  ephemeralPublic: Uint8Array;
  sessionId: Uint8Array;
  minimumTtlMs: number;
}
export interface SessionOptions {
  binding: SessionBinding;
  identity: IdentitySecrets;
  peer: Pick<IdentityPublic, 'dh' | 'signing'>;
}
export interface HostSessionOptions extends SessionOptions {
  isTrusted: () => boolean;
  claimReplay: (claim: ReplayClaim) => boolean;
  recentRttMs: number;
}

abstract class Session {
  protected noise: NoiseIK;
  protected prologue: Uint8Array;
  protected signing: Uint8Array;
  protected peerSigning: Uint8Array;
  protected peerDh: Uint8Array;
  protected sessionId?: Uint8Array;
  protected transport?: { send: CipherState; receive: CipherState };
  protected closed = false;
  constructor(options: SessionOptions, initiator: boolean) {
    identityPublic(options.identity);
    this.prologue = encodePrologue(options.binding);
    this.signing = new Uint8Array(options.identity.signing);
    this.peerSigning = new Uint8Array(bytes(options.peer.signing, 32));
    this.peerDh = new Uint8Array(bytes(options.peer.dh, 32));
    this.noise = new NoiseIK(initiator, options.identity.dh, this.prologue, initiator ? this.peerDh : undefined);
  }
  get ready(): boolean { return !this.closed && this.transport !== undefined; }
  get authenticatedSessionId(): Uint8Array {
    check(this.ready && this.sessionId, 'session is not authenticated');
    return new Uint8Array(this.sessionId);
  }
  protected guard<T>(operation: () => T): T {
    try { check(!this.closed, 'session closed'); return operation(); }
    catch (error) { this.close(); throw error; }
  }
  protected assertTrust(): void {}
  send(type: FrameType, body: Uint8Array): Uint8Array {
    return this.guard(() => {
      check(this.transport && this.sessionId, 'transport before Split'); this.assertTrust();
      const message = this.transport.send.encrypt(encodeFrame({ sessionId: this.sessionId, seq: this.transport.send.nonce, type, body }));
      if (type === 7) this.close();
      return message;
    });
  }
  receive(message: Uint8Array): TransportFrame {
    return this.guard(() => {
      check(this.transport && this.sessionId, 'transport before Split'); this.assertTrust();
      const expected = this.transport.receive.nonce;
      const frame = decodeFrame(this.transport.receive.decrypt(message));
      check(equal(frame.sessionId, this.sessionId) && frame.seq === expected, 'session or sequence mismatch');
      if (frame.type === 7) this.close();
      return frame;
    });
  }
  close(): void {
    this.closed = true; this.noise.destroy(); this.signing.fill(0);
    this.transport?.send.destroy(); this.transport?.receive.destroy();
  }
  protected finish(): void { this.transport = this.noise.split(); this.signing.fill(0); }
}

export class DeviceSession extends Session {
  #started = false;
  #message1Hash?: Uint8Array;
  constructor(options: SessionOptions) { super(options, true); }
  start(): Uint8Array {
    return this.guard(() => {
      check(!this.#started, 'handshake already started'); this.#started = true;
      this.sessionId = randomBytes(16);
      const signature = ed25519.sign(concat(utf8('RB-HELLO-I'), this.prologue, this.noise.ephemeralPublic, this.sessionId), this.signing);
      const message = this.noise.writeMessage(concat(this.sessionId, ed25519.getPublicKey(this.signing), signature));
      this.#message1Hash = this.noise.handshakeHash;
      return message;
    });
  }
  accept(message2: Uint8Array): void {
    this.guard(() => {
      check(this.#started && !this.transport && message2.length === 144, 'invalid responder Hello');
      const payload = this.noise.readMessage(message2);
      check(payload.length === 96 && equal(payload.subarray(0, 32), this.peerSigning), 'host identity mismatch');
      check(ed25519.verify(payload.subarray(32), concat(utf8('RB-HELLO-R'), this.prologue,
        this.noise.remoteEphemeral!, this.sessionId!, this.#message1Hash!), this.peerSigning, { zip215: false }), 'invalid host Hello signature');
      this.finish();
    });
  }
}

export class HostSession extends Session {
  #isTrusted: () => boolean;
  #claimReplay: HostSessionOptions['claimReplay'];
  #deviceId: string;
  #ttl: number;
  constructor(options: HostSessionOptions) {
    super(options, false);
    check(typeof options.isTrusted === 'function' && typeof options.claimReplay === 'function', 'host authorization hooks required');
    check(Number.isFinite(options.recentRttMs) && options.recentRttMs >= 0 && options.recentRttMs <= 60_000, 'invalid RTT');
    this.#isTrusted = options.isTrusted; this.#claimReplay = options.claimReplay;
    this.#deviceId = options.binding.deviceId; this.#ttl = Math.max(120_000, 2 * options.recentRttMs);
  }
  protected override assertTrust(): void { check(this.#isTrusted() === true, 'device revoked or trust epoch changed'); }
  accept(message1: Uint8Array): Uint8Array {
    return this.guard(() => {
      check(!this.transport && message1.length === 208, 'invalid initiator Hello'); this.assertTrust();
      const payload = this.noise.readMessage(message1);
      check(payload.length === 112 && equal(this.noise.remoteStatic!, this.peerDh), 'device static identity mismatch');
      this.sessionId = new Uint8Array(payload.subarray(0, 16));
      check(equal(payload.subarray(16, 48), this.peerSigning), 'device signing identity mismatch');
      check(ed25519.verify(payload.subarray(48), concat(utf8('RB-HELLO-I'), this.prologue,
        this.noise.remoteEphemeral!, this.sessionId), this.peerSigning, { zip215: false }), 'invalid device Hello signature');
      check(this.#claimReplay({ deviceId: this.#deviceId, ephemeralPublic: this.noise.remoteEphemeral!,
        sessionId: new Uint8Array(this.sessionId), minimumTtlMs: this.#ttl }) === true, 'replayed initiator Hello');
      const signature = ed25519.sign(concat(utf8('RB-HELLO-R'), this.prologue, this.noise.ephemeralPublic,
        this.sessionId, this.noise.handshakeHash), this.signing);
      const response = this.noise.writeMessage(concat(ed25519.getPublicKey(this.signing), signature));
      this.finish();
      return response;
    });
  }
}
