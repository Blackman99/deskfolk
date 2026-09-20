import { dirname, join } from "node:path";

export type RemoteMaterial = "host_identity" | "enrollment" | "vapid" | "highwater";
export type LocalAction = {
  kind: "pair_device" | "reset_identity" | "change_relay" | "change_workspace";
  /** SHA-256 of the complete canonical action payload, including the device keys / new target. */
  digest: string;
  display: string;
};
const errorCodes = [
  "native_library_unavailable", "runtime_unsealed", "disabled", "unsigned", "wrong_identity", "wrong_user", "entitlement", "locked", "not_found",
  "conflict", "corrupt", "storage", "version", "malformed", "too_large", "unavailable", "busy",
  "timeout", "authentication", "cancelled", "expired", "proof", "rollback",
] as const;
export type NativeErrorCode = typeof errorCodes[number];

export class RemoteNativeError extends Error {
  constructor(readonly code: NativeErrorCode) { super(`remote_native:${code}`); }
}

export type NativeRequest = {
  v: 1; id: string; op: string; action?: LocalAction; challenge?: string;
  proof?: string; material?: RemoteMaterial; expected?: number; next?: number;
};
export type NativeResponse = {
  v: 1; id: string; ok: boolean; error?: NativeErrorCode; value?: string; expiresIn?: number;
};
export type NativeTransport = (request: NativeRequest) => Promise<NativeResponse>;
const LIMIT = 8192;
const codes = new Set<NativeErrorCode>(errorCodes);

function epoch(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) throw new RemoteNativeError("malformed");
}
function action(value: LocalAction): void {
  if (!["pair_device", "reset_identity", "change_relay", "change_workspace"].includes(value.kind)
    || !/^[0-9a-f]{64}$/.test(value.digest) || !value.display
    || Buffer.byteLength(value.display) > 1024 || /[\p{Cc}\p{Cf}]/u.test(value.display)) {
    throw new RemoteNativeError("malformed");
  }
}
function token(value: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new RemoteNativeError("malformed");
}

/** No HTTP route: only the authenticated daemon's remote dispatcher may consume this interface. */
export class RemoteNativeClient {
  constructor(private readonly transport: NativeTransport) {}
  private async call(fields: Omit<NativeRequest, "id" | "v">): Promise<NativeResponse> {
    const request: NativeRequest = { v: 1, id: crypto.randomUUID(), ...fields };
    const response = await this.transport(request);
    if (!response || response.v !== 1 || response.id !== request.id || typeof response.ok !== "boolean") {
      throw new RemoteNativeError("malformed");
    }
    if (!response.ok) throw new RemoteNativeError(codes.has(response.error!) ? response.error! : "unavailable");
    if (response.error !== undefined) throw new RemoteNativeError("malformed");
    return response;
  }
  async capability(): Promise<{ enabled: false; nativeAvailable: boolean; diagnostic: string }> {
    try {
      await this.call({ op: "capability" });
      return { enabled: false, nativeAvailable: true, diagnostic: "g_pack_not_verified" };
    } catch (error) {
      return { enabled: false, nativeAvailable: false,
        diagnostic: error instanceof RemoteNativeError ? error.code : "unavailable" };
    }
  }
  async read(material: RemoteMaterial): Promise<Uint8Array> {
    const sizes = { host_identity: 64, enrollment: 32, vapid: 32, highwater: 4 };
    if (!Object.hasOwn(sizes, material)) throw new RemoteNativeError("malformed");
    const { value } = await this.call({ op: "read", material });
    const data = Buffer.from(value ?? "", "base64");
    if (typeof value !== "string" || data.toString("base64") !== value || data.length !== sizes[material]) {
      throw new RemoteNativeError("corrupt");
    }
    return data;
  }
  async highwater(): Promise<number> {
    const bytes = await this.read("highwater");
    const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    epoch(value);
    return value;
  }
  /** Persist before committing the DB epoch; a failed/unknown write must stop remote admission. */
  async advanceHighwater(expected: number, next: number): Promise<void> {
    epoch(expected); epoch(next);
    if (next <= expected) throw new RemoteNativeError("rollback");
    await this.call({ op: "advance_highwater", expected, next });
  }
  async prepare(value: LocalAction): Promise<{ challenge: string; expiresIn: 120 }> {
    action(value);
    const response = await this.call({ op: "prepare", action: value });
    token(response.value ?? "");
    if (response.expiresIn !== 120) throw new RemoteNativeError("malformed");
    return { challenge: response.value!, expiresIn: 120 };
  }
  async consume(value: LocalAction, challenge: string, proof: string): Promise<void> {
    action(value); token(challenge); token(proof);
    await this.call({ op: "consume", action: value, challenge, proof });
  }
  async reset(value: LocalAction, challenge: string, proof: string, expected: number): Promise<void> {
    action(value); token(challenge); token(proof); epoch(expected);
    if (value.kind !== "reset_identity") throw new RemoteNativeError("malformed");
    await this.call({ op: "reset", action: value, challenge, proof, expected });
  }
}

let transport: Promise<NativeTransport> | undefined;
async function loadNative(): Promise<NativeTransport> {
  // Source Bun is never a credential principal, even if renamed to match the daemon.
  if (process.platform !== "darwin" || !import.meta.path.startsWith("/$bunfs/")) {
    throw new RemoteNativeError("disabled");
  }
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const symbols = {
    rb_remote_call_v1: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  } as const;
  const library = (() => {
    try { return dlopen(join(dirname(process.execPath), "libRemoteCredentials.dylib"), symbols); }
    catch { throw new RemoteNativeError("native_library_unavailable"); }
  })();
  return async (request) => {
    const input = Buffer.from(JSON.stringify(request));
    if (input.length > LIMIT) throw new RemoteNativeError("too_large");
    const output = Buffer.alloc(LIMIT);
    try {
      const count = library.symbols.rb_remote_call_v1(ptr(input), input.length, ptr(output), output.length);
      if (count <= 0 || count > LIMIT) throw new RemoteNativeError("unavailable");
      try { return JSON.parse(output.subarray(0, count).toString("utf8")) as NativeResponse; }
      catch { throw new RemoteNativeError("malformed"); }
    } finally { input.fill(0); output.fill(0); }
  };
}

export const remoteNative = new RemoteNativeClient(async (request) => {
  try { return await (await (transport ??= loadNative()))(request); }
  catch (error) {
    if (error instanceof RemoteNativeError) throw error;
    throw new RemoteNativeError("unavailable");
  }
});
