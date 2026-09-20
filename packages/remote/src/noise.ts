import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { bytes, check, concat, EMPTY, randomBytes, U64_MAX, utf8 } from './bytes.ts';

export const NOISE_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_BLAKE2s';
export const MAX_NOISE_MESSAGE = 65535;

function hkdf(key: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const output = nobleHkdf(blake2s, input, key, EMPTY, 64);
  return [output.subarray(0, 32), output.subarray(32)];
}

export class CipherState {
  #key: Uint8Array;
  #nonce = 0n;
  #closed = false;
  constructor(key: Uint8Array) { this.#key = new Uint8Array(bytes(key, 32)); }
  get nonce(): bigint { return this.#nonce; }
  #crypt(input: Uint8Array, ad: Uint8Array, decrypt: boolean): Uint8Array {
    try {
      check(!this.#closed && this.#nonce < U64_MAX, 'cipher closed or nonce exhausted');
      check(input.length + (decrypt ? 0 : 16) <= MAX_NOISE_MESSAGE, 'Noise message limit');
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setBigUint64(4, this.#nonce, true);
      const cipher = chacha20poly1305(this.#key, nonce, ad);
      const out = decrypt ? cipher.decrypt(input) : cipher.encrypt(input);
      this.#nonce++;
      return out;
    } catch (error) { this.destroy(); throw error; }
  }
  encrypt(input: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array { return this.#crypt(input, ad, false); }
  decrypt(input: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array { return this.#crypt(input, ad, true); }
  destroy(): void { this.#key.fill(0); this.#closed = true; }
}

// Internal standard state machine; the public API adds pinned Hello authentication.
export class NoiseIK {
  #h: Uint8Array;
  #ck: Uint8Array;
  #cipher?: CipherState;
  #s: Uint8Array;
  #e: Uint8Array;
  #rs?: Uint8Array;
  #re?: Uint8Array;
  #step = 0;
  #closed = false;
  constructor(
    readonly initiator: boolean,
    staticSecret: Uint8Array,
    prologue: Uint8Array,
    remoteStatic?: Uint8Array,
    ephemeralSecret = randomBytes(32),
  ) {
    // Buffer.slice aliases caller storage; cleanup must only erase owned copies.
    this.#s = new Uint8Array(bytes(staticSecret, 32));
    this.#e = new Uint8Array(bytes(ephemeralSecret, 32));
    this.#rs = remoteStatic && new Uint8Array(bytes(remoteStatic, 32));
    check(!initiator || this.#rs, 'IK requires pinned responder static');
    const name = utf8(NOISE_PROTOCOL);
    this.#h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : blake2s(name);
    this.#ck = new Uint8Array(this.#h);
    this.#mixHash(prologue);
    this.#mixHash(initiator ? this.#rs! : x25519.getPublicKey(this.#s));
  }
  get ephemeralPublic(): Uint8Array { return x25519.getPublicKey(this.#e); }
  get remoteStatic(): Uint8Array | undefined { return this.#rs && new Uint8Array(this.#rs); }
  get remoteEphemeral(): Uint8Array | undefined { return this.#re && new Uint8Array(this.#re); }
  get handshakeHash(): Uint8Array { return new Uint8Array(this.#h); }
  #mixHash(input: Uint8Array): void { this.#h = blake2s(concat(this.#h, input)); }
  #mixKey(secret: Uint8Array, publicKey: Uint8Array): void {
    const dh = x25519.getSharedSecret(secret, publicKey);
    const [ck, key] = hkdf(this.#ck, dh);
    this.#ck.fill(0); this.#ck = ck;
    this.#cipher?.destroy(); this.#cipher = new CipherState(key);
    dh.fill(0); key.fill(0);
  }
  #encrypt(input: Uint8Array): Uint8Array {
    const out = this.#cipher!.encrypt(input, this.#h); this.#mixHash(out); return out;
  }
  #decrypt(input: Uint8Array): Uint8Array {
    const out = this.#cipher!.decrypt(input, this.#h); this.#mixHash(input); return out;
  }
  writeMessage(payload: Uint8Array): Uint8Array {
    try {
      check(!this.#closed && (this.initiator ? this.#step === 0 : this.#step === 1), 'unexpected Noise write');
      check(payload.length <= MAX_NOISE_MESSAGE - (this.initiator ? 96 : 48), 'Noise message limit');
      const e = this.ephemeralPublic;
      this.#mixHash(e);
      let out: Uint8Array;
      if (this.initiator) {
        this.#mixKey(this.#e, this.#rs!);
        const s = this.#encrypt(x25519.getPublicKey(this.#s));
        this.#mixKey(this.#s, this.#rs!);
        out = concat(e, s, this.#encrypt(payload));
      } else {
        this.#mixKey(this.#e, this.#re!);
        this.#mixKey(this.#e, this.#rs!);
        out = concat(e, this.#encrypt(payload));
      }
      this.#step++;
      return out;
    } catch (error) { this.destroy(); throw error; }
  }
  readMessage(message: Uint8Array): Uint8Array {
    try {
      check(!this.#closed && (this.initiator ? this.#step === 1 : this.#step === 0), 'unexpected Noise read');
      check(message.length >= (this.initiator ? 48 : 96) && message.length <= MAX_NOISE_MESSAGE, 'Noise message length');
      this.#re = new Uint8Array(message.subarray(0, 32));
      this.#mixHash(this.#re);
      let payload: Uint8Array;
      if (this.initiator) {
        this.#mixKey(this.#e, this.#re);
        this.#mixKey(this.#s, this.#re);
        payload = this.#decrypt(message.subarray(32));
      } else {
        this.#mixKey(this.#s, this.#re);
        this.#rs = this.#decrypt(message.subarray(32, 80));
        this.#mixKey(this.#s, this.#rs);
        payload = this.#decrypt(message.subarray(80));
      }
      this.#step++;
      return payload;
    } catch (error) { this.destroy(); throw error; }
  }
  split(): { send: CipherState; receive: CipherState } {
    try {
      check(!this.#closed && this.#step === 2, 'Split required');
      const [a, b] = hkdf(this.#ck, EMPTY);
      const send = new CipherState(this.initiator ? a : b);
      const receive = new CipherState(this.initiator ? b : a);
      a.fill(0); b.fill(0); this.destroy();
      return { send, receive };
    } catch (error) { this.destroy(); throw error; }
  }
  destroy(): void {
    this.#closed = true; this.#s.fill(0); this.#e.fill(0); this.#ck.fill(0); this.#cipher?.destroy();
  }
}
