import { afterEach, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRemoteNative } from "./file-native";
import { createDevRemote, devPairingDispatch, devRemoteAllowed, devSocketPath } from "./dev-setup";
import type { RemoteController } from "./controller";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rb-dev-remote-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const action = (display = "iPhone (iOS) · abcd") => ({ kind: "pair_device" as const, digest: "a".repeat(64), display });

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

test("the dev provider is also unavailable inside a compiled win32 daemon (B:\\~BUN\\)", () => {
  // This is the security-relevant case: a win32 compiled daemon must never take the dev-remote
  // path just because its own module path does not start with the POSIX /$bunfs/ prefix.
  expect(devRemoteAllowed("B:\\~BUN\\root\\dev-setup.ts", { REAL_BOT_DEV_REMOTE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  expect(devRemoteAllowed("B:/~BUN/root/dev-setup.ts", { REAL_BOT_DEV_REMOTE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  expect(createDevRemote(root(), "B:\\~BUN\\root\\dev-setup.ts")).toBeUndefined();
});

test("devSocketPath on win32 is a named pipe, not a filesystem path under the data dir", () => {
  const path = devSocketPath("/tmp/whatever", "win32", "dongsheng");
  expect(path).toBe("\\\\.\\pipe\\real-bot-dev-remote-dongsheng");
});

test("devSocketPath on win32 sanitizes an unusual username", () => {
  const path = devSocketPath("/tmp/whatever", "win32", "dong sheng/../weird");
  expect(path).toBe("\\\\.\\pipe\\real-bot-dev-remote-dong_sheng_.._weird");
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
  // A confirmation alone reads no key, so no identity was written for it.
  expect(existsSync(join(dir, "dev-remote", "credentials.json"))).toBe(false);
  await dev.native.highwater();
  expect(JSON.parse(readFileSync(join(dir, "dev-remote", "credentials.json"), "utf8")).v).toBe(1);
});

test("the pairing dispatch used by the settings panel refuses trust changes but registers with a relay", async () => {
  const dir = root();
  const native = new FileRemoteNative(dir);
  const dispatch = devPairingDispatch(native);
  const controller = { status: () => ({ state: "off", diagnostic: null, devices: 0 }) } as unknown as RemoteController;

  expect(await dispatch(controller, { operation: "status" })).toEqual({ state: "off", diagnostic: null, devices: 0 });
  const { challenge } = await native.prepare(action("iPhone (iOS) · feed"));
  expect(await dispatch(controller, { operation: "dev_describe", challenge })).toEqual({ display: "iPhone (iOS) · feed" });

  // Changing the relay or resetting the identity stays on the unix socket.
  for (const operation of ["prepare_change", "confirm_change", "prepare_recovery", "confirm_recovery"]) {
    expect(dispatch(controller, { operation })).rejects.toThrow();
  }
  // The connect form's first registration goes through; the controller validates the config.
  const initialize = { operation: "initialize", config: { origin: "https://relay.example", relayId: "r", hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } };
  let initialized: unknown;
  const registering = { status: () => ({ state: "off", diagnostic: null, devices: 0 }), initialize: async (config: unknown) => { initialized = config; } } as unknown as RemoteController;
  await dispatch(registering, initialize);
  expect(initialized).toEqual(initialize.config);
  expect(dispatch(controller, { operation: 7 })).rejects.toThrow();
  expect(dispatch(controller, "status" as unknown as object)).rejects.toThrow();
});
