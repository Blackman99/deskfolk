import { afterEach, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevRemoteNative } from "./dev-native";
import { createDevRemote, devDispatch, devPairingDispatch, devRemoteAllowed, devSocketPath } from "./dev-setup";
import type { RemoteController } from "./controller";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rb-dev-remote-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const action = (display = "iPhone (iOS) · abcd") => ({ kind: "pair_device" as const, digest: "a".repeat(64), display });

test("reads the material sizes the controller expects and keeps them across restarts", async () => {
  const dir = root();
  const native = new DevRemoteNative(dir);
  expect(await native.capability()).toEqual({ enabled: false, nativeAvailable: true, diagnostic: "dev_native" });
  expect((await native.read("host_identity")).length).toBe(64);
  expect((await native.read("enrollment")).length).toBe(32);
  expect((await native.read("vapid")).length).toBe(32);
  expect((await native.read("highwater")).length).toBe(4);
  expect(await native.highwater()).toBe(1);
  expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);

  const identity = Buffer.from(await native.read("host_identity")).toString("base64");
  expect(Buffer.from(await new DevRemoteNative(dir).read("host_identity")).toString("base64")).toBe(identity);
});

test("advances the high-water mark forward only", async () => {
  const dir = root();
  const native = new DevRemoteNative(dir);
  await native.advanceHighwater(1, 2);
  expect(await native.highwater()).toBe(2);
  expect(await new DevRemoteNative(dir).highwater()).toBe(2);
  expect(native.advanceHighwater(1, 3)).rejects.toThrow("remote_native:rollback");
  expect(native.advanceHighwater(2, 2)).rejects.toThrow("remote_native:rollback");
});

test("a proof only counts for the action the prompt described", async () => {
  const native = new DevRemoteNative(root());
  const value = action();
  const { challenge, expiresIn } = await native.prepare(value);
  expect(expiresIn).toBe(120);
  expect(challenge).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(native.describe(challenge)).toBe(value.display);

  expect(native.consume(value, challenge, Buffer.alloc(32).toString("base64"))).rejects.toThrow("remote_native:proof");
  const second = await native.prepare(value);
  const proof = native.authenticate(second.challenge);
  expect(proof).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(native.consume({ ...value, display: "something else" }, second.challenge, proof)).rejects.toThrow("remote_native:proof");

  const third = await native.prepare(value);
  await native.consume(value, third.challenge, native.authenticate(third.challenge));
  // One prompt, one use.
  expect(native.consume(value, third.challenge, "x".repeat(43) + "=")).rejects.toThrow("remote_native:proof");
});

test("an unconfirmed prompt expires with the native window", async () => {
  let now = 1_000_000;
  const native = new DevRemoteNative(root(), () => now);
  const { challenge } = await native.prepare(action());
  now += 120_000;
  expect(native.describe(challenge)).toBeUndefined();
  expect(() => native.authenticate(challenge)).toThrow("remote_native:expired");
});

test("reset rotates the identity and burns an epoch", async () => {
  const dir = root();
  const native = new DevRemoteNative(dir);
  const before = Buffer.from(await native.read("host_identity")).toString("base64");
  const vapid = Buffer.from(await native.read("vapid")).toString("base64");
  const value = { kind: "reset_identity" as const, digest: "b".repeat(64), display: "Reset remote identity" };
  const { challenge } = await native.prepare(value);
  expect(native.reset({ ...value, kind: "pair_device" }, challenge, native.authenticate(challenge), 1)).rejects.toThrow("remote_native:malformed");
  expect(native.reset(value, challenge, native.authenticate(challenge), 7)).rejects.toThrow("remote_native:rollback");
  await native.reset(value, challenge, native.authenticate(challenge), 1);
  expect(Buffer.from(await native.read("host_identity")).toString("base64")).not.toBe(before);
  // Push subscriptions outlive an identity reset; the VAPID key must not move with it.
  expect(Buffer.from(await native.read("vapid")).toString("base64")).toBe(vapid);
  expect(await native.highwater()).toBe(2);
});

