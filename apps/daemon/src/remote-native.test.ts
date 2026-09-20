import { describe, expect, test } from "bun:test";
import { RemoteNativeClient, RemoteNativeError, remoteNative, type LocalAction, type NativeRequest, type NativeResponse } from "./remote-native";

const action: LocalAction = { kind: "pair_device", digest: "a".repeat(64), display: "Fixture device: " + "b".repeat(64) };
const challenge = Buffer.alloc(32, 1).toString("base64");
const proof = Buffer.alloc(32, 2).toString("base64");
const ok = (request: NativeRequest, fields: Partial<NativeResponse> = {}): NativeResponse => ({
  v: 1, id: request.id, ok: true, ...fields,
});

describe("remote native boundary", () => {
  test("source Bun is disabled and never invokes Keychain or local authentication", async () => {
    expect(await remoteNative.capability()).toEqual({ enabled: false, nativeAvailable: false, diagnostic: "disabled" });
    await expect(remoteNative.read("host_identity")).rejects.toMatchObject({ code: "disabled" });
    await expect(remoteNative.authorizeDesktopChannel()).rejects.toMatchObject({ code: "disabled" });
  });

  test("fixture service exports raw identity keys and durable highwater without helper", async () => {
    let epoch = 1;
    const calls: string[] = [];
    const service = async (request: NativeRequest) => {
      calls.push(request.op);
      if (request.op === "advance_highwater") {
        if (request.expected !== epoch) return ok(request, { ok: false, error: "conflict" });
        epoch = request.next!;
        return ok(request);
      }
      const bytes = request.material === "highwater" ? Buffer.alloc(4) : Buffer.alloc(64, 9);
      if (bytes.length === 4) bytes.writeUInt32BE(epoch);
      return ok(request, { value: bytes.toString("base64") });
    };
    const first = new RemoteNativeClient(service);
    expect((await first.read("host_identity")).length).toBe(64);
    await first.advanceHighwater(1, 2);
    const restarted = new RemoteNativeClient(service);
    expect(await restarted.highwater()).toBe(2);
    await expect(restarted.advanceHighwater(1, 3)).rejects.toMatchObject({ code: "conflict" });
    await expect(restarted.advanceHighwater(2, 1)).rejects.toMatchObject({ code: "rollback" });
    expect(calls).not.toContain("confirm");
    expect(calls).not.toContain("create");
  });

  test.each(["wrong_identity", "wrong_user", "locked", "cancelled", "expired", "entitlement", "runtime_unsealed"] as const)("propagates %s without fallback or retry", async (error) => {
    let calls = 0;
    const client = new RemoteNativeClient(async (request) => { calls++; return ok(request, { ok: false, error }); });
    await expect(client.consume(action, challenge, proof)).rejects.toMatchObject({ code: error });
    expect(calls).toBe(1);
  });

  test("prepare and consume bind the full action and one-time proof", async () => {
    const seen: NativeRequest[] = [];
    const client = new RemoteNativeClient(async (request) => {
      seen.push(request);
      return ok(request, request.op === "prepare" ? { value: challenge, expiresIn: 120 } : {});
    });
    expect(await client.prepare(action)).toEqual({ challenge, expiresIn: 120 });
    await client.consume(action, challenge, proof);
    expect(seen[1]).toMatchObject({ v: 1, op: "consume", action, challenge, proof });
    expect(seen[0]!.id).not.toBe(seen[1]!.id);
  });

  test("rejects malformed responses, identity sizes, versions and request confusion", async () => {
    const cases: Array<(request: NativeRequest) => NativeResponse> = [
      (r) => ({ ...ok(r), v: 2 } as unknown as NativeResponse),
      (r) => ({ ...ok(r), id: crypto.randomUUID() }),
      (r) => ({ ...ok(r), error: "locked" }),
      (r) => ({ ...ok(r), value: "not-a-key" }),
      (r) => ({ ...ok(r), value: Buffer.alloc(63).toString("base64") }),
    ];
    for (const response of cases) {
      const client = new RemoteNativeClient(async (request) => response(request));
      await expect(client.read("host_identity")).rejects.toBeInstanceOf(RemoteNativeError);
    }
  });

  test("validates native namespace, uint32 range and display before I/O", async () => {
    let calls = 0;
    const client = new RemoteNativeClient(async (request) => { calls++; return ok(request); });
    await expect(client.read("endpoint-api-key" as never)).rejects.toMatchObject({ code: "malformed" });
    await expect(client.advanceHighwater(1, 2 ** 32)).rejects.toMatchObject({ code: "malformed" });
    await expect(client.prepare({ ...action, display: "\u202efake" })).rejects.toMatchObject({ code: "malformed" });
    await expect(client.prepare({ ...action, digest: "123" })).rejects.toMatchObject({ code: "malformed" });
    await expect(client.prepare({ ...action, kind: "unknown" as never })).rejects.toMatchObject({ code: "malformed" });
    await expect(client.consume(action, "fake", proof)).rejects.toMatchObject({ code: "malformed" });
    await expect(client.reset(action, challenge, proof, 1)).rejects.toMatchObject({ code: "malformed" });
    expect(calls).toBe(0);
  });

  test("prepare and consume accept renew_first_uv and recover_trust and reject unknown kinds", async () => {
    const seen: NativeRequest[] = [];
    const client = new RemoteNativeClient(async (request) => {
      seen.push(request);
      return ok(request, request.op === "prepare" ? { value: challenge, expiresIn: 120 } : {});
    });
    for (const kind of ["renew_first_uv", "recover_trust"] as const) {
      const next: LocalAction = { ...action, kind };
      expect(await client.prepare(next)).toEqual({ challenge, expiresIn: 120 });
      await client.consume(next, challenge, proof);
      expect(seen.at(-1)).toMatchObject({ op: "consume", action: next });
    }
    await expect(client.prepare({ ...action, kind: "pair_again" as never })).rejects.toMatchObject({ code: "malformed" });
    await expect(client.consume({ ...action, kind: "unknown" as never }, challenge, proof)).rejects.toMatchObject({ code: "malformed" });
    expect(seen).toHaveLength(4);
  });

  test("native availability does not enable remote or claim G-pack", async () => {
    const client = new RemoteNativeClient(async (request) => ok(request));
    expect(await client.capability()).toEqual({ enabled: false, nativeAvailable: true, diagnostic: "g_pack_not_verified" });
  });
});
