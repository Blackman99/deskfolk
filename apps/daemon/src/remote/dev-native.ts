import { generateKeyPairSync, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, generateIdentity } from "@real-bot/remote";
import { RemoteNativeError, type LocalAction, type RemoteMaterial } from "../remote-native";

/**
 * Development stand-in for the sealed native credential runtime.
 *
 * The shipped provider in `remote-native.ts` only loads inside a compiled,
 * signed daemon and always answers `g_pack_not_verified`, so no production
 * build can turn remote on before that gate passes. This provider keeps the
 * same interface so the protocol can be exercised end to end while building:
 * the identity lives in a 0600 file under the data directory instead of the
 * Keychain, and a local confirmation is a terminal prompt instead of Touch ID.
 * `createDevRemote` refuses to hand it out from a packaged build.
 */
type Persisted = { v: 1; dh: string; signing: string; enrollment: string; vapid: string; highwater: number };
type Pending = { action: LocalAction; digest: string; expires: number; proof?: string };

const SIZES: Record<RemoteMaterial, number> = { host_identity: 64, enrollment: 32, vapid: 32, highwater: 4 };
const CHALLENGE = /^[A-Za-z0-9+/]{43}=$/;
/** Keep the window identical to the native one so timing bugs surface here too. */
const WINDOW_MS = 120_000;

function token(): string {
  return Buffer.from(nodeRandomBytes(32)).toString("base64");
}
function vapidSecret(): Buffer {
  for (;;) {
    const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
    const raw = Buffer.from(jwk.d!, "base64url");
    if (raw.length === 32) return raw;
  }
}
function fresh(): Persisted {
  const keys = generateIdentity();
  return { v: 1, dh: Buffer.from(keys.dh).toString("base64"), signing: Buffer.from(keys.signing).toString("base64"),
    enrollment: Buffer.from(keys.enrollment).toString("base64"), vapid: vapidSecret().toString("base64"), highwater: 1 };
}
function field(value: unknown, bytes: number): Buffer {
  if (typeof value !== "string") throw new RemoteNativeError("corrupt");
  const raw = Buffer.from(value, "base64");
  if (raw.length !== bytes || raw.toString("base64") !== value) throw new RemoteNativeError("corrupt");
  return raw;
}

export class DevRemoteNative {
  private readonly file: string;
  private state: Persisted;
  private readonly pending = new Map<string, Pending>();
  constructor(directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "credentials.json");
    let loaded: Persisted | undefined;
    try { loaded = JSON.parse(readFileSync(this.file, "utf8")) as Persisted; } catch { loaded = undefined; }
    if (loaded && loaded.v === 1 && Number.isInteger(loaded.highwater) && loaded.highwater >= 1) {
      field(loaded.dh, 32); field(loaded.signing, 32); field(loaded.enrollment, 32); field(loaded.vapid, 32);
      this.state = loaded;
    } else {
      this.state = fresh();
      this.persist();
    }
  }
  private persist(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
  private sweep(): void {
    const now = this.now();
    for (const [challenge, entry] of this.pending) if (now >= entry.expires) this.pending.delete(challenge);
  }
  private take(value: LocalAction, challenge: string, proof: string): void {
    this.sweep();
    if (!CHALLENGE.test(challenge) || !CHALLENGE.test(proof)) throw new RemoteNativeError("malformed");
    const entry = this.pending.get(challenge);
    this.pending.delete(challenge);
    // A proof is only valid for the exact action the prompt displayed.
    if (!entry || entry.proof !== proof || entry.digest !== canonicalHash(value)) throw new RemoteNativeError("proof");
  }

  async capability(): Promise<{ enabled: false; nativeAvailable: boolean; diagnostic: string }> {
    // `enabled` stays false: the controller only bypasses the activation gate
    // because this is not the shipped provider, never because a flag says so.
    return { enabled: false, nativeAvailable: true, diagnostic: "dev_native" };
  }
  async read(material: RemoteMaterial): Promise<Uint8Array> {
    if (!Object.hasOwn(SIZES, material)) throw new RemoteNativeError("malformed");
    if (material === "highwater") {
      const epoch = Buffer.alloc(4);
      epoch.writeUInt32BE(this.state.highwater);
      return new Uint8Array(epoch);
    }
    if (material === "host_identity") {
      return new Uint8Array(Buffer.concat([field(this.state.dh, 32), field(this.state.signing, 32)]));
    }
    return new Uint8Array(field(material === "enrollment" ? this.state.enrollment : this.state.vapid, 32));
  }
  async highwater(): Promise<number> {
    return this.state.highwater;
  }
  async advanceHighwater(expected: number, next: number): Promise<void> {
    if (!Number.isInteger(expected) || !Number.isInteger(next) || next > 0xffff_ffff) throw new RemoteNativeError("malformed");
    if (expected !== this.state.highwater || next <= expected) throw new RemoteNativeError("rollback");
    this.state = { ...this.state, highwater: next };
    this.persist();
  }
  async prepare(value: LocalAction): Promise<{ challenge: string; expiresIn: 120 }> {
    this.sweep();
    if (this.pending.size >= 8) throw new RemoteNativeError("busy");
    const challenge = token();
    this.pending.set(challenge, { action: value, digest: canonicalHash(value), expires: this.now() + WINDOW_MS });
    return { challenge, expiresIn: 120 };
  }
  async consume(value: LocalAction, challenge: string, proof: string): Promise<void> {
    this.take(value, challenge, proof);
  }
  async reset(value: LocalAction, challenge: string, proof: string, expected: number): Promise<void> {
    if (value.kind !== "reset_identity") throw new RemoteNativeError("malformed");
    if (expected !== this.state.highwater) throw new RemoteNativeError("rollback");
    this.take(value, challenge, proof);
    this.state = { ...fresh(), vapid: this.state.vapid, highwater: this.state.highwater + 1 };
    this.persist();
  }

  /** Dev-only: what the Touch ID sheet would have shown for this challenge. */
  describe(challenge: string): string | undefined {
    this.sweep();
    return this.pending.get(challenge)?.action.display;
  }
  /** Dev-only: stands in for the user approving that sheet. */
  authenticate(challenge: string): string {
    this.sweep();
    const entry = this.pending.get(challenge);
    if (!entry) throw new RemoteNativeError("expired");
    entry.proof ??= token();
    return entry.proof;
  }
}