test("a long data directory gets a short socket path instead of a boot failure", () => {
  const deep = join("/tmp", "x".repeat(120));
  const path = devSocketPath(deep);
  expect(path.startsWith(tmpdir())).toBe(true);
  expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
  expect(devSocketPath(deep)).toBe(path);
  expect(devSocketPath("/tmp/short")).toBe("/tmp/short/dev-remote/setup.sock");
});

test("the dev provider is unavailable without the switch and inside a compiled daemon", () => {
  expect(devRemoteAllowed("/repo/src/remote/dev-setup.ts", {} as NodeJS.ProcessEnv)).toBe(false);
  expect(devRemoteAllowed("/$bunfs/root/dev-setup.ts", { REAL_BOT_DEV_REMOTE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  expect(devRemoteAllowed("/repo/src/remote/dev-setup.ts", { REAL_BOT_DEV_REMOTE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  expect(createDevRemote(root(), "/$bunfs/root/dev-setup.ts")).toBeUndefined();
});

test("the dev channel answers setup and confirmation operations over its socket", async () => {
  const dir = root();
  process.env.REAL_BOT_DEV_REMOTE = "1";
  const dev = createDevRemote(dir, "/repo/src/remote/dev-setup.ts")!;
  delete process.env.REAL_BOT_DEV_REMOTE;
  expect(dev).toBeDefined();
  const controller = { status: () => ({ state: "off", diagnostic: null, devices: 0 }) } as unknown as RemoteController;
  const close = dev.listen(controller);
  const { challenge } = await dev.native.prepare(action("Pixel (Android) · beef"));

  const socket = createConnection(devSocketPath(dir));
  await new Promise(resolve => socket.once("connect", resolve));
  const call = (request: unknown) => new Promise<{ ok: boolean; value?: unknown; error?: string }>(resolve => {
    const payload = Buffer.from(JSON.stringify(request)), prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    socket.once("data", (bytes: Buffer) => resolve(JSON.parse(bytes.subarray(4).toString("utf8"))));
    socket.write(Buffer.concat([prefix, payload]));
  });
  try {
    expect(await call({ operation: "status" })).toEqual({ ok: true, value: { state: "off", diagnostic: null, devices: 0 } });
    expect(await call({ operation: "dev_describe", challenge })).toEqual({ ok: true, value: { display: "Pixel (Android) · beef" } });
    const authenticated = await call({ operation: "dev_authenticate", challenge });
    expect((authenticated.value as { proof: string }).proof).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await call({ operation: "dev_describe", challenge: "nope" })).toEqual({ ok: false, error: "remote_setup_denied" });
    expect(await call({ operation: "not_an_operation" })).toEqual({ ok: false, error: "remote_setup_denied" });
  } finally {
    socket.destroy();
    close();
  }
  expect(() => statSync(devSocketPath(dir))).toThrow();
  expect(JSON.parse(readFileSync(join(dir, "dev-remote", "credentials.json"), "utf8")).v).toBe(1);
});

test("the pairing dispatch used by the settings panel refuses trust changes", async () => {
  const dir = root();
  const native = new DevRemoteNative(dir);
  const dispatch = devPairingDispatch(native);
  const controller = { status: () => ({ state: "off", diagnostic: null, devices: 0 }) } as unknown as RemoteController;

  expect(await dispatch(controller, { operation: "status" })).toEqual({ state: "off", diagnostic: null, devices: 0 });
  const { challenge } = await native.prepare(action("iPhone (iOS) · feed"));
  expect(await dispatch(controller, { operation: "dev_describe", challenge })).toEqual({ display: "iPhone (iOS) · feed" });

  // Changing the relay or resetting the identity stays on the unix socket.
  for (const operation of ["initialize", "prepare_change", "confirm_change", "prepare_recovery", "confirm_recovery"]) {
    expect(dispatch(controller, { operation })).rejects.toThrow();
  }
  expect(dispatch(controller, { operation: 7 })).rejects.toThrow();
  expect(dispatch(controller, "status" as unknown as object)).rejects.toThrow();
});
