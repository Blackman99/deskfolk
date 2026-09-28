import { generateKeyPairSync, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, generateIdentity } from "@real-bot/remote";
import { isCompiledBinary } from "../platform";
import { RemoteNativeError, type LocalAction, type RemoteMaterial } from "../remote-native";

/**
 * The remote credential store the app ships with (ADR 0033).
 *
 * The sealed provider in `remote-native.ts` needs a Keychain access group and a signed, sealed
 * daemon that no build can produce yet, so it always answers `g_pack_not_verified`. This one keeps
 * the same interface with the identity in a 0600 file under the data directory. What stands in
 * for the Touch ID sheet depends on who asks: the packaged window checks the person with
 * LocalAuthentication before it may ask for a proof over its inherited channel, and a source run
 * with `REAL_BOT_DEV_REMOTE=1` asks at the terminal or the settings panel.
 */
type Persisted = { v: 1; dh: string; signing: string; enrollment: string; vapid: string; highwater: number };
type Pending = { action: LocalAction; digest: string; expires: number; proof?: string };

/**
 * Named when only source runs could use it. The packaged app shares the data directory with them,
 * so the name stays: a Mac registered and paired from source keeps its identity in the app.
 */
export const REMOTE_CREDENTIALS_DIR = "dev-remote";

const SIZES: Record<RemoteMaterial, number> = { host_identity: 64, enrollment: 32, vapid: 32, highwater: 4 };
const CHALLENGE = /^[A-Za-z0-9+/]{43}=$/;
/** Keep the window identical to the native one so timing bugs surface here too. */
const WINDOW_MS = 120_000;

/** A compiled daemon runs its modules out of `/$bunfs/` (`B:\~BUN\` on win32); source Bun never does. */
export function isCompiledDaemon(modulePath: string = import.meta.path): boolean {
  return isCompiledBinary(modulePath);
}

/** The packaged daemon's credential store; source runs get one only through the dev switch. */
export function shippedRemoteNative(dataDir: string, modulePath: string = import.meta.path): FileRemoteNative | undefined {
  return isCompiledDaemon(modulePath) ? new FileRemoteNative(join(dataDir, REMOTE_CREDENTIALS_DIR)) : undefined;
}

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
function parse(text: string): Persisted {
  let loaded: Persisted;
  try { loaded = JSON.parse(text) as Persisted; } catch { throw new RemoteNativeError("corrupt"); }
  if (!loaded || loaded.v !== 1 || !Number.isInteger(loaded.highwater) || loaded.highwater < 1 || loaded.highwater > 0xffff_ffff) {
    throw new RemoteNativeError("corrupt");
  }
  field(loaded.dh, 32); field(loaded.signing, 32); field(loaded.enrollment, 32); field(loaded.vapid, 32);
  return loaded;
}

export class FileRemoteNative {
  private readonly file: string;
  private loaded?: Persisted;
  private readonly pending = new Map<string, Pending>();
  /** Nothing touches the disk until remote is used, so a daemon that never pairs writes no key. */
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {
    this.file = join(directory, "credentials.json");
  }
  /**
   * A missing file is made on first use. A damaged one is never overwritten: it holds the only
   * copy of the identity paired devices pinned, so it surfaces as `corrupt` instead.
   */
  private load(create: boolean): Persisted | undefined {
    if (this.loaded) return this.loaded;
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RemoteNativeError("storage");
      if (!create) return;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.loaded = fresh();
      this.persist();
      return this.loaded;
    }
    this.loaded = parse(text);
    return this.loaded;
  }
  private get state(): Persisted {
    return this.load(true)!;
  }
  private set state(value: Persisted) {
    this.loaded = value;
    this.persist();
  }
  private persist(): void {
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.loaded), { mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch { throw new RemoteNativeError("storage"); }
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
    try { this.load(false); } catch (error) {
      return { enabled: false, nativeAvailable: false, diagnostic: error instanceof RemoteNativeError ? error.code : "storage" };
    }
    // `enabled` stays false: the controller only bypasses the activation gate
    // because this is not the sealed provider, never because a flag says so.
    return { enabled: false, nativeAvailable: true, diagnostic: "file_credentials" };
  }
  async read(material: RemoteMaterial): Promise<Uint8Array> {
    if (!Object.hasOwn(SIZES, material)) throw new RemoteNativeError("malformed");
    const state = this.state;
    if (material === "highwater") {
      const epoch = Buffer.alloc(4);
      epoch.writeUInt32BE(state.highwater);
      return new Uint8Array(epoch);
    }
    if (material === "host_identity") {
      return new Uint8Array(Buffer.concat([field(state.dh, 32), field(state.signing, 32)]));
    }
    return new Uint8Array(field(material === "enrollment" ? state.enrollment : state.vapid, 32));
  }
  async highwater(): Promise<number> {
    return this.state.highwater;
  }
  async advanceHighwater(expected: number, next: number): Promise<void> {
    if (!Number.isInteger(expected) || !Number.isInteger(next) || next > 0xffff_ffff) throw new RemoteNativeError("malformed");
    const state = this.state;
    if (expected !== state.highwater || next <= expected) throw new RemoteNativeError("rollback");
    this.state = { ...state, highwater: next };
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
    const state = this.state;
    if (expected !== state.highwater) throw new RemoteNativeError("rollback");
    this.take(value, challenge, proof);
    this.state = { ...fresh(), vapid: state.vapid, highwater: state.highwater + 1 };
  }

  /** What the Touch ID sheet shows for this challenge: the daemon's own words, never the page's. */
  describe(challenge: string): Pick<LocalAction, "kind" | "display"> | undefined {
    this.sweep();
    const entry = this.pending.get(challenge);
    return entry && { kind: entry.action.kind, display: entry.action.display };
  }
  /** The person approved that sheet; only a caller that checked them may ask for this. */
  authenticate(challenge: string): string {
    this.sweep();
    const entry = this.pending.get(challenge);
    if (!entry) throw new RemoteNativeError("expired");
    entry.proof ??= token();
    return entry.proof;
  }
}
