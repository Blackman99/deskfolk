import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRemoteNative, isCompiledDaemon, shippedRemoteNative } from "./file-native";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rb-file-remote-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const action = (display = "iPhone (iOS) · abcd") => ({ kind: "pair_device" as const, digest: "a".repeat(64), display });

test("reads the material sizes the controller expects and keeps them across restarts", async () => {
  const dir = root();
  const native = new FileRemoteNative(dir);
  expect(await native.capability()).toEqual({ enabled: false, nativeAvailable: true, diagnostic: "file_credentials" });
  expect((await native.read("host_identity")).length).toBe(64);
  expect((await native.read("enrollment")).length).toBe(32);
  expect((await native.read("vapid")).length).toBe(32);
  expect((await native.read("highwater")).length).toBe(4);
  expect(await native.highwater()).toBe(1);
  expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);

  const identity = Buffer.from(await native.read("host_identity")).toString("base64");
  expect(Buffer.from(await new FileRemoteNative(dir).read("host_identity")).toString("base64")).toBe(identity);
});

test("advances the high-water mark forward only", async () => {
  const dir = root();
  const native = new FileRemoteNative(dir);
  await native.advanceHighwater(1, 2);
  expect(await native.highwater()).toBe(2);
  expect(await new FileRemoteNative(dir).highwater()).toBe(2);
  expect(native.advanceHighwater(1, 3)).rejects.toThrow("remote_native:rollback");
  expect(native.advanceHighwater(2, 2)).rejects.toThrow("remote_native:rollback");
});

test("a proof only counts for the action the prompt described", async () => {
  const native = new FileRemoteNative(root());
  const value = action();
  const { challenge, expiresIn } = await native.prepare(value);
  expect(expiresIn).toBe(120);
  expect(challenge).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(native.describe(challenge)).toEqual({ kind: "pair_device", display: value.display });

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
  const native = new FileRemoteNative(root(), () => now);
  const { challenge } = await native.prepare(action());
  now += 120_000;
  expect(native.describe(challenge)).toBeUndefined();
  expect(() => native.authenticate(challenge)).toThrow("remote_native:expired");
});

test("reset rotates the identity and burns an epoch", async () => {
  const dir = root();
  const native = new FileRemoteNative(dir);
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

test("nothing is written until remote is used, and a damaged file is never replaced", async () => {
  const dir = join(root(), "dev-remote");
  const native = new FileRemoteNative(dir);
  expect(await native.capability()).toEqual({ enabled: false, nativeAvailable: true, diagnostic: "file_credentials" });
  expect(existsSync(dir)).toBe(false);
  await native.highwater();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);

  // The only copy of the identity paired devices pinned: surface it, do not overwrite it.
  writeFileSync(join(dir, "credentials.json"), "{\"v\":1,\"dh\":\"short\"", { mode: 0o600 });
  const damaged = new FileRemoteNative(dir);
  expect(await damaged.capability()).toEqual({ enabled: false, nativeAvailable: false, diagnostic: "corrupt" });
  expect(damaged.read("host_identity")).rejects.toThrow("remote_native:corrupt");
  expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe("{\"v\":1,\"dh\":\"short\"");
});

test("an unreadable credentials file is a storage error, not a fresh identity", async () => {
  if (process.getuid?.() === 0) return;
  const dir = join(root(), "dev-remote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), "{}", { mode: 0o000 });
  const native = new FileRemoteNative(dir);
  expect(await native.capability()).toEqual({ enabled: false, nativeAvailable: false, diagnostic: "storage" });
  chmodSync(join(dir, "credentials.json"), 0o600);
});

test("only a compiled daemon ships with the file store", () => {
  expect(isCompiledDaemon("/$bunfs/root/real-bot-daemon")).toBe(true);
  expect(isCompiledDaemon("/repo/apps/daemon/src/remote/file-native.ts")).toBe(false);
  expect(shippedRemoteNative(root(), "/repo/apps/daemon/src/remote/file-native.ts")).toBeUndefined();
  expect(shippedRemoteNative(root(), "/$bunfs/root/real-bot-daemon")).toBeInstanceOf(FileRemoteNative);
});
